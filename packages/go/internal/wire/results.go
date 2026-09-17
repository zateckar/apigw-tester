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
	// Their difference is the request's residual — everything that was not the
	// backend — and the control plane reads the gateway's cost from how that
	// distribution differs from the reference stream's, not per request.
	TTFBMs   *float64 `json:"ttfbMs"`
	ServerMs *float64 `json:"serverMs"`
	// ConnectMs is time spent acquiring a socket — a pool wait, or a DNS
	// lookup, TCP handshake and TLS handshake on a miss. It sits inside TTFBMs
	// and is not per-request gateway cost, so the residual subtracts it. Nil
	// means "not measured" (the TS backend's fetch exposes no such hook), which
	// is distinct from measured-and-zero.
	ConnectMs          *float64 `json:"connectMs"`
	ConnReused         bool     `json:"connReused"`
	MeasurementVersion int      `json:"measurementVersion"`
	// TimingReason is filled by the control plane, which applies the verdict.
	// The evidence behind that verdict now comes from here — see HealthCell —
	// but the stamping stays over there, so this is always nil on the wire out
	// of the worker.
	TimingReason   *string `json:"timingReason"`
	BytesReq       int64   `json:"bytesReq"`
	BytesResp      int64   `json:"bytesResp"`
	ReachedBackend bool    `json:"reachedBackend"`
	Error          *string `json:"error"`
	// GenFault marks a failure that never left this process — see
	// fire.NeverLeftTheGenerator. Such a request is not evidence about the
	// target and is kept out of its error rate; it is counted per minute in
	// LoadShedSample.GenFaults instead, where it invalidates the window.
	GenFault bool `json:"genFault"`
}

// MeasurementVersion must match MEASUREMENT_VERSION in
// packages/shared/src/index.ts: the store ignores residuals from any older
// schema, since measurement 2's overhead is a different quantity.
const MeasurementVersion = 3

// BaselineSample is one observation from the direct-to-SUT reference stream:
// the control arm of the overhead comparison. Mirrors the TS BaselineSample.
type BaselineSample struct {
	TS    int64  `json:"ts"`
	Class string `json:"class"`
	// ResidualMs is ttfb - serverMs, signed. Negative values are kept: the two
	// clocks are read at different layers, and dropping the low side would
	// shift the reference distribution up and understate the gateway.
	ResidualMs float64 `json:"residualMs"`
}

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
	// the residual already subtracts acquisition per request — but the evidence
	// for whether it mattered: a gateway that churns connections shows up here
	// instead of hiding inside a Δ nobody can explain.
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
	// the two-arm Δ whose control stream was 2% of the load. It includes the
	// network to the gateway and is not the gateway's processing cost alone.
	// NonBackendHist is positional over hist.ResidualEdges.
	NonBackendCount int64   `json:"nonBackendCount"`
	NonBackendSumMs float64 `json:"nonBackendSumMs"`
	NonBackendHist  []int64 `json:"nonBackendHist"`
}

// ResidualCell is one health window's residuals for one class on one arm
// ("gw" through the gateway, "direct" from the reference stream).
//
// Keyed by health window rather than by minute because only the control plane
// samples local health: shipping at that granularity lets it drop exactly the
// contaminated windows instead of choosing between a whole minute and a stall.
type ResidualCell struct {
	WindowTS int64   `json:"windowTs"`
	Class    string  `json:"cls"`
	Path     string  `json:"path"`
	Count    int64   `json:"count"`
	SumMs    float64 `json:"sumMs"`
	Hist     []int64 `json:"hist"`
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
// Shed accounting and the reference arm ride the same line as the requests they
// cover, so a window can never commit issued load without the load it failed to
// issue, or one arm of the overhead comparison without the other.
type AggBatch struct {
	BatchID   string           `json:"batchId"`
	Cells     []AggCell        `json:"cells"`
	Residuals []ResidualCell   `json:"residuals"`
	Runs      []RunCell        `json:"runs"`
	Tail      []RequestResult  `json:"tail"`
	Shed      []LoadShedSample `json:"shed,omitempty"`
	// Health is always present, never omitted, even when empty: its absence is
	// how the control plane recognises a worker too old to report its own
	// health and falls back to judging windows by its own. An omitempty here
	// would make a quiet second indistinguishable from an old binary, and the
	// control plane would silently apply the wrong gate.
	Health []HealthCell `json:"health"`
}

// HealthCell is one health window's evidence about the process that took the
// measurements, produced by internal/health.
//
// This travels with the residual cells for the same window because it is what
// decides whether they can be trusted. Scheduling latency is the error term
// that matters here: a response arrives, its goroutine is ready to read the
// clock, and any delay between those two events is added to the request's
// measured TTFB without being added to the SUT's self-reported server time —
// so it lands whole inside the residual and reads as gateway overhead.
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
