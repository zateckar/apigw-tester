// Package worker orchestrates the scheduler, executor, baseline probes and
// result flushing, owning every long-lived goroutine in the process.
package worker

import "sync/atomic"

// Counters are the run's atomic tallies, mirrored 1:1 onto the status
// message. All updates are atomic so the status emitter reads a consistent
// snapshot without locking the hot path.
type Counters struct {
	Sent                     atomic.Int64
	OK                       atomic.Int64
	R4xx                     atomic.Int64
	Errors                   atomic.Int64
	GwFaults                 atomic.Int64
	RateLimited              atomic.Int64
	Unauthorized             atomic.Int64
	Timeouts                 atomic.Int64
	InvalidSent              atomic.Int64
	InvalidLeaked            atomic.Int64
	InvalidRejectedByGateway atomic.Int64
	InFlight                 atomic.Int64
	// Dropped counts load the concurrency ceiling stopped us from issuing —
	// requests the gateway was never offered.
	Dropped atomic.Int64
	// ResultsLost counts requests that WERE issued and answered but whose
	// measurement never reached the control plane. Kept apart from Dropped
	// because the two demand opposite conclusions: shed load means the
	// gateway saw less than the charts imply, lost results mean the charts
	// describe a biased subset of what the gateway actually served.
	ResultsLost atomic.Int64
}

// Reset zeroes every counter for a fresh run.
func (c *Counters) Reset() {
	c.Sent.Store(0)
	c.OK.Store(0)
	c.R4xx.Store(0)
	c.Errors.Store(0)
	c.GwFaults.Store(0)
	c.RateLimited.Store(0)
	c.Unauthorized.Store(0)
	c.Timeouts.Store(0)
	c.InvalidSent.Store(0)
	c.InvalidLeaked.Store(0)
	c.InvalidRejectedByGateway.Store(0)
	c.InFlight.Store(0)
	c.Dropped.Store(0)
	c.ResultsLost.Store(0)
}
