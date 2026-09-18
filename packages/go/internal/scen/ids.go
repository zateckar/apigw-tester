package scen

import (
	"math/rand/v2"
	"sync"
)

// MaxTrackedIDs bounds the ring of created pet ids kept for deletePet.
const MaxTrackedIDs = 2_000

// IDTracker tracks pet ids this run created, so deletePet removes real pets.
// Swap-with-last-pick removal, and a fallback to a high id (which will 404)
// when nothing has been created yet.
type IDTracker struct {
	mu        sync.Mutex
	created   []int
	seedIdMax int
}

// NewIDTracker creates a tracker; seedIdMax is the highest id seeded in the
// SUT (120 in the TS rig).
func NewIDTracker(seedIdMax int) *IDTracker {
	return &IDTracker{seedIdMax: seedIdMax}
}

// Track records a created pet id.
func (t *IDTracker) Track(id int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.created = append(t.created, id)
	if len(t.created) > MaxTrackedIDs {
		copy(t.created, t.created[len(t.created)-MaxTrackedIDs:])
		t.created = t.created[:MaxTrackedIDs]
	}
}

// ExistingPetID returns a random id guaranteed to exist in the SUT.
func (t *IDTracker) ExistingPetID() int {
	return 1 + rand.IntN(max(1, t.seedIdMax))
}

// DeletablePetID prefers a pet this run created; falls back to a high id
// that will 404.
func (t *IDTracker) DeletablePetID() int {
	t.mu.Lock()
	if len(t.created) > 0 {
		idx := rand.IntN(len(t.created))
		id := t.created[idx]
		t.created[idx] = t.created[len(t.created)-1]
		t.created = t.created[:len(t.created)-1]
		t.mu.Unlock()
		return id
	}
	t.mu.Unlock()
	return t.seedIdMax + 1 + rand.IntN(10_000)
}
