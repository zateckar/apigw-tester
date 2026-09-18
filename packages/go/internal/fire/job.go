package fire

import (
	"context"
	crand "crypto/rand"
	"encoding/hex"
	"fmt"
	mrand "math/rand/v2"
	"net/http"
	"sync"
	"sync/atomic"

	"github.com/apigw-tester/go/internal/scen"
	"github.com/apigw-tester/go/internal/wire"
)

// RequestIds generates correlation ids as one random 6-byte prefix per run
// plus a counter, so ids are unique within and
// across runs, monotonic in send order, and near-free compared to randomUUID
// per request.
type RequestIds struct {
	prefix [12]byte // hex chars, first nibble forced non-zero
	seq    atomic.Uint64
}

// Reset draws a fresh prefix; call once per run.
func (r *RequestIds) Reset() {
	var raw [6]byte
	if _, err := crand.Read(raw[:]); err != nil {
		// crypto/rand failing is not survivable for uniqueness in theory; in
		// practice it does not happen on supported platforms and refusing to
		// run is worse for the rig — fall back to math/rand.
		for i := range raw {
			raw[i] = byte(mrand.Uint64())
		}
	}
	hex.Encode(r.prefix[:], raw[:])
	if r.prefix[0] == '0' {
		r.prefix[0] = '1'
	}
	r.seq.Store(0)
}

// Next returns a 32-hex id usable verbatim as a W3C trace-id plus the
// traceparent header built from it. The span id mixes run entropy with the
// counter, so it is distinct from the trace id without a second draw.
func (r *RequestIds) Next() (requestID string, traceparent string) {
	seq := r.seq.Add(1)
	seqHex := fmt.Sprintf("%020x", seq)
	traceID := string(r.prefix[:]) + seqHex
	spanID := string(r.prefix[:4]) + seqHex[len(seqHex)-12:]
	return traceID, "00-" + traceID + "-" + spanID + "-01"
}

// Job is the pooled per-request working set: spec, prepared request, deadline
// bookkeeping and the result scaffold. The pool keeps allocations off the
// request path at high rps.
type Job struct {
	Spec        *scen.Spec
	RunID       string
	RequestID   string
	Traceparent string
	URL         string
	AuthHeader  string // full "Basic base64" value or ""
	APIKey      string
	APIKeyHdr   string

	Ctx    context.Context
	Cancel context.CancelFunc
	Req    *http.Request

	// Result is filled by Fire and handed to the results channel.
	Result wire.RequestResult
}

var jobPool = sync.Pool{New: func() any { return &Job{} }}

// GetJob fetches a job from the pool.
func GetJob() *Job { return jobPool.Get().(*Job) }

// PutJob returns a job to the pool after clearing references that would pin
// bodies or response state.
func PutJob(j *Job) {
	j.Spec = nil
	j.RunID = ""
	j.RequestID = ""
	j.Traceparent = ""
	j.URL = ""
	j.AuthHeader = ""
	j.APIKey = ""
	j.APIKeyHdr = ""
	j.Ctx = nil
	j.Cancel = nil
	j.Req = nil
	j.Result = wire.RequestResult{}
	jobPool.Put(j)
}
