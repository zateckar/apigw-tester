package sut

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestSeedPopulationIsDeterministic(t *testing.T) {
	// The driver builds contract-valid requests against ids 1..seedCount without
	// asking what is there, so the seed set has to be identical on every boot —
	// and identical to the TS petstore's, or a run that spans a backend swap
	// compares two different catalogues.
	a := NewPetStore(120, LimitPetStoreSize)
	b := NewPetStore(120, LimitPetStoreSize)
	for _, id := range []int64{1, 2, 7, 60, 119, 120} {
		pa, ok := a.Get(id)
		if !ok {
			t.Fatalf("seed pet %d missing", id)
		}
		pb, _ := b.Get(id)
		ja, _ := json.Marshal(pa)
		jb, _ := json.Marshal(pb)
		if string(ja) != string(jb) {
			t.Fatalf("pet %d differs between boots:\n%s\n%s", id, ja, jb)
		}
	}
	if got := a.Count(); got != 120 {
		t.Fatalf("seed count: %d", got)
	}
	if _, ok := a.Get(121); ok {
		t.Fatal("seeded past the requested count")
	}
}

func TestSeedPetSerializesWithTheDocumentedShape(t *testing.T) {
	s := NewPetStore(120, LimitPetStoreSize)
	p, _ := s.Get(1)
	b, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	got := string(b)
	// key order is part of the shape: a validating gateway may be caching on
	// the exact bytes, and the TS petstore emitted this order
	for i, key := range []string{`"id"`, `"name"`, `"status"`, `"category"`, `"tags"`, `"photoUrls"`, `"description"`} {
		if !strings.Contains(got, key) {
			t.Fatalf("missing %s in %s", key, got)
		}
		if i > 0 {
			prev := []string{`"id"`, `"name"`, `"status"`, `"category"`, `"tags"`, `"photoUrls"`, `"description"`}[i-1]
			if strings.Index(got, prev) > strings.Index(got, key) {
				t.Fatalf("%s must precede %s: %s", prev, key, got)
			}
		}
	}
	if p.Name != "Buddy the Dog" {
		t.Fatalf("pet 1 name: %q", p.Name)
	}
}

func TestEmptyCollectionsSerializeAsArraysNotNull(t *testing.T) {
	// encoding/json writes null for a nil slice; a gateway validating against
	// the published schema rejects that where JSON.stringify would have sent []
	s := NewPetStore(1, 10)
	p := s.Create(NewPetInput{Name: "Bare"})
	b, _ := json.Marshal(p)
	if !strings.Contains(string(b), `"tags":[]`) || !strings.Contains(string(b), `"photoUrls":[]`) {
		t.Fatalf("nil slices leaked as null: %s", b)
	}
	if !strings.Contains(string(b), `"category":{"id":0,"name":"Misc"}`) {
		t.Fatalf("category default: %s", b)
	}
	if strings.Contains(string(b), `"description"`) {
		t.Fatalf("absent description must be omitted: %s", b)
	}
}

func TestListPagesInInsertionOrder(t *testing.T) {
	s := NewPetStore(120, LimitPetStoreSize)
	first, total := s.List("", 0, 20)
	if total != 120 || len(first) != 20 {
		t.Fatalf("page 0: %d items of %d", len(first), total)
	}
	if first[0].ID != 1 || first[19].ID != 20 {
		t.Fatalf("not insertion-ordered: %d..%d", first[0].ID, first[19].ID)
	}
	second, _ := s.List("", 1, 20)
	if second[0].ID != 21 {
		t.Fatalf("page 1 starts at %d", second[0].ID)
	}
	// past the end is an empty page, not an error and not a wrap-around
	beyond, _ := s.List("", 99, 20)
	if len(beyond) != 0 {
		t.Fatalf("page 99 returned %d items", len(beyond))
	}
}

func TestListFiltersByStatusAndCountsOnlyThatStatus(t *testing.T) {
	s := NewPetStore(120, LimitPetStoreSize)
	sum := 0
	for _, st := range PetStatuses {
		items, total := s.List(st, 0, 100)
		sum += total
		for _, p := range items {
			if p.Status != st {
				t.Fatalf("status filter %q returned %q", st, p.Status)
			}
		}
	}
	if sum != 120 {
		t.Fatalf("per-status totals sum to %d, not the population", sum)
	}
	if items, total := s.List("nonexistent", 0, 20); total != 0 || len(items) != 0 {
		t.Fatalf("unknown status: %d/%d", len(items), total)
	}
}

func TestUpdateMovesThePetBetweenStatusIndexes(t *testing.T) {
	s := NewPetStore(120, LimitPetStoreSize)
	p, _ := s.Get(1)
	from := p.Status
	to := "sold"
	if from == to {
		to = "pending"
	}
	_, beforeFrom := s.List(from, 0, 100)
	_, beforeTo := s.List(to, 0, 100)

	if _, ok := s.Update(1, UpdatePetInput{Status: &to}); !ok {
		t.Fatal("update reported the pet missing")
	}
	_, afterFrom := s.List(from, 0, 100)
	_, afterTo := s.List(to, 0, 100)
	if afterFrom != beforeFrom-1 || afterTo != beforeTo+1 {
		t.Fatalf("index not moved: %s %d->%d, %s %d->%d", from, beforeFrom, afterFrom, to, beforeTo, afterTo)
	}
	if got, _ := s.Get(1); got.Status != to {
		t.Fatalf("status not applied: %q", got.Status)
	}
}

func TestUpdateIsVisibleImmediately(t *testing.T) {
	// The TS petstore cached each seed pet's serialized body forever and never
	// invalidated it on update, so a GET after a PUT returned the old body. The
	// bodies here are marshalled per request precisely so that cannot happen.
	s := NewPetStore(120, LimitPetStoreSize)
	name := "Renamed"
	if _, ok := s.Update(3, UpdatePetInput{Name: &name}); !ok {
		t.Fatal("update failed")
	}
	got, _ := s.Get(3)
	if got.Name != name {
		t.Fatalf("read-after-write returned %q", got.Name)
	}
}

func TestGeneratedPetsAreEvictedFIFOAndSeedsSurvive(t *testing.T) {
	s := NewPetStore(5, 8)
	var made []int64
	for i := 0; i < 10; i++ {
		made = append(made, s.Create(NewPetInput{Name: "Gen"}).ID)
	}
	if got := s.Count(); got > 8 {
		t.Fatalf("capacity exceeded: %d", got)
	}
	for id := int64(1); id <= 5; id++ {
		if _, ok := s.Get(id); !ok {
			t.Fatalf("seed pet %d was evicted", id)
		}
	}
	// the oldest generated pet must be the one that went
	if _, ok := s.Get(made[0]); ok {
		t.Fatalf("eviction was not FIFO: %d survived", made[0])
	}
	if _, ok := s.Get(made[len(made)-1]); !ok {
		t.Fatal("the newest pet was evicted")
	}
}

func TestDeleteRemovesFromEveryIndex(t *testing.T) {
	s := NewPetStore(120, LimitPetStoreSize)
	p, _ := s.Get(2)
	_, beforeStatus := s.List(p.Status, 0, 100)

	if !s.Delete(2) {
		t.Fatal("delete reported nothing removed")
	}
	if s.Delete(2) {
		t.Fatal("second delete reported a removal")
	}
	if _, ok := s.Get(2); ok {
		t.Fatal("pet still readable after delete")
	}
	if _, total := s.List("", 0, 100); total != 119 {
		t.Fatalf("total after delete: %d", total)
	}
	if _, afterStatus := s.List(p.Status, 0, 100); afterStatus != beforeStatus-1 {
		t.Fatalf("status index still counts it: %d", afterStatus)
	}
}

func TestListStaysCorrectAcrossManyDeletes(t *testing.T) {
	// deletions tombstone their slot and the slice is compacted later; paging
	// must never see a hole or count one
	s := NewPetStore(120, LimitPetStoreSize)
	for id := int64(1); id <= 100; id += 2 {
		s.Delete(id)
	}
	items, total := s.List("", 0, 100)
	if total != 70 {
		t.Fatalf("total: %d", total)
	}
	if len(items) != 70 {
		t.Fatalf("page: %d", len(items))
	}
	seen := map[int64]bool{}
	for i, p := range items {
		if p.ID == 0 || seen[p.ID] {
			t.Fatalf("hole or duplicate at %d: %+v", i, p)
		}
		seen[p.ID] = true
		if i > 0 && items[i-1].ID > p.ID {
			t.Fatal("ordering broke after compaction")
		}
	}
}

func TestOrdersAreBoundedFIFO(t *testing.T) {
	s := NewPetStore(2, 3)
	var ids []int64
	for i := 0; i < 8; i++ {
		ids = append(ids, s.PlaceOrder(1, 1).ID)
	}
	if got := s.OrderCount(); got > 3 {
		t.Fatalf("order capacity exceeded: %d", got)
	}
	if _, ok := s.GetOrder(ids[0]); ok {
		t.Fatal("oldest order survived eviction")
	}
	last, ok := s.GetOrder(ids[len(ids)-1])
	if !ok {
		t.Fatal("newest order evicted")
	}
	if last.Status != "placed" || last.Complete || last.Quantity != 1 {
		t.Fatalf("order shape: %+v", last)
	}
	if !strings.HasSuffix(last.ShipDate, "Z") || len(last.ShipDate) != len("2006-01-02T15:04:05.000Z") {
		t.Fatalf("shipDate is not an ISO instant: %q", last.ShipDate)
	}
}

func TestConcurrentReadersAndWritersDoNotRace(t *testing.T) {
	// unlike the single-loop original, this store is touched by one goroutine
	// per in-flight request; run with -race
	s := NewPetStore(50, 200)
	done := make(chan struct{})
	for i := 0; i < 4; i++ {
		go func() {
			defer func() { done <- struct{}{} }()
			for n := 0; n < 200; n++ {
				s.Create(NewPetInput{Name: "Racer"})
				s.List("available", 0, 20)
				s.Get(7)
				status := "sold"
				s.Update(7, UpdatePetInput{Status: &status})
				s.PlaceOrder(1, 2)
			}
		}()
	}
	for i := 0; i < 4; i++ {
		<-done
	}
}
