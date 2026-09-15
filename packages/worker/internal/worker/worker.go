package worker

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/apigw-tester/worker/internal/config"
	"github.com/apigw-tester/worker/internal/fire"
	"github.com/apigw-tester/worker/internal/probe"
	"github.com/apigw-tester/worker/internal/scen"
	"github.com/apigw-tester/worker/internal/schedule"
	"github.com/apigw-tester/worker/internal/wire"
)

// TickMS mirrors TICK_MS in the TS driver.
const TickMS = 20

// FlushInterval mirrors FLUSH_MS (10s).
const FlushInterval = 10 * time.Second

// StatusInterval is the op=status cadence.
const StatusInterval = 10 * time.Second

// ResultChanCap bounds the buffered results channel, mirroring MAX_SPOOL.
const ResultChanCap = 65_536

// MaxShedBuckets mirrors MAX_SHED_BUCKETS.
const MaxShedBuckets = 2_000

// DrainTimeout bounds how long stop waits for in-flight requests.
const DrainTimeout = 5 * time.Second

// LatencyAllowanceSec mirrors LATENCY_ALLOWANCE_SEC: Little's law allowance
// used to size the effective concurrency ceiling.
const LatencyAllowanceSec = 5

// LimitMaxConcurrency mirrors LIMITS.maxConcurrency.
const LimitMaxConcurrency = 5_000

// Params are the worker's construction-time dependencies.
type Params struct {
	Emitter *wire.Emitter
	Sink    *wire.ResultsSink
}

// Worker is the whole load-generation side of the process. It owns:
//   - the tick goroutine (scheduler, exits on stop),
//   - the flush goroutine (result socket, exits on Shutdown),
//   - the status goroutine (stdout emitter, exits on Shutdown),
//   - the baseline prober (owned by probe.Prober),
//   - the deadline reaper (owned by schedule.Reaper),
//   - per-request goroutines (one per in-flight request, exits at completion).
type Worker struct {
	params Params

	mu         sync.Mutex // guards cfg, gw, profile, run state
	cfg        *config.Configure
	urlPrefix  struct{ rest, soap string }
	authHeader string // full "Basic base64" or ""
	selfOrigin string
	// per-side credential decision, resolved on configure (sendsOurCredential)
	forwardAuth struct{ rest, soap bool }

	profile config.LoadProfile

	state     string // "idle" | "running" | "stopping"
	runID     string
	startedAt int64 // epoch ms

	effectiveMaxConcurrency int
	sem                     chan struct{} // buffered semaphore for the cap
	targetRps               atomic.Value  // float64

	bucket  *schedule.TokenBucket
	reaper  *schedule.Reaper
	clients *fire.Clients
	prober  *probe.Prober
	firer   *fire.Firer
	ids     *scen.IDTracker
	reqIDs  *fire.RequestIds

	counters Counters

	// shed accounting per minute bucket (mirrors the TS shed map)
	shedMu sync.Mutex
	shed   map[int64]*wire.LoadShedSample

	// results channel: jobs completed, awaiting flush. Pointers keep the
	// spool zero-copy; the flusher returns jobs to the pool.
	results chan *fire.Job

	done      chan struct{} // closed on Shutdown
	stopAll   sync.Once
	flushDone chan struct{}
	statDone  chan struct{}
	wg        sync.WaitGroup // in-flight request goroutines

	tickStop chan struct{}
	tickDone chan struct{}
	tickInit bool
}

// New builds a worker with the fixed dependencies; nothing runs until
// Configure/Start arrives over the control channel.
func New(p Params) *Worker {
	if p.Emitter == nil {
		p.Emitter = wire.NewEmitter(os.Stdout)
	}
	if p.Sink == nil {
		p.Sink = wire.NewResultsSink(os.Getenv("RESULTS_ADDR"))
	}
	w := &Worker{
		params:    p,
		results:   make(chan *fire.Job, ResultChanCap),
		done:      make(chan struct{}),
		flushDone: make(chan struct{}),
		statDone:  make(chan struct{}),
		tickStop:  make(chan struct{}),
		tickDone:  make(chan struct{}),
		shed:      map[int64]*wire.LoadShedSample{},
		bucket:    schedule.NewTokenBucket(),
		state:     "idle",
	}
	w.reaper = schedule.NewReaper()
	w.clients = fire.NewClients()
	w.ids = scen.NewIDTracker(120)
	w.reqIDs = &fire.RequestIds{}
	w.reqIDs.Reset()
	w.firer = fire.NewFirer(w.clients, w.reaper, w.ids)
	w.firer.SetBaselines(func(class string) float64 { return w.prober.Sample(class) })
	w.prober = probe.NewProber(probe.Params{
		Publish: func(s probe.Snapshot) {
			w.params.Emitter.Baseline(wire.BaselineMsg{At: s.At, ByClass: s.ByClass})
		},
	}, w.ids)
	w.targetRps.Store(0.0)
	// the flusher and status emitters run for the process lifetime
	go w.flushLoop()
	go w.statusLoop()
	return w
}

// Configure applies the configure control message. Safe to call anytime;
// a running run keeps running against the refreshed targets.
func (w *Worker) Configure(c *config.Configure) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.cfg = c
	w.profile = c.Profile
	w.urlPrefix.rest = config.URLPrefixFor(c.Gw.Rest)
	w.urlPrefix.soap = config.URLPrefixFor(c.Gw.Soap)
	w.selfOrigin = c.SelfOrigin
	if c.BasicAuth != "" {
		w.authHeader = "Basic " + c.BasicAuth
	} else {
		w.authHeader = ""
	}
	w.forwardAuth.rest = config.SendsBasicAuth(c.Gw.Rest, c.SelfOrigin)
	w.forwardAuth.soap = config.SendsBasicAuth(c.Gw.Soap, c.SelfOrigin)
	w.prober.Configure(c.BaselineURL, w.authHeader)
}

// Start begins a run. Idempotent: a second start while running reports the
// same runId.
func (w *Worker) Start(runID string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.state == "running" {
		return
	}
	w.state = "running"
	w.runID = runID
	w.startedAt = time.Now().UnixMilli()
	w.counters.Reset()
	w.bucket = schedule.NewTokenBucket()
	w.reqIDs.Reset()
	w.shedMu.Lock()
	w.shed = map[int64]*wire.LoadShedSample{}
	w.shedMu.Unlock()

	need := int64(math.Ceil(schedule.PeakTargetRPS(&w.profile) * LatencyAllowanceSec))
	eff := int64(w.profile.MaxConcurrency)
	if need > eff {
		eff = need
	}
	if eff > LimitMaxConcurrency {
		eff = LimitMaxConcurrency
	}
	if eff < 1 {
		eff = 1
	}
	w.effectiveMaxConcurrency = int(eff)
	w.sem = make(chan struct{}, w.effectiveMaxConcurrency)

	if !w.tickInit {
		w.tickInit = true
		go w.tickLoop()
	}
	w.prober.Start()
}

// Stop ends the current run: the ticker stops issuing, in-flight requests
// are awaited up to DrainTimeout, results flush, and a stopped message goes
// out. Safe to call when idle.
func (w *Worker) Stop() {
	w.mu.Lock()
	if w.state != "running" {
		w.mu.Unlock()
		return
	}
	w.state = "stopping"
	runID := w.runID
	w.mu.Unlock()

	// detach the tick goroutine's stop channel so a future run restarts fresh
	w.mu.Lock()
	if w.tickInit {
		close(w.tickStop)
		w.tickStop = make(chan struct{})
		w.tickInit = false
		<-w.tickDone
	}
	w.mu.Unlock()

	// wait for in-flight with a bounded drain
	deadline := time.Now().Add(DrainTimeout)
	done := make(chan struct{})
	go func() {
		w.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Until(deadline)):
		// leaked requests are counted in the flush as they land; proceeding is
		// the TS driver's behaviour after its drain timeout
	}

	w.flush(true)
	w.mu.Lock()
	w.state = "idle"
	w.runID = ""
	w.startedAt = 0
	w.mu.Unlock()
	w.params.Emitter.Stopped(runID)
}

// Shutdown quiesces everything: stop the run, stop emitters, close sockets.
func (w *Worker) Shutdown() {
	w.stopAll.Do(func() {
		w.Stop()
		w.prober.Stop()
		w.reaper.Stop()
		close(w.done)
		<-w.flushDone
		<-w.statDone
		w.params.Sink.Close()
		w.clients.CloseIdle()
		w.params.Emitter.Flush()
	})
}

// ------- tick loop (owner: worker; exits when tickStop closes) -------

func (w *Worker) tickLoop() {
	defer close(w.tickDone)
	t := time.NewTicker(TickMS * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			if !w.tick() {
				return
			}
		case <-w.tickStop:
			return
		}
	}
}

// tick is one scheduler cycle: mint tokens, cap by in-flight, spawn per-token.
func (w *Worker) tick() bool {
	w.mu.Lock()
	if w.state != "running" {
		w.mu.Unlock()
		return false
	}
	profile := w.profile
	startedAt := w.startedAt
	runID := w.runID
	w.mu.Unlock()

	nowMs := time.Now().UnixMilli()
	res := w.bucket.Tick(float64(nowMs), &profile, float64(startedAt))
	w.targetRps.Store(res.TargetRPS)
	w.noteTick(nowMs, res.TargetRPS, int64(res.Missed))

	due := res.Due
	dropped := int64(res.Missed)
	for i := 0; i < due; i++ {
		select {
		case w.sem <- struct{}{}:
			w.counters.InFlight.Add(1)
			w.wg.Add(1)
			go w.execute(runID, &profile)
		default:
			dropped++
		}
	}
	if dropped > 0 {
		w.counters.Dropped.Add(dropped)
		w.noteShed(nowMs, dropped)
	}
	return true
}

// execute is one in-flight request, from build to result enqueue.
// Owner: the worker's wg; exits after the result is queued.
func (w *Worker) execute(runID string, profile *config.LoadProfile) {
	defer w.wg.Done()
	defer func() { <-w.sem; w.counters.InFlight.Add(-1) }()

	spec := scen.BuildSpec(profile, w.ids)
	j := fire.GetJob()
	j.Spec = spec
	j.RunID = runID
	j.RequestID, j.Traceparent = w.reqIDs.Next()

	w.mu.Lock()
	url := w.urlPrefix.rest
	authFwd := w.forwardAuth.rest
	var target config.GwConfig
	if w.cfg != nil {
		target = w.cfg.Gw.Rest
	}
	if spec.Protocol == "soap" {
		url = w.urlPrefix.soap
		authFwd = w.forwardAuth.soap
		if w.cfg != nil {
			target = w.cfg.Gw.Soap
		}
	}
	auth := w.authHeader
	w.mu.Unlock()
	j.URL = url + spec.Path
	if authFwd {
		j.AuthHeader = auth
	}
	j.APIKey = target.APIKey
	j.APIKeyHdr = target.APIKeyHeader

	w.firer.Fire(j)

	// counters — the same classification the TS driver applies
	w.counters.Sent.Add(1)
	if spec.ExpectInvalid {
		w.counters.InvalidSent.Add(1)
	}
	r := &j.Result
	switch {
	case r.Error != nil:
		w.counters.Errors.Add(1)
		w.counters.GwFaults.Add(1)
		if *r.Error == "timeout/abort" {
			w.counters.Timeouts.Add(1)
		}
	default:
		st := r.Status
		switch {
		case st >= 200 && st < 400:
			w.counters.OK.Add(1)
		case st >= 400 && st < 500:
			w.counters.R4xx.Add(1)
		case st >= 500:
			w.counters.Errors.Add(1)
		}
		if st == 0 || st == 502 || st == 503 || st == 504 {
			w.counters.GwFaults.Add(1)
		}
		if st == 429 {
			w.counters.RateLimited.Add(1)
		}
		if st == 401 || st == 403 {
			w.counters.Unauthorized.Add(1)
		}
	}
	if spec.ExpectInvalid {
		if r.ReachedBackend {
			w.counters.InvalidLeaked.Add(1)
		} else if r.Status >= 400 && r.Status < 500 {
			w.counters.InvalidRejectedByGateway.Add(1)
		}
	}

	// hand the result to the flusher; drop the oldest decile is the TS
	// behaviour on overflow — here the channel is bounded and we count the
	// drop rather than stalling the hot path
	select {
	case w.results <- j:
	default:
		w.counters.Dropped.Add(1)
		fire.PutJob(j)
	}
}

// ------- flush loop (owner: worker; exits on done) -------

func (w *Worker) flushLoop() {
	defer close(w.flushDone)
	t := time.NewTicker(FlushInterval)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			w.flush(false)
		case <-w.done:
			w.flush(true)
			return
		}
	}
}

// flush drains the results channel into one NDJSON batch and writes it to
// the results socket. `final` also drains the open shed minute.
func (w *Worker) flush(final bool) {
	shed := w.takeShed(final)
	var results []wire.RequestResult
	var jobs []*fire.Job
	for {
		select {
		case j := <-w.results:
			results = append(results, j.Result)
			jobs = append(jobs, j)
		default:
			goto drained
		}
	}
drained:
	for _, j := range jobs {
		fire.PutJob(j)
	}
	if len(results) == 0 && len(shed) == 0 {
		return
	}
	batch := wire.Batch{
		BatchID: uuidV4(),
		Shed:    shed,
		Results: results,
	}
	// retry: a first failure requeues nothing — batches are not idempotent
	// server-side beyond batchId, and a lost batch is less damaging than a
	// wedged flusher
	if err := w.params.Sink.WriteBatch(&batch); err != nil {
		fmt.Fprintf(os.Stderr, "[worker] results flush failed: %v\n", err)
	}
}

// uuidV4 returns a random UUID v4 string (batch idempotency token).
func uuidV4() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return hex.EncodeToString(b[0:4]) + "-" + hex.EncodeToString(b[4:6]) + "-" +
		hex.EncodeToString(b[6:8]) + "-" + hex.EncodeToString(b[8:10]) + "-" + hex.EncodeToString(b[10:16])
}

// ------- shed accounting (mirrors the TS driver) -------

func (w *Worker) shedBucket(nowMs int64) *wire.LoadShedSample {
	bts := nowMs / 60_000 * 60_000
	b := w.shed[bts]
	if b == nil {
		if len(w.shed) >= MaxShedBuckets {
			// evict the oldest bucket
			oldest := int64(math.MaxInt64)
			for k := range w.shed {
				if k < oldest {
					oldest = k
				}
			}
			delete(w.shed, oldest)
		}
		b = &wire.LoadShedSample{BucketTS: bts}
		w.shed[bts] = b
	}
	return b
}

func (w *Worker) noteTick(nowMs int64, targetRps float64, missed int64) {
	w.shedMu.Lock()
	b := w.shedBucket(nowMs)
	b.TargetSum += targetRps
	b.Ticks++
	if missed > 0 {
		b.Dropped += missed
	}
	w.shedMu.Unlock()
}

func (w *Worker) noteShed(nowMs int64, dropped int64) {
	w.shedMu.Lock()
	w.shedBucket(nowMs).Dropped += dropped
	w.shedMu.Unlock()
}

func (w *Worker) takeShed(final bool) []wire.LoadShedSample {
	open := time.Now().UnixMilli() / 60_000 * 60_000
	w.shedMu.Lock()
	defer w.shedMu.Unlock()
	var out []wire.LoadShedSample
	for ts, s := range w.shed {
		if !final && ts >= open {
			continue
		}
		out = append(out, *s)
		delete(w.shed, ts)
	}
	return out
}

// ------- status loop (owner: worker; exits on done) -------

func (w *Worker) statusLoop() {
	defer close(w.statDone)
	t := time.NewTicker(StatusInterval)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			w.emitStatus()
		case <-w.done:
			return
		}
	}
}

func (w *Worker) emitStatus() {
	w.mu.Lock()
	runID := w.runID
	w.mu.Unlock()
	target, _ := w.targetRps.Load().(float64)
	w.params.Emitter.Status(wire.StatusMsg{
		RunID:                    runID,
		Sent:                     w.counters.Sent.Load(),
		OK:                       w.counters.OK.Load(),
		R4xx:                     w.counters.R4xx.Load(),
		Errors:                   w.counters.Errors.Load(),
		GwFaults:                 w.counters.GwFaults.Load(),
		RateLimited:              w.counters.RateLimited.Load(),
		Unauthorized:             w.counters.Unauthorized.Load(),
		InvalidSent:              w.counters.InvalidSent.Load(),
		InvalidLeaked:            w.counters.InvalidLeaked.Load(),
		InvalidRejectedByGateway: w.counters.InvalidRejectedByGateway.Load(),
		InFlight:                 w.counters.InFlight.Load(),
		TargetRps:                target,
		Dropped:                  w.counters.Dropped.Load(),
	})
}

// Handle dispatches a control message. Called from the wire reader goroutine.
// Returning an error stops the reader; only decoding failures do that.
func (w *Worker) Handle(m wire.Message) error {
	switch m.Op {
	case "configure":
		w.Configure(m.Configure)
	case "start":
		w.Start(m.Start.RunID)
	case "stop":
		w.Stop()
	}
	return nil
}
