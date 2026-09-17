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

	"github.com/apigw-tester/go/internal/agg"
	"github.com/apigw-tester/go/internal/config"
	"github.com/apigw-tester/go/internal/fire"
	"github.com/apigw-tester/go/internal/health"
	"github.com/apigw-tester/go/internal/scen"
	"github.com/apigw-tester/go/internal/schedule"
	"github.com/apigw-tester/go/internal/wire"
)

// TickMS is the scheduler cadence, and with it the depth of the burst the
// target sees.
//
// A tick releases the whole interval's worth of requests at one instant — the
// loop in tick() spawns them back to back — so the gateway is offered
// rps×TickMS/1000 arrivals simultaneously and then nothing until the next tick.
// At the old 20ms that was 100 at once at 5k rps and 200 at 10k: an impulse
// train, not an arrival process, and the queueing it caused at the burst front
// was charged to the gateway as latency.
//
// It showed up worst in the overhead measurement. Against a target that was
// literally the SUT, and so had zero true overhead, the reported p50 went
// 0.02ms at 200 rps, 0.24ms at 1k, 2.32ms at 5k. All of it was this.
//
// One millisecond: burst depth falls by 20× at every rate, arrivals are spread
// at the granularity the OS timer can actually honour, and 1000 wakeups a
// second is nothing on a goroutine that is not the one taking measurements.
// The bucket measures real elapsed time, so a late tick is absorbed rather than
// accumulated. The TS driver deliberately runs coarser — see TICK_MS there.
const TickMS = 1

// FlushInterval is the results-batch cadence. One second, so the dashboard's
// open minute is never more than a second stale; the line's size no longer
// depends on it, since a batch carries rolled-up cells rather than one object
// per request.
const FlushInterval = time.Second

// StatusInterval is the op=status cadence. One line of counters per second:
// at ten, a run shorter than the interval finished without ever reporting a
// tally, and the dashboard's live counters lagged the traffic by up to 10s.
const StatusInterval = time.Second

// ResultChanCap bounds the buffered results channel, mirroring MAX_SPOOL.
const ResultChanCap = 65_536

// MaxShedBuckets mirrors MAX_SHED_BUCKETS.
const MaxShedBuckets = 2_000

// DrainTimeout bounds how long stop waits for in-flight requests.
const DrainTimeout = 5 * time.Second

// LatencyAllowanceSec mirrors LATENCY_ALLOWANCE_SEC: the Little's law
// allowance used to *advise* on the concurrency ceiling, not to set it. The
// configured ceiling is honoured; a target rate it cannot sustain shows up as
// shed load, which is reported.
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
	firer   *fire.Firer
	ids     *scen.IDTracker
	reqIDs  *fire.RequestIds

	counters Counters

	// shed accounting per minute bucket (mirrors the TS shed map)
	shedMu sync.Mutex
	shed   map[int64]*wire.LoadShedSample
	// counters.ResultsLost already attributed to a minute bucket; guarded by
	// shedMu so the flush loop and Stop cannot double-count the same loss
	resultsLostSeen int64

	// results channel: jobs completed, awaiting flush. Pointers keep the
	// spool zero-copy; the flusher returns jobs to the pool.
	results chan *fire.Job

	// agg folds drained results into cells. Owned exclusively by the flush
	// goroutine — it has no lock, and adding one would put contention on the
	// path that must never stall.
	agg *agg.Aggregator

	// healthSampler measures whether this process — the one holding the clock —
	// was scheduled well enough for its measurements to be trusted. Owned by
	// the flush goroutine, like agg, and for the same reason.
	healthSampler *health.Sampler

	done      chan struct{} // closed on Shutdown
	stopAll   sync.Once
	flushDone chan struct{}
	statDone  chan struct{}
	wg        sync.WaitGroup // in-flight request goroutines

	// The tick goroutine gets a fresh pair of channels per run and is handed
	// them by value, so a loop that is on its way out cannot be signalled by —
	// or signal the completion of — the run that replaced it.
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
		agg:       agg.New(),
		state:     "idle",
	}
	w.healthSampler = health.New()
	w.reaper = schedule.NewReaper()
	w.clients = fire.NewClients()
	w.ids = scen.NewIDTracker(120)
	w.reqIDs = &fire.RequestIds{}
	w.reqIDs.Reset()
	w.firer = fire.NewFirer(w.clients, w.reaper, w.ids)
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
	w.resultsLostSeen = 0 // counters.Reset zeroed the source above
	w.shedMu.Unlock()

	// The configured ceiling, clamped only by the system limit. See
	// LatencyAllowanceSec: this used to be max(configured, rps*5), which made
	// the operator's ceiling a floor and let a slow target drag thousands of
	// sockets into the generator on a host that could not carry them.
	eff := int64(w.profile.MaxConcurrency)
	if eff > LimitMaxConcurrency {
		eff = LimitMaxConcurrency
	}
	if eff < 1 {
		eff = 1
	}
	w.effectiveMaxConcurrency = int(eff)
	if advised := int64(math.Ceil(schedule.PeakTargetRPS(&w.profile) * LatencyAllowanceSec)); advised > eff {
		fmt.Fprintf(os.Stderr,
			"[worker] maxConcurrency %d may cap throughput below the %.0f rps target: sustaining it needs ~%d in flight at %ds latency\n",
			eff, schedule.PeakTargetRPS(&w.profile), advised, LatencyAllowanceSec)
	}
	w.sem = make(chan struct{}, w.effectiveMaxConcurrency)

	if !w.tickInit {
		w.tickInit = true
		// A run's tick loop closes its done channel on the way out, so the next
		// run needs its own. Reusing it made the second run in a worker process
		// panic on stop — close of a closed channel, which kills the process
		// before Stop's final flush and loses that run's last batch. The stop
		// channel is likewise fresh here: Stop replaced it after closing it.
		w.tickDone = make(chan struct{})
		go w.tickLoop(w.tickStop, w.tickDone)
	}
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
	// the final tally, after the drain: without it the last status is up to
	// StatusInterval stale and a run's closing counters never reach the UI
	w.emitStatus()
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

// tickLoop is handed its own stop/done pair rather than reading the worker's
// fields: Stop replaces tickStop under the mutex while this select is reading
// it, and a loop outliving its run would otherwise race the one that follows.
func (w *Worker) tickLoop(stop, done chan struct{}) {
	defer close(done)
	t := time.NewTicker(TickMS * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			if !w.tick() {
				return
			}
		case <-stop:
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

	// hand the result to the flusher; the channel is bounded and we count the
	// loss rather than stalling the hot path. This is a lost MEASUREMENT of a
	// request the gateway really served, not shed load — and it is biased
	// (the channel fills when results arrive fastest), so it is counted apart
	// from Dropped and surfaced rather than folded into the shed rate.
	select {
	case w.results <- j:
	default:
		w.counters.ResultsLost.Add(1)
		fire.PutJob(j)
	}
}

// ------- flush loop (owner: worker; exits on done) -------

func (w *Worker) flushLoop() {
	defer close(w.flushDone)
	t := time.NewTicker(FlushInterval)
	defer t.Stop()
	// Health is sampled on this goroutine, several times per flush. It has to
	// be this one: the sampler is not concurrency-safe, and this is the only
	// goroutine that touches it.
	h := time.NewTicker(health.SampleInterval)
	defer h.Stop()
	w.healthSampler.Sample() // establish the baseline for the cumulative counters
	for {
		select {
		case <-h.C:
			w.healthSampler.Sample()
		case <-t.C:
			w.flush(false)
		case <-w.done:
			w.healthSampler.Sample()
			w.flush(true)
			return
		}
	}
}

// flush drains the results channel, folds it into one pre-rolled batch and
// writes that to the results socket. `final` also drains the open shed minute.
//
// One batch per flush, not one per N results: the whole point of rolling up
// here is that the line's size is a function of the endpoint and class mix
// rather than of the request rate, so there is nothing left to chunk. Shed
// accounting rides the same line as the requests it covers, so a window can
// never commit issued load without the load it failed to issue.
func (w *Worker) flush(final bool) {
	w.noteResultsLost()
	shed := w.takeShed(final)
	drained := w.drainResults()

	// Health windows are still held until closed, because a verdict on a window
	// that could still contain a stall is not a verdict. Nothing waits on them
	// any more — measurements ship immediately — so a held window delays only
	// the evidence about the generator, never the traffic it ran alongside.
	var cells []wire.HealthCell
	if final {
		cells = w.healthSampler.DrainAll()
	} else {
		cells = w.healthSampler.Drain()
		if drained == 0 && w.agg.Empty() && len(shed) == 0 && len(cells) == 0 {
			return
		}
	}
	batch := w.agg.Drain(uuidV4(), shed)
	// never nil: an absent `health` key means a producer that cannot see itself,
	// which is a different claim from a quiet second
	if cells == nil {
		cells = []wire.HealthCell{}
	}
	batch.Health = cells
	w.writeBatch(batch, drained)
}

// drainResults folds every queued result into the aggregator, returning how
// many there were, and returns each pooled job as it goes. Never blocks: an
// empty channel ends the drain.
//
// Unbounded on purpose. The old cap existed to bound one NDJSON line, and a
// batch of cells has no such relationship to the number of results behind it;
// what bounds this loop is the channel, which the hot path never waits on.
func (w *Worker) drainResults() int {
	n := 0
	// Generator faults are tallied here rather than on the request goroutine:
	// this one is single-threaded, so the whole flush costs one shedMu
	// acquisition instead of one per failure — and they arrive in storms.
	var faults map[int64]int64
	for {
		select {
		case j := <-w.results:
			if j.Result.GenFault {
				if faults == nil {
					faults = make(map[int64]int64, 4)
				}
				faults[j.Result.TS/60_000*60_000]++
			}
			w.agg.Add(&j.Result)
			fire.PutJob(j)
			n++
		default:
			w.noteGenFaults(faults)
			return n
		}
	}
}

// noteGenFaults attributes failures that never reached the target to the
// minutes they happened in, so the window can disown them rather than
// presenting them as the gateway's error rate.
func (w *Worker) noteGenFaults(faults map[int64]int64) {
	if len(faults) == 0 {
		return
	}
	w.shedMu.Lock()
	defer w.shedMu.Unlock()
	for bts, n := range faults {
		w.shedBucket(bts).GenFaults += n
	}
}

// writeBatch ships one batch. A failure requeues nothing — batches are not
// idempotent server-side beyond batchId, and a lost batch is less damaging
// than a wedged flusher — but the loss is counted, never silent. `results` is
// what the cells were rolled from, which is what was actually lost.
func (w *Worker) writeBatch(b *wire.AggBatch, results int) {
	if err := w.params.Sink.WriteBatch(b); err != nil {
		w.counters.ResultsLost.Add(int64(results))
		fmt.Fprintf(os.Stderr, "[worker] results flush failed (%d results lost): %v\n", results, err)
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

// noteResultsLost attributes measurement loss since the last flush to the
// current minute, so the window that lost them can say so rather than
// presenting percentiles over a silently truncated sample. Called from flush,
// which runs every second, so minute attribution is exact except at the
// boundary. shedMu guards resultsLostSeen: Stop flushes from its own
// goroutine while the flush loop may still be running.
func (w *Worker) noteResultsLost() {
	w.shedMu.Lock()
	defer w.shedMu.Unlock()
	lost := w.counters.ResultsLost.Load() - w.resultsLostSeen
	if lost <= 0 {
		return
	}
	w.resultsLostSeen += lost
	w.shedBucket(time.Now().UnixMilli()).ResultsLost += lost
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
		ResultsLost:              w.counters.ResultsLost.Load(),
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
