package wire

import (
	"bytes"
	"encoding/json"
	"net"
	"sync"
)

// RequestResult mirrors the TS RequestResult interface field-for-field; JSON
// names are camelCase and must stay aligned with packages/shared/src/index.ts.
type RequestResult struct {
	RunID     string  `json:"runId"`
	RequestID string  `json:"requestId"`
	TS        int64   `json:"ts"`
	Protocol  string  `json:"protocol"`
	Endpoint  string  `json:"endpoint"`
	Class     string  `json:"class"`
	Method    string  `json:"method"`
	Status    int     `json:"status"`
	LatencyMs float64 `json:"latencyMs"`
	// TTFBMs and ServerMs are recorded as observed and never combined here.
	// Their difference, less ConnectMs, is the request's non-backend time —
	// everything the response waited on that was not the backend handler — and
	// that is the quantity the gateway is read from.
	TTFBMs   *float64 `json:"ttfbMs"`
	ServerMs *float64 `json:"serverMs"`
	// ConnectMs is time spent acquiring a socket — a pool wait, or a DNS
	// lookup, TCP handshake and TLS handshake on a miss. It sits inside TTFBMs
	// and is not per-request gateway cost, so non-backend time subtracts it. Nil
	// means "not measured" (the TS backend's fetch exposes no such hook), which
	// is distinct from measured-and-zero.
	ConnectMs          *float64 `json:"connectMs"`
	ConnReused         bool     `json:"connReused"`
	MeasurementVersion int      `json:"measurementVersion"`
	BytesReq           int64    `json:"bytesReq"`
	BytesResp          int64    `json:"bytesResp"`
	ReachedBackend     bool     `json:"reachedBackend"`
	Error              *string  `json:"error"`
	// GenFault marks a failure that never left this process — see
	// fire.NeverLeftTheGenerator. Such a request is not evidence about the
	// target and is kept out of its error rate; it is counted per minute in
	// LoadShedSample.GenFaults instead, where it invalidates the window.
	GenFault bool `json:"genFault"`
}

// MeasurementVersion must match MEASUREMENT_VERSION in
// packages/shared/src/index.ts: the store ignores non-backend time from any
// older schema, since measurement 2's overhead is a different quantity.
const MeasurementVersion = 3

// LoadShedSample mirrors the TS LoadShedSample interface: per-minute
// scheduler accounting flushed alongside the results it explains.
type LoadShedSample struct {
	BucketTS int64 `json:"bucketTs"`
	Dropped  int64 `json:"dropped"`
	// ResultsLost is measurements discarded in this minute for requests that
	// were issued and answered — the window's numbers describe a subset of
	// what the gateway actually served.
	ResultsLost int64 `json:"resultsLost"`
	// GenFaults is requests that failed before reaching the target at all.
	// Shed load was never issued and these were, but neither says anything
	// about the gateway, and both belong to the generator's own accounting.
	GenFaults int64   `json:"genFaults"`
	TargetSum float64 `json:"targetSum"`
	Ticks     int64   `json:"ticks"`
}

// AggCell is one pre-rolled (minute, protocol, endpoint, class) cell, mirroring
// the TS AggCell. Hist and StatusHist are positional over hist.LatencyEdges and
// hist.StatusBuckets and are merged positionally by the store.
type AggCell struct {
	BucketTS       int64   `json:"bucketTs"`
	FirstTS        int64   `json:"firstTs"`
	LastTS         int64   `json:"lastTs"`
	Protocol       string  `json:"protocol"`
	Endpoint       string  `json:"endpoint"`
	Class          string  `json:"cls"`
	Count          int64   `json:"count"`
	Errors         int64   `json:"errors"`
	OK2xx          int64   `json:"ok2xx"`
	Rejected4xx    int64   `json:"rejected4xx"`
	Rejected4xxGw  int64   `json:"rejected4xxGw"`
	ReachedBackend int64   `json:"reachedBackend"`
	LatencySumMs   float64 `json:"latencySumMs"`
	MaxLatencyMs   float64 `json:"maxLatencyMs"`
	BytesReq       int64   `json:"bytesReq"`
	BytesResp      int64   `json:"bytesResp"`
	// ConnSetups counts requests that opened a connection rather than reusing
	// one, and ConnSetupSumMs their total acquisition time. Not a correction —
	// NonBackend* already subtracts acquisition per request — but the evidence
	// for whether it mattered: a gateway that churns connections shows up here
	// instead of vanishing into a subtraction.
	// ConnMeasured is what makes the share readable: 0 on a producer that cannot
	// see connection events, where a bare ConnSetups of 0 would otherwise be
	// indistinguishable from perfect reuse.
	ConnSetups     int64   `json:"connSetups"`
	ConnSetupSumMs float64 `json:"connSetupSumMs"`
	ConnMeasured   int64   `json:"connMeasured"`
	Hist           []int64 `json:"hist"`
	StatusHist     []int64 `json:"statusHist"`
	// NonBackend* is time spent anywhere other than the backend, per request:
	// ttfb − serverMs − connectMs. Every request carrying both clocks
	// contributes, so it is readable at any percentile over any window, unlike
	// the two-arm Δ it replaced whose control stream was 2% of the load. It
	// includes the network to the gateway and is not the gateway's processing
	// cost alone. NonBackendHist is positional over hist.ResidualEdges.
	NonBackendCount int64   `json:"nonBackendCount"`
	NonBackendSumMs float64 `json:"nonBackendSumMs"`
	NonBackendHist  []int64 `json:"nonBackendHist"`
}

// RunCell is how many requests a run contributed to a minute — the roll-ups
// carry no run id, so this is what makes a per-run report able to say how much
// of its window was somebody else's traffic.
type RunCell struct {
	BucketTS int64  `json:"bucketTs"`
	RunID    string `json:"runId"`
	Count    int64  `json:"count"`
}

// AggBatch is one NDJSON line on the results socket: roll-ups plus a bounded
// raw tail for the recent-requests table. Its size is a function of the
// endpoint and class mix, not of the request rate.
//
// Shed accounting rides the same line as the requests it covers, so a window
// can never commit issued load without the load it failed to issue.
type AggBatch struct {
	BatchID string           `json:"batchId"`
	Cells   []AggCell        `json:"cells"`
	Runs    []RunCell        `json:"runs"`
	Tail    []RequestResult  `json:"tail"`
	Shed    []LoadShedSample `json:"shed,omitempty"`
	// Health is always present, never omitted, even when empty: an empty array
	// means the window was quiet, and its absence means the producer cannot see
	// itself at all. Those are different claims and collapsing them loses the
	// distinction.
	Health []HealthCell `json:"health"`
}

// HealthCell is one health window's evidence about the process that took the
// measurements, produced by internal/health.
//
// Scheduling latency is the error term that matters: a response arrives, its
// goroutine is ready to read the clock, and any delay between those two events
// is added to the request's measured TTFB without being added to the SUT's
// self-reported server time — so it lands whole inside non-backend time and
// reads as gateway cost that never happened. Reported, never used to withhold:
// the control plane surfaces it in the run's validity verdict.
type HealthCell struct {
	WindowTS int64 `json:"windowTs"`
	// the span actually covered by samples, so an unobserved window is
	// distinguishable from a quiet one
	FromTS     int64   `json:"fromTs"`
	ToTS       int64   `json:"toTs"`
	Samples    int     `json:"samples"`
	SchedP99Ms float64 `json:"schedP99Ms"`
	SchedMaxMs float64 `json:"schedMaxMs"`
	CPUPct     float64 `json:"cpuPct"`
	Goroutines int     `json:"goroutines"`
}

var bufferPool = sync.Pool{New: func() any { return new(bytes.Buffer) }}

// maxPooledBuf bounds what the pool is allowed to retain. A pool keeps the
// largest buffer it ever saw alive for the process lifetime, so one outsized
// batch would pin that memory forever; oversized buffers are handed to the GC
// instead.
const maxPooledBuf = 4 << 20

// ResultsSink owns the outbound TCP connection that carries NDJSON batches.
// Writes are serialised by a mutex; batch cadence is 10s, so a simple
// lockstep writer is enough and keeps failures synchronous for retry.
type ResultsSink struct {
	mu   sync.Mutex
	conn net.Conn
	addr string
}

// NewResultsSink prepares a sink that will dial addr (e.g. "127.0.0.1:9100")
// on first write. An empty addr leaves batches to be dropped (and counted).
func NewResultsSink(addr string) *ResultsSink {
	return &ResultsSink{addr: addr}
}

// WriteBatch encodes b as one NDJSON line and writes it to the socket. The
// encoding is reused from a pool; a single batch line is bounded by the
// result slice the caller sends (bounded spool), so pooling is safe.
func (s *ResultsSink) WriteBatch(b *AggBatch) (err error) {
	buf := bufferPool.Get().(*bytes.Buffer)
	defer func() {
		if buf.Cap() > maxPooledBuf {
			return
		}
		buf.Reset()
		bufferPool.Put(buf)
	}()
	enc := json.NewEncoder(buf)
	if err := enc.Encode(b); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn == nil {
		if s.addr == "" {
			return nil // nowhere to send; tests without RESULTS_ADDR
		}
		c, dialErr := net.Dial("tcp", s.addr)
		if dialErr != nil {
			return dialErr
		}
		s.conn = c
	}
	if _, err = s.conn.Write(buf.Bytes()); err != nil {
		// redial once on a dead socket, then give up — the flusher retries
		// whole batches, not partial writes
		_ = s.conn.Close()
		s.conn = nil
		c, dialErr := net.Dial("tcp", s.addr)
		if dialErr != nil {
			return dialErr
		}
		s.conn = c
		_, err = s.conn.Write(buf.Bytes())
	}
	return err
}

// Close tears down the socket; safe to call any number of times.
func (s *ResultsSink) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn != nil {
		_ = s.conn.Close()
		s.conn = nil
	}
}
