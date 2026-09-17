// Package agg rolls completed results up into the shape the control plane
// stores, so the wire payload stops scaling with the request rate.
//
// Shipping one JSON object per request put the cost of every request on the
// control plane's event loop three times over — parse, health-stamp, structured
// clone into the metrics thread — and the control plane withholds measurements
// precisely when its event loop stalls. At 10k rps that is a rig disqualifying
// its own windows. The worker already visits every result once on its flush
// goroutine; folding them here costs that same visit and ships a few dozen
// cells instead of ten thousand objects.
//
// Residual cells are keyed by health window and held back until that window has
// closed. The verdict on a window is formed from this process's own scheduling
// health (see internal/health) and travels in the same batch, so a residual and
// the evidence about whether to trust it are never separated — and a window is
// never judged while it could still turn out to contain a stall.
package agg

import (
	"sort"
	"time"

	"github.com/apigw-tester/go/internal/hist"
	"github.com/apigw-tester/go/internal/wire"
)

const minuteMS = 60_000

// HealthWindowMS mirrors HEALTH_WINDOW_MS in packages/shared/src/index.ts: the
// cadence the control plane samples local health at, and therefore the finest
// interval a residual can be qualified against.
const HealthWindowMS = 2_000

// TailPerFlush mirrors RAW_TAIL_PER_FLUSH. The recent-requests table shows a
// few hundred rows; everything above this is written, indexed, retained and
// never read.
const TailPerFlush = 200

// Aggregator folds results into cells. Not safe for concurrent use: it is
// owned by the flush goroutine, which is single-threaded by construction, and
// a mutex here would put lock contention on the one path that must not stall.
type Aggregator struct {
	cells     map[cellKey]*wire.AggCell
	residuals map[residualKey]*wire.ResidualCell
	runs      map[runKey]*wire.RunCell
	notable   []wire.RequestResult
	plain     []wire.RequestResult
	nowMS     func() int64
}

type cellKey struct {
	bucketTS int64
	protocol string
	endpoint string
	class    string
}

type residualKey struct {
	windowTS int64
	class    string
	path     string
}

type runKey struct {
	bucketTS int64
	runID    string
}

func New() *Aggregator {
	return NewWithClock(func() int64 { return time.Now().UnixMilli() })
}

// NewWithClock is New with an injectable clock. Residual release depends on
// wall time, so a test that cannot move the clock can only assert on the
// present.
func NewWithClock(nowMS func() int64) *Aggregator {
	return &Aggregator{
		cells:     make(map[cellKey]*wire.AggCell, 64),
		residuals: make(map[residualKey]*wire.ResidualCell, 32),
		runs:      make(map[runKey]*wire.RunCell, 4),
		nowMS:     nowMS,
	}
}

// Add folds one completed request in.
func (a *Aggregator) Add(r *wire.RequestResult) {
	bucketTS := r.TS / minuteMS * minuteMS
	k := cellKey{bucketTS, r.Protocol, r.Endpoint, r.Class}
	c := a.cells[k]
	if c == nil {
		c = &wire.AggCell{
			BucketTS: bucketTS, FirstTS: r.TS, LastTS: r.TS,
			Protocol: r.Protocol, Endpoint: r.Endpoint, Class: r.Class,
			Hist: hist.NewLatency(), StatusHist: hist.NewStatus(),
		}
		a.cells[k] = c
	}

	if r.TS < c.FirstTS {
		c.FirstTS = r.TS
	}
	if r.TS > c.LastTS {
		c.LastTS = r.TS
	}
	c.Count++
	switch {
	case r.Status == 0 || r.Status >= 500:
		c.Errors++
	case r.Status >= 200 && r.Status < 300:
		c.OK2xx++
	}
	if r.Status >= 400 && r.Status < 500 {
		c.Rejected4xx++
		// no X-Server-Ms means the response was manufactured before the backend
		// was reached: this is how "the gateway rejected it" is told apart from
		// "the backend rejected it" for the deliberately-invalid slice
		if !r.ReachedBackend {
			c.Rejected4xxGw++
		}
	}
	if r.ReachedBackend {
		c.ReachedBackend++
	}
	c.LatencySumMs += r.LatencyMs
	if r.LatencyMs > c.MaxLatencyMs {
		c.MaxLatencyMs = r.LatencyMs
	}
	c.BytesReq += r.BytesReq
	c.BytesResp += r.BytesResp
	if r.ConnectMs != nil {
		c.ConnMeasured++
		if !r.ConnReused {
			c.ConnSetups++
			c.ConnSetupSumMs += *r.ConnectMs
		}
	}
	hist.Add(c.Hist, hist.LatencyEdges, r.LatencyMs)
	c.StatusHist[hist.StatusIndex(r.Status)]++

	rk := runKey{bucketTS, r.RunID}
	if run := a.runs[rk]; run != nil {
		run.Count++
	} else {
		a.runs[rk] = &wire.RunCell{BucketTS: bucketTS, RunID: r.RunID, Count: 1}
	}

	// The gateway arm. A request the gateway answered itself carries no backend
	// time to subtract and contributes nothing here — which shows up as a
	// smaller sample count on that arm, not as a silent substitution.
	//
	// Connection acquisition comes off the residual because it is not a cost the
	// gateway imposes per request. Subtracting it is not the estimation the
	// retired measurement did: this is a value observed on this very request,
	// so nothing borrowed from another distribution enters the number.
	if r.TTFBMs != nil && r.ServerMs != nil {
		connect := 0.0
		if r.ConnectMs != nil {
			connect = *r.ConnectMs
		}
		a.addResidual(r.TS, r.Class, "gw", *r.TTFBMs-*r.ServerMs-connect)
	}

	if notable(r) {
		if len(a.notable) < tailReservoir {
			a.notable = append(a.notable, *r)
		}
	} else if len(a.plain) < tailReservoir {
		a.plain = append(a.plain, *r)
	}
}

// tailReservoir bounds how many rows are held as tail candidates per arm. The
// drain keeps at most TailPerFlush of them, so retaining more than a few times
// that would hold a slice proportional to the request rate for no gain — and
// under a flood of errors, "notable" is every row.
//
// The cost of the bound is that a very high-rate flush samples its tail from
// the first 800 of each kind rather than from the whole flush. The tail is a
// display of what is happening, not a measurement; every number that is a
// measurement comes from the cells, which stay exact.
const tailReservoir = 4 * TailPerFlush

// AddDirect folds in one reference observation — the control arm, deliberately
// outside the cells and therefore outside every rate, status and contract
// number this run reports.
func (a *Aggregator) AddDirect(s wire.BaselineSample) {
	a.addResidual(s.TS, s.Class, "direct", s.ResidualMs)
}

func (a *Aggregator) addResidual(ts int64, class, path string, ms float64) {
	windowTS := ts / HealthWindowMS * HealthWindowMS
	k := residualKey{windowTS, class, path}
	b := a.residuals[k]
	if b == nil {
		b = &wire.ResidualCell{WindowTS: windowTS, Class: class, Path: path, Hist: hist.NewResidual()}
		a.residuals[k] = b
	}
	b.Count++
	b.SumMs += ms
	hist.Add(b.Hist, hist.ResidualEdges, ms)
}

// notable marks the rows worth keeping in the tail whatever the rate: anything
// that failed, and the classes rare enough that uniform sampling erases them.
func notable(r *wire.RequestResult) bool {
	if r.Error != nil || r.Status == 0 || r.Status >= 400 {
		return true
	}
	return r.Class != "small-rest" && r.Class != "concurrency"
}

// spread returns take items evenly distributed across items, in order.
func spread(items []wire.RequestResult, take int) []wire.RequestResult {
	if take <= 0 {
		return nil
	}
	if take >= len(items) {
		return items
	}
	out := make([]wire.RequestResult, 0, take)
	for i := 0; i < take; i++ {
		out = append(out, items[i*len(items)/take])
	}
	return out
}

// Empty reports whether anything has been folded in since the last drain.
func (a *Aggregator) Empty() bool {
	return len(a.cells) == 0 && len(a.residuals) == 0
}

// Drain returns everything accumulated and resets. Failures and the rarer
// classes fill the tail first — they are what anyone opens the recent-requests
// table to look at — and ordinary traffic takes whatever is left, so a healthy
// run still shows a timeline.
func (a *Aggregator) Drain(batchID string, shed []wire.LoadShedSample) *wire.AggBatch {
	return a.DrainAt(batchID, shed, a.nowMS())
}

// DrainAt is Drain against a caller-supplied clock reading, so the health
// sampler can be drained against the same instant. Two separate readings can
// straddle a window boundary, releasing residuals whose health cell is still
// held — and those residuals would then be dropped for want of evidence.
func (a *Aggregator) DrainAt(batchID string, shed []wire.LoadShedSample, nowMS int64) *wire.AggBatch {
	return a.drain(batchID, shed, false, nowMS)
}

// DrainAll is Drain without the closed-window rule, for shutdown: holding a
// window back there means losing it rather than qualifying it later.
func (a *Aggregator) DrainAll(batchID string, shed []wire.LoadShedSample) *wire.AggBatch {
	return a.drain(batchID, shed, true, a.nowMS())
}

func (a *Aggregator) drain(batchID string, shed []wire.LoadShedSample, releaseOpen bool, now int64) *wire.AggBatch {
	b := &wire.AggBatch{
		BatchID:   batchID,
		Cells:     make([]wire.AggCell, 0, len(a.cells)),
		Residuals: make([]wire.ResidualCell, 0, len(a.residuals)),
		Runs:      make([]wire.RunCell, 0, len(a.runs)),
		Shed:      shed,
	}
	for _, c := range a.cells {
		b.Cells = append(b.Cells, *c)
	}
	for _, r := range a.runs {
		b.Runs = append(b.Runs, *r)
	}

	// Throughput, status and latency describe what the run delivered and ship
	// immediately. Only residuals wait: they are the one output whose validity
	// depends on how this process was scheduled, and that is not known until
	// the window they belong to has closed.
	held := make(map[residualKey]*wire.ResidualCell, len(a.residuals))
	for k, r := range a.residuals {
		if releaseOpen || r.WindowTS+HealthWindowMS <= now {
			b.Residuals = append(b.Residuals, *r)
		} else {
			held[k] = r
		}
	}

	tail := spread(a.notable, TailPerFlush)
	b.Tail = append(make([]wire.RequestResult, 0, TailPerFlush), tail...)
	b.Tail = append(b.Tail, spread(a.plain, TailPerFlush-len(tail))...)
	sort.Slice(b.Tail, func(i, j int) bool { return b.Tail[i].TS < b.Tail[j].TS })

	a.cells = make(map[cellKey]*wire.AggCell, len(a.cells))
	a.residuals = held
	a.runs = make(map[runKey]*wire.RunCell, len(a.runs))
	a.notable = a.notable[:0]
	a.plain = a.plain[:0]
	return b
}
