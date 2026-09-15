package wire

import (
	"bufio"
	"encoding/json"
	"io"
	"sync"
)

// BaselineMsg is the {"op":"baseline"} broadcast: probe timestamps and
// rolling per-class sample windows, both keyed by scenario class.
type BaselineMsg struct {
	At      map[string]int64     `json:"at"`
	ByClass map[string][]float64 `json:"byClass"`
}

// StatusMsg is the {"op":"status"} snapshot. Field names match the TS driver
// status channel exactly.
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
	Dropped                  int64   `json:"dropped"`
}

type statusEnvelope struct {
	Op string `json:"op"`
	StatusMsg
}

type baselineEnvelope struct {
	Op string `json:"op"`
	BaselineMsg
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

// Ready announces the worker is up and listening for control messages.
func (e *Emitter) Ready() {
	e.emit(struct {
		Op string `json:"op"`
	}{Op: "ready"})
}

// Status publishes a run snapshot.
func (e *Emitter) Status(s StatusMsg) {
	e.emit(statusEnvelope{Op: "status", StatusMsg: s})
}

// Baseline publishes refreshed direct-probe baselines.
func (e *Emitter) Baseline(b BaselineMsg) {
	e.emit(baselineEnvelope{Op: "baseline", BaselineMsg: b})
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
