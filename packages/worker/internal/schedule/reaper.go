package schedule

import (
	"container/heap"
	"context"
	"sync"
	"time"
)

// Reaper applies per-request deadlines from a single goroutine. Requests
// register a (deadline, cancel) pair and — on the hot path — unregister in
// O(log n) when they finish; the reaper wakes at the earliest deadline and
// cancels whatever expired. This replaces one time.AfterFunc timer per
// request, which costs the Go runtime a heap push+pop per request anyway but
// keeps all timer bookkeeping off the request path's allocation profile.
//
// Owner: the worker creates one Reaper per process and stops it on shutdown.
type Reaper struct {
	mu   sync.Mutex
	h    entryHeap
	wake chan struct{}
	done chan struct{}
	once sync.Once
}

type entry struct {
	deadline time.Time
	cancel   context.CancelFunc
	index    int
}

type entryHeap []*entry

func (h entryHeap) Len() int           { return len(h) }
func (h entryHeap) Less(i, j int) bool { return h[i].deadline.Before(h[j].deadline) }
func (h entryHeap) Swap(i, j int) {
	h[i], h[j] = h[j], h[i]
	h[i].index = i
	h[j].index = j
}
func (h *entryHeap) Push(x any) {
	e := x.(*entry)
	e.index = len(*h)
	*h = append(*h, e)
}
func (h *entryHeap) Pop() any {
	old := *h
	n := len(old)
	e := old[n-1]
	old[n-1] = nil
	*h = old[:n-1]
	return e
}

// NewReaper starts the reaper goroutine. The goroutine exits when Stop is
// called; there is no other exit path.
func NewReaper() *Reaper {
	r := &Reaper{wake: make(chan struct{}, 1), done: make(chan struct{})}
	heap.Init(&r.h)
	go r.loop()
	return r
}

// Handle unregisters a deadline. The request path calls Done on it; the
// reaper cancels exactly once.
type Handle struct {
	r *Reaper
	e *entry
}

// After registers cancel to fire at deadline (fired by the reaper goroutine).
func (r *Reaper) After(deadline time.Time, cancel context.CancelFunc) *Handle {
	e := &entry{deadline: deadline, cancel: cancel}
	r.mu.Lock()
	heap.Push(&r.h, e)
	r.mu.Unlock()
	select {
	case r.wake <- struct{}{}:
	default:
	}
	return &Handle{r: r, e: e}
}

// Done removes the registration. Returns without effect if the timer already
// fired or was already removed; the caller must then call the cancel func
// itself to release resources.
func (h *Handle) Done() {
	r := h.r
	r.mu.Lock()
	if h.e.index >= 0 && h.e.index < r.h.Len() && r.h[h.e.index] == h.e {
		heap.Remove(&r.h, h.e.index)
	}
	h.e.index = -1
	r.mu.Unlock()
}

// Stop terminates the reaper goroutine. Outstanding deadlines are cancelled
// on the caller so contexts do not leak.
func (r *Reaper) Stop() {
	r.once.Do(func() {
		close(r.done)
		r.mu.Lock()
		for _, e := range r.h {
			e.cancel()
		}
		r.h = nil
		r.mu.Unlock()
	})
}

// loop is owned by the Reaper; exits on Stop.
func (r *Reaper) loop() {
	for {
		r.mu.Lock()
		empty := r.h.Len() == 0
		var wait time.Duration
		if !empty {
			wait = time.Until(r.h[0].deadline)
		}
		r.mu.Unlock()

		if empty {
			select {
			case <-r.wake:
				continue
			case <-r.done:
				return
			}
		}
		if wait <= 0 {
			r.fireExpired()
			continue
		}
		t := time.NewTimer(wait)
		select {
		case <-t.C:
		case <-r.wake:
			if !t.Stop() {
				<-t.C
			}
		case <-r.done:
			if !t.Stop() {
				<-t.C
			}
			return
		}
	}
}

func (r *Reaper) fireExpired() {
	now := time.Now()
	r.mu.Lock()
	for r.h.Len() > 0 && !r.h[0].deadline.After(now) {
		e := heap.Pop(&r.h).(*entry)
		e.index = -1
		// Cancel outside the lock: a request finishing concurrently takes mu
		// in Done() and cancel leads back into the request path.
		r.mu.Unlock()
		e.cancel()
		r.mu.Lock()
	}
	r.mu.Unlock()
}
