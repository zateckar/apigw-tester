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
	RunID              string   `json:"runId"`
	RequestID          string   `json:"requestId"`
	TS                 int64    `json:"ts"`
	Protocol           string   `json:"protocol"`
	Endpoint           string   `json:"endpoint"`
	Class              string   `json:"class"`
	Method             string   `json:"method"`
	Status             int      `json:"status"`
	LatencyMs          float64  `json:"latencyMs"`
	TTFBMs             *float64 `json:"ttfbMs"`
	BaselineMs         float64  `json:"baselineMs"`
	OverheadMs         *float64 `json:"overheadMs"`
	OverheadReason     *string  `json:"overheadReason"`
	MeasurementVersion int      `json:"measurementVersion"`
	BytesReq           int64    `json:"bytesReq"`
	BytesResp          int64    `json:"bytesResp"`
	ReachedBackend     bool     `json:"reachedBackend"`
	Error              *string  `json:"error"`
}

// MeasurementVersion flags the measurement pipeline revision (TS uses 2).
const MeasurementVersion = 2

// LoadShedSample mirrors the TS LoadShedSample interface: per-minute
// scheduler accounting flushed alongside the results it explains.
type LoadShedSample struct {
	BucketTS  int64   `json:"bucketTs"`
	Dropped   int64   `json:"dropped"`
	TargetSum float64 `json:"targetSum"`
	Ticks     int64   `json:"ticks"`
}

// Batch is one NDJSON line on the results socket. Shed is omitted when empty.
type Batch struct {
	BatchID string           `json:"batchId"`
	Shed    []LoadShedSample `json:"shed,omitempty"`
	Results []RequestResult  `json:"results"`
}

var bufferPool = sync.Pool{New: func() any { return new(bytes.Buffer) }}

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
func (s *ResultsSink) WriteBatch(b *Batch) (err error) {
	buf := bufferPool.Get().(*bytes.Buffer)
	defer func() {
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
