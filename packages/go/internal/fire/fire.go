package fire

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"strconv"
	"sync"
	"time"

	"github.com/apigw-tester/go/internal/scen"
	"github.com/apigw-tester/go/internal/schedule"
	"github.com/apigw-tester/go/internal/wire"
)

// ServerMSHeader is the SUT's backend-reached fingerprint, mirroring
// SERVER_MS_HEADER in packages/app/src/petstore/server.ts.
const ServerMSHeader = "X-Server-Ms"

// Timeout budgets per class. Generous on purpose: a timeout here is recorded
// as a failure of the target, so the budget has to be past anything a healthy
// gateway would do, not near it.
const (
	budgetSmallMs = 15_000
	budgetLargeMs = 60_000
)

// NeverLeftTheGenerator reports whether a request failed before it was ever
// offered to the target — name resolution or the TCP connect itself.
//
// The distinction is the whole point. A request the gateway refused, answered
// with a 5xx or dropped mid-flight is evidence about the gateway, and belongs
// in its error rate. A request that never reached it is evidence about us: a
// dial storm, an exhausted ephemeral port range, a listener whose accept queue
// overflowed. Counting the second as the first is how a rig accuses a gateway
// of failing under load when what actually happened is that the generator
// could not open a socket — and at 10k rps on Windows that was 66,329
// "gateway errors" against a SUT that was answering every request it received
// in 90ms.
//
// Deliberately narrow: only dial and DNS. A connection reset once the request
// was on the wire is left to count against the target, because from here it is
// indistinguishable from the target hanging up, and guessing in the
// generator's favour is the bias this function exists to avoid.
func NeverLeftTheGenerator(err error) bool {
	if err == nil {
		return false
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return true
	}
	var op *net.OpError
	return errors.As(err, &op) && op.Op == "dial"
}

// BudgetFor returns the per-request timeout budget in milliseconds.
func BudgetFor(class string) int64 {
	switch class {
	case "slow-upstream", "big-response", "big-request":
		return budgetLargeMs
	default:
		return budgetSmallMs
	}
}

var respBufPool = sync.Pool{New: func() any {
	b := make([]byte, 0, 64*1024)
	return &b
}}

// Firer issues requests described by pooled Jobs. It owns no goroutines;
// per-request work runs on the caller's goroutine (the worker's executor).
type Firer struct {
	clients *Clients
	reaper  *schedule.Reaper
	ids     *scen.IDTracker

	start time.Time
	wall0 int64
}

// NewFirer wires a Firer against tuned clients and the shared deadline reaper.
func NewFirer(clients *Clients, reaper *schedule.Reaper, ids *scen.IDTracker) *Firer {
	return &Firer{
		clients: clients,
		reaper:  reaper,
		ids:     ids,
		start:   time.Now(),
		wall0:   time.Now().UnixMilli(),
	}
}

func (f *Firer) nowMs() int64   { return f.wall0 + time.Since(f.start).Milliseconds() }
func (f *Firer) clock() float64 { return float64(time.Since(f.start).Microseconds()) / 1000.0 }

// Fire executes the request described by j and fills j.Result. TTFB comes
// from an httptrace hook (no extra goroutine); the deadline rides the shared
// reaper (no per-request timer). Never returns an error: all failure modes
// are folded into j.Result so the caller's accounting stays in one place.
func (f *Firer) Fire(j *Job) {
	spec := j.Spec
	client := f.clients.Rest
	if spec.Protocol == "soap" {
		client = f.clients.Soap
	}

	r := &j.Result
	r.RunID = j.RunID
	r.RequestID = j.RequestID
	r.TS = f.nowMs()
	r.Protocol = spec.Protocol
	r.Endpoint = spec.Endpoint
	r.Class = spec.Class
	r.Method = spec.Method
	r.MeasurementVersion = wire.MeasurementVersion
	r.BytesReq = int64(len(spec.Body))

	deadline := time.Duration(BudgetFor(spec.Class)) * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	j.Ctx = ctx
	j.Cancel = cancel
	handle := f.reaper.After(time.Now().Add(deadline), cancel)
	defer func() {
		handle.Done()
		cancel()
	}()

	var body io.Reader
	if spec.Body != nil {
		body = bytes.NewReader(spec.Body)
	}
	req, err := http.NewRequestWithContext(ctx, spec.Method, j.URL, body)
	if err != nil {
		msg := err.Error()
		r.Error = &msg
		return
	}
	j.Req = req

	for k, v := range spec.Headers {
		req.Header.Set(k, v)
	}
	req.Header.Set("x-request-id", j.RequestID)
	req.Header.Set("traceparent", j.Traceparent)
	if j.AuthHeader != "" {
		req.Header.Set("Authorization", j.AuthHeader)
	}
	if j.APIKey != "" {
		hdr := j.APIKeyHdr
		if hdr == "" {
			hdr = "X-API-Key"
		}
		req.Header.Set(hdr, j.APIKey)
	}

	t0 := f.clock()
	ttfb := -1.0
	// Connection acquisition: everything between asking the pool for a socket
	// and having one. A pool hit is microseconds; a miss is a DNS lookup, a TCP
	// handshake and, against a real gateway, a TLS handshake. All of it sits
	// inside TTFB and none of it is per-request gateway cost, so the control
	// plane subtracts it from the residual — see residualOf. Measured on a pool
	// hit too, because a hit that waited on MaxConnsPerHost waited on *us*, and
	// charging our own connection contention to the gateway is the same error.
	connStart, connMs := -1.0, 0.0
	reused := false
	trace := &httptrace.ClientTrace{
		GetConn: func(string) { connStart = f.clock() },
		GotConn: func(info httptrace.GotConnInfo) {
			reused = info.Reused
			if connStart >= 0 {
				connMs = f.clock() - connStart
			}
		},
		GotFirstResponseByte: func() { ttfb = f.clock() - t0 },
	}
	req = req.WithContext(httptrace.WithClientTrace(req.Context(), trace))

	res, err := client.Do(req)
	if err != nil {
		msg := err.Error()
		if errors.Is(err, context.DeadlineExceeded) || ctx.Err() == context.DeadlineExceeded {
			msg = "timeout/abort"
		}
		r.Error = &msg
		r.GenFault = NeverLeftTheGenerator(err)
		r.LatencyMs = f.clock() - t0
		return
	}
	defer res.Body.Close()

	r.Status = res.StatusCode
	r.LatencyMs = f.clock() - t0
	if ttfb >= 0 {
		r.TTFBMs = &ttfb
	}
	if connStart >= 0 {
		r.ConnectMs = &connMs
		r.ConnReused = reused
	}
	// Recorded, not reduced: the control plane differences these against the
	// reference stream. A response without X-Server-Ms never reached the
	// backend, so it has no residual and contributes to neither arm.
	serverMs := ParseServerMs(res.Header.Get(ServerMSHeader))
	r.ServerMs = serverMs
	r.ReachedBackend = serverMs != nil

	// Drain the body. Only createPet (captureId) buffers it: to learn the new
	// id. Everything else counts bytes without holding them.
	if spec.CaptureID {
		buf := respBufPool.Get().(*[]byte)
		(*buf) = (*buf)[:0]
		n := drainCapture(res.Body, buf)
		r.BytesResp = n
		if res.StatusCode >= 200 && res.StatusCode < 300 && len(*buf) > 0 && len(*buf) < 1_000_000 {
			var parsed struct {
				ID any `json:"id"`
			}
			if json.Unmarshal(*buf, &parsed) == nil {
				if id, ok := parsed.ID.(float64); ok {
					f.ids.Track(int(id))
				}
			}
		}
		respBufPool.Put(buf)
	} else {
		n, _ := io.Copy(io.Discard, res.Body)
		r.BytesResp = n
	}
}

// ParseServerMs reads the SUT's own processing time out of ServerMSHeader:
// absent or garbage → nil, a non-negative number → the value. nil rather than
// zero, because zero is a real reading and "the backend did not tell us" must
// not be charged to the gateway as non-backend time.
func ParseServerMs(raw string) *float64 {
	if raw == "" {
		return nil
	}
	n, err := strconv.ParseFloat(raw, 64)
	if err != nil || n < 0 {
		return nil
	}
	return &n
}

// drainCapture reads the whole body into buf while counting all bytes. Bodies
// above 1MB stop being appended (id capture only applies to createPet, whose
// responses are small), but the drain still runs to completion so the
// connection returns to the pool.
func drainCapture(body io.Reader, buf *[]byte) int64 {
	var total int64
	tmp := make([]byte, 32*1024)
	for {
		n, err := body.Read(tmp)
		if n > 0 {
			total += int64(n)
			if len(*buf)+n <= cap(*buf) {
				*buf = append(*buf, tmp[:n]...)
			}
		}
		if err != nil {
			return total
		}
	}
}
