// Package probe issues the direct-to-SUT reference stream: the control arm of
// the gateway-overhead measurement.
//
// It replaces a 120-second cycle of seven sequential calibration probes. That
// design had three faults this one exists to remove. Its connections were cold,
// so it measured TCP setup the load path had long since amortised. Its samples
// were up to two minutes away in time from the traffic they were subtracted
// from, so a comparison could straddle entirely different machine conditions.
// And its result was a per-class median subtracted from every request, which
// added the whole direct distribution's variance to each observation.
//
// Here the reference is continuous, warm, paced off the same tick as the load,
// and built by the same scenario generator — so the two residual distributions
// cover the same minutes in the same proportions, and the gateway's cost can be
// read off them at matched percentiles.
package probe

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptrace"
	"sync"
	"sync/atomic"
	"time"

	"github.com/apigw-tester/go/internal/config"
	"github.com/apigw-tester/go/internal/fire"
	"github.com/apigw-tester/go/internal/scen"
	"github.com/apigw-tester/go/internal/wire"
)

// Sizing of the reference stream, mirroring REFERENCE_STREAM in
// packages/shared/src/index.ts. Both backends must pick the same rate or the
// same gateway would be reported with different confidence depending on which
// generator ran it.
const (
	PctOfLoad = 2.0
	MinRPS    = 2.0
	MaxRPS    = 500.0
)

// MaxInFlight bounds concurrent reference probes. The reference arm must never
// queue behind itself: a slow SUT would otherwise accumulate probes whose
// measured residual is mostly our own backlog, and that inflated reference gets
// subtracted from the gateway arm — flattering the gateway exactly when things
// are worst. Hitting this ceiling thins the arm instead, which the reported Δ
// shows as a smaller directSamples.
//
// Sized off the stream's own rate rather than left at the old 64: the declared
// share needs 200 probes a second at LIMITS.rps, so a SUT answering in much
// over 300ms would have spent all its time against that ceiling and thinned the
// control arm for a reason that has nothing to do with the SUT being slow.
const MaxInFlight = 256

// MaxSpool bounds observations held between flushes — tens of seconds of buffer
// even at the rate a 10k rps run calls for, against a one-second flush cadence.
// Overflow drops the oldest and is not counted: unlike a lost request
// measurement, a thinner reference arm is not silent.
const MaxSpool = 5_000

// RPSFor is the reference rate for a given target rate.
func RPSFor(targetRps float64) float64 {
	if targetRps <= 0 {
		return 0
	}
	want := targetRps * PctOfLoad / 100
	if want < MinRPS {
		want = MinRPS
	}
	if want > MaxRPS {
		want = MaxRPS
	}
	return want
}

// Streamer owns the reference stream's pacing and spool. It runs no goroutine
// of its own: the worker pumps it from the scheduler tick, so the reference and
// the load always advance together.
//
// Owner: the worker. Wait blocks until outstanding probes finish.
type Streamer struct {
	mu     sync.Mutex
	url    string
	auth   string
	spool  []wire.BaselineSample
	tokens float64
	lastMs int64

	client   *http.Client
	ids      *scen.IDTracker
	inFlight atomic.Int64
	wg       sync.WaitGroup
}

// NewStreamer builds a streamer with its own transport, so reference probes
// never share a socket pool with the load path — sharing one would let the
// load's queueing show up inside the reference measurement.
func NewStreamer(ids *scen.IDTracker) *Streamer {
	return &Streamer{
		client: &http.Client{Transport: fire.NewTransport()},
		ids:    ids,
	}
}

// Configure swaps the direct target and the credential it needs; safe anytime.
func (s *Streamer) Configure(url, auth string) {
	s.mu.Lock()
	s.url = url
	s.auth = auth
	s.mu.Unlock()
}

// Reset clears pacing and spool state at the start of a run.
func (s *Streamer) Reset() {
	s.mu.Lock()
	s.spool = nil
	s.tokens = 0
	s.lastMs = 0
	s.mu.Unlock()
}

// Pump issues this tick's share of reference traffic. Called from the worker's
// scheduler tick with the same target rate the load is being paced at.
func (s *Streamer) Pump(nowMs int64, targetRps float64, profile *config.LoadProfile) {
	s.mu.Lock()
	url, auth := s.url, s.auth
	if url == "" {
		s.mu.Unlock()
		return
	}
	if s.lastMs == 0 {
		// first tick establishes the clock; minting tokens from a zero epoch
		// would release a whole run's worth at once
		s.lastMs = nowMs
		s.mu.Unlock()
		return
	}
	rps := RPSFor(targetRps)
	dt := float64(nowMs-s.lastMs) / 1000
	if dt < 0 {
		dt = 0
	}
	s.lastMs = nowMs
	s.tokens += dt * rps
	if s.tokens > rps {
		s.tokens = rps // burst ceiling of one second, as the load's bucket uses
	}
	due := int(s.tokens)
	s.tokens -= float64(due)
	s.mu.Unlock()

	if room := MaxInFlight - int(s.inFlight.Load()); due > room {
		due = room
	}
	if due <= 0 {
		return
	}
	// one copy shared by this tick's probes; BuildSpec only reads it
	p := *profile
	for i := 0; i < due; i++ {
		s.inFlight.Add(1)
		s.wg.Add(1)
		go s.one(url, auth, &p)
	}
}

// one issues a single reference probe and records its residual.
// Owner: Streamer.wg; exits when the probe completes or its budget expires.
func (s *Streamer) one(url, auth string, profile *config.LoadProfile) {
	defer s.wg.Done()
	defer s.inFlight.Add(-1)

	// the same generator the load uses, so the class mix matches by
	// construction — which is what makes pooling residuals across classes and
	// reading the difference as the gateway's cost legitimate
	spec := scen.BuildSpec(profile, s.ids)
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(fire.BudgetFor(spec.Class))*time.Millisecond)
	defer cancel()

	var body io.Reader
	if spec.Body != nil {
		body = bytes.NewReader(spec.Body)
	}
	req, err := http.NewRequestWithContext(ctx, spec.Method, url+spec.Path, body)
	if err != nil {
		return
	}
	for k, v := range spec.Headers {
		req.Header.Set(k, v)
	}
	// straight to the SUT, so this rig's own credential is the right one and
	// the gateway's API key is not
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}

	startWall := time.Now().UnixMilli()
	start := time.Now()
	since := func() float64 { return float64(time.Since(start).Microseconds()) / 1000.0 }
	ttfb := -1.0
	// The reference arm subtracts connection acquisition exactly as the gateway
	// arm does. It has to: this stream runs at a fraction of the load and so
	// keeps a near-idle pool, meaning it pays setup on a different schedule
	// entirely. Correcting one arm and not the other would put that whole
	// difference into the Δ and call it the gateway's cost.
	connStart, connMs := -1.0, 0.0
	trace := &httptrace.ClientTrace{
		GetConn: func(string) { connStart = since() },
		GotConn: func(httptrace.GotConnInfo) {
			if connStart >= 0 {
				connMs = since() - connStart
			}
		},
		GotFirstResponseByte: func() { ttfb = since() },
	}
	req = req.WithContext(httptrace.WithClientTrace(req.Context(), trace))

	res, err := s.client.Do(req)
	if err != nil {
		// a probe that never answered contributes nothing; it is not the
		// gateway's failure and must not be reported as one
		return
	}
	defer res.Body.Close()
	serverMs := fire.ParseServerMs(res.Header.Get(fire.ServerMSHeader))
	_, _ = io.Copy(io.Discard, res.Body)
	if serverMs == nil || ttfb < 0 {
		return
	}
	// signed, as measured: clamping the low side here would shift the whole
	// reference distribution up and understate the gateway by that much
	s.record(wire.BaselineSample{TS: startWall, Class: spec.Class, ResidualMs: ttfb - *serverMs - connMs})
}

func (s *Streamer) record(sample wire.BaselineSample) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.spool) >= MaxSpool {
		s.spool = s.spool[len(s.spool)/10:]
	}
	s.spool = append(s.spool, sample)
}

// Drain takes everything spooled since the last call.
func (s *Streamer) Drain() []wire.BaselineSample {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.spool
	s.spool = nil
	return out
}

// Wait blocks until outstanding probes finish, so a run's final flush carries
// the reference observations covering its last seconds.
func (s *Streamer) Wait() { s.wg.Wait() }

// WaitFor is Wait with a deadline, reporting whether the probes finished.
//
// A probe's own budget runs to BudgetFor(class) — a minute for the large
// classes — so an unbounded wait here let one straggler hold the whole stop
// open for that long, well past the bound the request drain gets. A run that
// will not end is worse than a reference arm missing its last few samples, and
// the samples are not even lost: a probe that lands after the deadline still
// spools, and the next flush carries it.
func (s *Streamer) WaitFor(d time.Duration) bool {
	done := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
		return true
	case <-time.After(d):
		return false
	}
}
