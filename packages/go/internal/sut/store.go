// Package sut is the system under test: an in-memory Petstore speaking REST and
// SOAP, run as its own OS process.
//
// It used to live inside the Bun control plane, sharing that process's single
// event loop with metrics ingest, the dashboard API and the run scheduler. That
// made the SUT's own scheduling delay part of every measurement: at 5k rps the
// loop's max delay ran past the 10ms validity limit often enough to disqualify
// more than half the health windows, and the rig was reduced to reporting that
// it could not vouch for its own numbers.
//
// Splitting it out is not a micro-optimisation. The quantity this tool exists to
// measure is time attributable to the gateway, and anything sharing a runtime
// with the backend is a term in that measurement whether it is acknowledged or
// not. A separate process with a work-stealing scheduler and no shared loop is
// the only arrangement where "the backend was busy" and "the control plane was
// busy" are actually different sentences.
package sut

import (
	"strings"
	"sync"
	"time"
)

// Limits mirror LIMITS in packages/shared/src/index.ts. Operator-supplied knobs
// are clamped to these so a bad value can never wedge the process.
const (
	LimitDelayMs      = 30_000
	LimitPadBytes     = 10 * 1024 * 1024
	LimitBigBytes     = 10 * 1024 * 1024
	LimitSlowMs       = 10_000
	LimitPetStoreSize = 5_000
)

// PetStatuses mirrors PET_STATUSES. Order matters: it is reproduced in error
// messages ("status must be one of available|pending|sold") that the contract
// tests compare against.
var PetStatuses = [...]string{"available", "pending", "sold"}

func IsPetStatus(s string) bool {
	for _, v := range PetStatuses {
		if v == s {
			return true
		}
	}
	return false
}

func statusList() string { return strings.Join(PetStatuses[:], "|") }

// IDName is the {id,name} pair used for a pet's category and tags.
type IDName struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

// Pet field order is the declaration order below, and encoding/json preserves
// it. That is deliberate: the TS petstore emitted these keys in the same order,
// and a gateway under test may be doing response validation or caching keyed on
// the exact bytes.
type Pet struct {
	ID          int64    `json:"id"`
	Name        string   `json:"name"`
	Status      string   `json:"status"`
	Category    IDName   `json:"category"`
	Tags        []IDName `json:"tags"`
	PhotoURLs   []string `json:"photoUrls"`
	Description string   `json:"description,omitempty"`
}

type Order struct {
	ID       int64  `json:"id"`
	PetID    int64  `json:"petId"`
	Quantity int    `json:"quantity"`
	ShipDate string `json:"shipDate"`
	Status   string `json:"status"`
	Complete bool   `json:"complete"`
}

var (
	species = [...]string{"Dog", "Cat", "Bird", "Fish", "Rabbit", "Lizard", "Hamster", "Turtle"}
	names   = [...]string{
		"Buddy", "Max", "Bella", "Charlie", "Luna", "Rocky", "Milo", "Daisy",
		"Toby", "Lola", "Coco", "Jack", "Ruby", "Duke", "Sadie", "Zeus",
		"Molly", "Bear", "Chloe", "Tucker", "Penny", "Leo", "Sophie", "Oliver",
		"Nala", "Simba", "Lily", "Oscar", "Ginger", "Felix", "Pepper", "Shadow",
	}
	tags = [...]string{"friendly", "trained", "young", "rescue", "senior", "energetic", "calm", "fluffy"}
	// three "available" entries: the seed population is deliberately skewed the
	// way a real catalogue is, so findPetsByStatus returns a useful page
	seedStatuses = [...]string{"available", "available", "available", "pending", "sold"}
)

// Lorem is the filler corpus, shared with the response padder.
const Lorem = "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor " +
	"incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud " +
	"exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute " +
	"irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla " +
	"pariatur excepteur sint occaecat cupidatat non proident sunt in culpa qui officia " +
	"deserunt mollit anim id est laborum"

// idList is an insertion-ordered set of pet ids.
//
// JS Map and Set iterate in insertion order and delete in O(1); Go maps do
// neither, and list() pages by position, so the order has to be kept explicitly.
// Deletion tombstones the slot rather than shifting the tail — a delete is 5% of
// generated traffic and an O(n) memmove per delete at 5k capacity is real work —
// and the slice is compacted once the tombstones outnumber the live entries.
type idList struct {
	order []int64
	pos   map[int64]int
	dead  int
}

func newIDList() *idList { return &idList{pos: make(map[int64]int)} }

func (l *idList) add(id int64) {
	if _, dup := l.pos[id]; dup {
		return
	}
	l.pos[id] = len(l.order)
	l.order = append(l.order, id)
}

func (l *idList) remove(id int64) {
	i, ok := l.pos[id]
	if !ok {
		return
	}
	l.order[i] = 0
	delete(l.pos, id)
	l.dead++
	if l.dead > len(l.order)/2 {
		l.compact()
	}
}

func (l *idList) compact() {
	kept := l.order[:0]
	for _, id := range l.order {
		if id != 0 {
			l.pos[id] = len(kept)
			kept = append(kept, id)
		}
	}
	l.order = kept
	l.dead = 0
}

func (l *idList) len() int { return len(l.pos) }

// slice returns up to size live ids starting at the start'th live entry.
func (l *idList) slice(start, size int) []int64 {
	out := make([]int64, 0, size)
	seen := 0
	for _, id := range l.order {
		if id == 0 {
			continue
		}
		if seen >= start+size {
			break
		}
		if seen >= start {
			out = append(out, id)
		}
		seen++
	}
	return out
}

// PetStore is the bounded in-memory catalogue.
//
// Bounded on purpose: the driver creates pets continuously and an always-on rig
// would otherwise grow without limit, and — worse — a store that got slower as
// it grew would silently inflate the gateway-overhead number this tool exists to
// measure. Generated pets are evicted FIFO past capacity; seeded pets never are,
// which is what lets the response caches key on id <= seedCount.
//
// Every method is safe for concurrent use: unlike the single-threaded original,
// this store is read by as many goroutines as there are in-flight requests.
type PetStore struct {
	mu        sync.RWMutex
	pets      map[int64]Pet
	all       *idList
	byStatus  map[string]*idList
	generated []int64
	nextPetID int64
	nextOrder int64
	seedCount int64
	capacity  int
	orders    map[int64]Order
	orderFIFO []int64
	maxOrders int
}

func NewPetStore(seedCount int64, capacity int) *PetStore {
	if capacity < int(seedCount)+1 {
		capacity = int(seedCount) + 1
	}
	s := &PetStore{
		pets:      make(map[int64]Pet, capacity),
		all:       newIDList(),
		byStatus:  make(map[string]*idList, len(PetStatuses)),
		nextPetID: seedCount + 1,
		nextOrder: 1,
		seedCount: seedCount,
		capacity:  capacity,
		orders:    make(map[int64]Order),
		maxOrders: capacity,
	}
	for _, st := range PetStatuses {
		s.byStatus[st] = newIDList()
	}
	for i := int64(0); i < seedCount; i++ {
		id := i + 1
		descLen := 30 + int((i*37)%300)
		if descLen > len(Lorem) {
			descLen = len(Lorem)
		}
		s.insert(Pet{
			ID:        id,
			Name:      pick(names[:], i*7) + " the " + pick(species[:], i*3),
			Status:    pick(seedStatuses[:], i*11),
			Category:  IDName{ID: i%int64(len(species)) + 1, Name: pick(species[:], i*3)},
			Tags:      []IDName{{ID: 1, Name: pick(tags[:], i*5)}, {ID: 2, Name: pick(tags[:], i*5+3)}},
			PhotoURLs: []string{"https://cdn.example.test/pets/" + itoa(id) + ".jpg"},
			// slice, not substring: JS String.slice clamps past the end
			Description: Lorem[:descLen],
		})
	}
	return s
}

func pick(arr []string, i int64) string { return arr[i%int64(len(arr))] }

func (s *PetStore) insert(p Pet) {
	s.pets[p.ID] = p
	s.all.add(p.ID)
	if l := s.byStatus[p.Status]; l != nil {
		l.add(p.ID)
	}
}

func (s *PetStore) removeLocked(id int64) bool {
	p, ok := s.pets[id]
	if !ok {
		return false
	}
	if l := s.byStatus[p.Status]; l != nil {
		l.remove(id)
	}
	s.all.remove(id)
	delete(s.pets, id)
	return true
}

// SeedPetCount is the number of boot-seeded pets. They occupy ids 1..n and are
// never evicted, which is what the response-serialization caches rely on.
func (s *PetStore) SeedPetCount() int64 { return s.seedCount }

func (s *PetStore) Count() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.pets)
}

func (s *PetStore) OrderCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.orders)
}

// List returns one page plus the total matching the filter. An empty status
// means "every pet".
func (s *PetStore) List(status string, page, size int) ([]Pet, int) {
	if size = trunc(size, 20); size < 1 {
		size = 1
	} else if size > 100 {
		size = 100
	}
	if page < 0 {
		page = 0
	}
	s.mu.RLock()
	defer s.mu.RUnlock()

	src := s.all
	if status != "" {
		src = s.byStatus[status]
		if src == nil {
			return []Pet{}, 0
		}
	}
	total := src.len()
	start := page * size
	items := make([]Pet, 0, size)
	if start < total {
		for _, id := range src.slice(start, size) {
			if p, ok := s.pets[id]; ok {
				items = append(items, p)
			}
		}
	}
	return items, total
}

func trunc(v, fallback int) int {
	if v == 0 {
		return fallback
	}
	return v
}

func (s *PetStore) Get(id int64) (Pet, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.pets[id]
	return p, ok
}

// Create takes an already-validated input (see ValidateNewPet).
func (s *PetStore) Create(in NewPetInput) Pet {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := Pet{
		ID:        s.nextPetID,
		Name:      in.Name,
		Status:    orDefault(in.Status, "available"),
		Category:  orCategory(in.Category),
		Tags:      orTags(in.Tags),
		PhotoURLs: orURLs(in.PhotoURLs),
	}
	if in.Description != nil {
		p.Description = *in.Description
	}
	s.nextPetID++
	s.insert(p)
	s.generated = append(s.generated, p.ID)
	for len(s.pets) > s.capacity && len(s.generated) > 0 {
		victim := s.generated[0]
		s.generated = s.generated[1:]
		s.removeLocked(victim)
	}
	return p
}

func orDefault(v *string, def string) string {
	if v == nil {
		return def
	}
	return *v
}

func orCategory(v *IDName) IDName {
	if v == nil {
		return IDName{ID: 0, Name: "Misc"}
	}
	return *v
}

// Empty slices, never nil: JSON.stringify emits [] for an empty array and
// encoding/json emits null for a nil slice. A gateway validating the response
// against the published schema would reject null.
func orTags(v []IDName) []IDName {
	if v == nil {
		return []IDName{}
	}
	return v
}

func orURLs(v []string) []string {
	if v == nil {
		return []string{}
	}
	return v
}

// Update takes an already-validated input (see ValidateUpdatePet).
func (s *PetStore) Update(id int64, in UpdatePetInput) (Pet, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	existing, ok := s.pets[id]
	if !ok {
		return Pet{}, false
	}
	merged := existing
	if in.Name != nil {
		merged.Name = *in.Name
	}
	if in.Description != nil {
		merged.Description = *in.Description
	}
	if in.Status != nil && *in.Status != existing.Status {
		merged.Status = *in.Status
		if l := s.byStatus[existing.Status]; l != nil {
			l.remove(id)
		}
		if l := s.byStatus[merged.Status]; l != nil {
			l.add(id)
		}
	}
	s.pets[id] = merged
	return merged, true
}

func (s *PetStore) Delete(id int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.removeLocked(id) {
		return false
	}
	for i, g := range s.generated {
		if g == id {
			s.generated = append(s.generated[:i], s.generated[i+1:]...)
			break
		}
	}
	return true
}

func (s *PetStore) PlaceOrder(petID int64, quantity int) Order {
	s.mu.Lock()
	defer s.mu.Unlock()
	o := Order{
		ID:       s.nextOrder,
		PetID:    petID,
		Quantity: quantity,
		ShipDate: time.Now().Add(24 * time.Hour).UTC().Format("2006-01-02T15:04:05.000Z"),
		Status:   "placed",
		Complete: false,
	}
	s.nextOrder++
	s.orders[o.ID] = o
	s.orderFIFO = append(s.orderFIFO, o.ID)
	for len(s.orders) > s.maxOrders && len(s.orderFIFO) > 0 {
		oldest := s.orderFIFO[0]
		s.orderFIFO = s.orderFIFO[1:]
		delete(s.orders, oldest)
	}
	return o
}

func (s *PetStore) GetOrder(id int64) (Order, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	o, ok := s.orders[id]
	return o, ok
}

func itoa(v int64) string {
	if v == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	neg := v < 0
	if neg {
		v = -v
	}
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
