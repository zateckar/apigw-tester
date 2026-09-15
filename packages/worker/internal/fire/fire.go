package fire

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptrace"
	"strconv"
	"sync"
	"time"

	"github.com/apigw-tester/worker/internal/scen"
	"github.com/apigw-tester/worker/internal/schedule"
	"github.com/apigw-tester/worker/internal/wire"
)

// ServerMSHeader is the SUT's backend-reached fingerprint, mirroring
// SERVER_MS_HEADER in packages/app/src/petstore/server.ts.
const ServerMSHeader = "X-Server-Ms"

// Timeout budgets per class, mirroring the TS driver.
const (
	budgetSmallMs = 15_000
	budgetLargeMs = 60_000
)

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

// BaselineFunc provides direct-transport calibration per class in
// milliseconds. The worker installs it from the probe subsystem.
type BaselineFunc func(class string) float64

// Firer issues requests described by pooled Jobs. It owns no goroutines;
// per-request work runs on the caller's goroutine (the worker's executor).
type Firer struct {
	clients   *Clients
	reaper    *schedule.Reaper
	ids       *scen.IDTracker
	baselines BaselineFunc

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

// SetBaselines installs the per-class direct calibration lookup; baselineMs
// then reported as serverMs + baseline(class) whenever the backend answered.
func (f *Firer) SetBaselines(fn BaselineFunc) { f.baselines = fn }

func (f *Firer) nowMs() int64   { return f.wall0 + time.Since(f.start).Milliseconds() }
func (f *Firer) clock() float64 { return float64(time.Since(f.start).Microseconds()) / 1000.0 }

func (f *Firer) baselineFor(class string) float64 {
	if f.baselines == nil {
		return 0
	}
	return f.baselines(class)
}

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
		r.BaselineMs = f.baselineFor(spec.Class)
		// latency measured from prepare, not send — same epoch as the TS
		f.failReason(r)
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
	trace := &httptrace.ClientTrace{
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
		r.LatencyMs = f.clock() - t0
		r.BaselineMs = f.baselineFor(spec.Class)
		f.failReason(r)
		return
	}
	defer res.Body.Close()

	r.Status = res.StatusCode
	r.LatencyMs = f.clock() - t0
	if ttfb >= 0 {
		r.TTFBMs = &ttfb
	}
	serverMs := ParseServerMs(res.Header.Get(ServerMSHeader))
	r.ReachedBackend = serverMs != nil
	if serverMs != nil {
		r.BaselineMs = *serverMs + f.baselineFor(spec.Class)
	} else {
		r.BaselineMs = f.baselineFor(spec.Class)
	}

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

func (f *Firer) failReason(r *wire.RequestResult) {
	// The control plane stamps per-window health exclusions; the worker only
	// marks request-internal failures.
	reason := "request failed"
	r.OverheadReason = &reason
}

// ParseServerMs mirrors parseServerMs in the TS driver: absent or garbage →
// nil, a non-negative number → the SUT's own processing time.
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
