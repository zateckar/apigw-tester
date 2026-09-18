package wire

import (
	"bufio"
	"encoding/json"
	"io"
	"sync"
)

// StatusMsg is the {"op":"status"} snapshot. Field names match GoStatusMsg in
// packages/app/src/loadgen/goClient.ts exactly; that interface is how the
// control plane reads this, and it does no renaming.
type StatusMsg struct {
	RunID                    string  `json:"runId"`
	Sent                     int64   `json:"sent"`
	OK                       int64   `json:"ok"`
	R4xx                     int64   `json:"r4xx"`
	Errors                   int64   `json:"errors"`
	GwFaults                 int64   `json:"gwFaults"`
	RateLimited              int64   `json:"rateLimited"`
	Unauthorized             int64   `json:"unauthorized"`
	InvalidSent              int64   `json:"invalidSent"`
	InvalidLeaked            int64   `json:"invalidLeaked"`
	InvalidRejectedByGateway int64   `json:"invalidRejectedByGateway"`
	InFlight                 int64   `json:"inFlight"`
	TargetRps                float64 `json:"targetRps"`
	// Dropped is load never issued (concurrency ceiling); ResultsLost is
	// measurements discarded after the request was served. Never merge them.
	Dropped     int64 `json:"dropped"`
	ResultsLost int64 `json:"resultsLost"`
	// EffectiveMaxConcurrency is the ceiling this run actually applies: the
	// operator's number clamped by LimitMaxConcurrency. Reported because the
	// control plane cannot derive it — it used to display its own default here
	// on every worker-driven run, so a configured 500 read as 25.
	EffectiveMaxConcurrency int `json:"effectiveMaxConcurrency"`
	// ThrottledSinceMs is when the ceiling started continuously refusing load,
	// or 0 while healthy. A duration rather than an instantaneous flag: one
	// full semaphore is normal at any rate, a sustained one is the ceiling
	// binding and the reason the target is not being met.
	ThrottledSinceMs int64 `json:"throttledSinceMs"`
}

type statusEnvelope struct {
	Op string `json:"op"`
	StatusMsg
}

type runMsg struct {
	Op    string `json:"op"`
	RunID string `json:"runId"`
}

// Emitter serialises outbound control messages onto stdout with a buffered
// writer. Emission never blocks the caller for longer than encoding: writes
// go through a single mutex and flushes are cheap at these message rates
// (status at 10s cadence, plus lifecycle events).
type Emitter struct {
	mu  sync.Mutex
	w   *bufio.Writer
	enc *json.Encoder
}

// NewEmitter wraps w (normally os.Stdout) with a 4KB buffered writer.
func NewEmitter(w io.Writer) *Emitter {
	bw := bufio.NewWriterSize(w, 4096)
	return &Emitter{w: bw, enc: json.NewEncoder(bw)}
}

// Ready announces the worker is up and listening for control messages, and
// declares the histogram bucket tables it will roll results up into.
//
// The worker aggregates for itself, so it carries its own copy of those tables;
// they are the on-disk layout and merge positionally, so a drift between the
// two implementations would not fail, it would quietly mix two different
// distributions into one column. The control plane compares them here and
// refuses the worker's results rather than storing them wrong.
func (e *Emitter) Ready(buckets any) {
	e.emit(struct {
		Op      string `json:"op"`
		Buckets any    `json:"buckets"`
	}{Op: "ready", Buckets: buckets})
}

// Status publishes a run snapshot.
func (e *Emitter) Status(s StatusMsg) {
	e.emit(statusEnvelope{Op: "status", StatusMsg: s})
}

// Stopped confirms a run has fully drained and flushed.
func (e *Emitter) Stopped(runID string) {
	e.emit(runMsg{Op: "stopped", RunID: runID})
}

func (e *Emitter) emit(v any) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if err := e.enc.Encode(v); err != nil {
		return
	}
	// A 4KB buffer holds several messages; flush when full-ish is automatic.
	// Lifecycle messages are rare, so flush each one to keep latency sane.
	_ = e.w.Flush()
}

// Flush drains any buffered bytes. Called once on shutdown.
func (e *Emitter) Flush() {
	e.mu.Lock()
	defer e.mu.Unlock()
	_ = e.w.Flush()
}
