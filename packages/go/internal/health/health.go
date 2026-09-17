// Package health measures whether this process — the one that actually times
// the requests — was well enough for its measurements to be trusted.
//
// The control plane used to answer that question about itself, by watching its
// own event loop. That made sense when the JS driver did the timing. It does
// not any more: with the Go backend every latency, TTFB and server-time is
// stamped inside this process, and the control plane only receives pre-rolled
// batches once a second. Its loop delay says nothing about whether those
// numbers are good — and once the petstore moved out too, the control plane
// went idle enough that its loop-delay probe was reporting the host's timer
// granularity rather than any property of the measurement. On one Windows host
// a Bun process containing no application at all reports ~20ms of "stall",
// against a 10ms limit.
//
// So the verdict moves to where the clock is. The signal is goroutine
// scheduling latency: the time a goroutine sat runnable before a P picked it
// up. That is exactly the error term that corrupts a measurement here — a
// response arrives, its goroutine is ready to read the clock, and anything
// between those two events is added to the request's measured TTFB without
// being added to the SUT's self-reported server time. It therefore lands whole
// inside the residual and reads as gateway overhead that never happened.
//
// Two deliberate choices, both learned from the metric this replaces:
//
//   - p99 of the distribution, not the maximum. A max over a 2s window is one
//     unlucky wakeup, and thresholding it disqualifies windows for events that
//     touched a single request out of ten thousand.
//   - accumulated across the whole window before the percentile is taken,
//     rather than a percentile per sample and a max over those. The window's
//     p99 is a statement about the window.
package health

import (
	"math"
	"runtime/metrics"
	"sort"
	"time"

	"github.com/apigw-tester/go/internal/wire"
)

// SampleInterval is how often the runtime is read. Eight samples per health
// window: fine enough that a window's coverage is known precisely, coarse
// enough that the sampler is not itself a source of scheduling pressure.
const SampleInterval = 250 * time.Millisecond

// WindowMS must match HEALTH_WINDOW_MS in packages/shared. Residual cells are
// keyed by it, and a verdict keyed differently could not be applied to them.
const WindowMS = 2_000

const (
	schedLatencyMetric = "/sched/latencies:seconds"
	goroutinesMetric   = "/sched/goroutines:goroutines"
	cpuTotalMetric     = "/cpu/classes/total:cpu-seconds"
	cpuIdleMetric      = "/cpu/classes/idle:cpu-seconds"
)

type windowAcc struct {
	fromTS, toTS int64
	samples      int
	counts       []uint64
	cpuBusy      float64
	cpuTotal     float64
	goroutines   int
}

// Sampler reads the runtime on a fixed cadence and rolls the readings into
// health windows. It is not safe for concurrent use; the worker drives it from
// its flush goroutine and samples from the same one.
type Sampler struct {
	samples []metrics.Sample
	idx     map[string]int

	buckets []float64
	prev    []uint64
	prevOK  bool

	prevCPUTotal float64
	prevCPUIdle  float64
	prevCPUOK    bool

	lastTS int64
	open   map[int64]*windowAcc

	now func() time.Time
}

// New builds a Sampler, reading whichever of the metrics this runtime exposes.
// A metric the runtime does not have leaves its field zero rather than failing:
// a worker that cannot measure its own scheduling is still a worker, and the
// control plane distinguishes "no evidence" from "evidence of health" by the
// sample count.
func New() *Sampler {
	return newWithClock(time.Now)
}

func newWithClock(now func() time.Time) *Sampler {
	want := []string{schedLatencyMetric, goroutinesMetric, cpuTotalMetric, cpuIdleMetric}
	supported := map[string]bool{}
	for _, d := range metrics.All() {
		supported[d.Name] = true
	}
	s := &Sampler{idx: map[string]int{}, open: map[int64]*windowAcc{}, now: now}
	for _, name := range want {
		if !supported[name] {
			continue
		}
		s.idx[name] = len(s.samples)
		s.samples = append(s.samples, metrics.Sample{Name: name})
	}
	return s
}

func (s *Sampler) value(name string) (metrics.Value, bool) {
	i, ok := s.idx[name]
	if !ok {
		return metrics.Value{}, false
	}
	return s.samples[i].Value, true
}

// Sample reads the runtime once and folds the reading into its health window.
//
// The first call establishes the baseline for the cumulative counters and
// contributes nothing: every number here is a delta, and a first reading has
// nothing to subtract from.
func (s *Sampler) Sample() {
	if len(s.samples) == 0 {
		return
	}
	metrics.Read(s.samples)
	nowMS := s.now().UnixMilli()

	var counts []uint64
	if v, ok := s.value(schedLatencyMetric); ok && v.Kind() == metrics.KindFloat64Histogram {
		h := v.Float64Histogram()
		if s.buckets == nil {
			// the runtime may reuse the returned slices between reads
			s.buckets = append([]float64(nil), h.Buckets...)
		}
		if s.prevOK && len(h.Counts) == len(s.prev) {
			counts = make([]uint64, len(h.Counts))
			for i, c := range h.Counts {
				if c >= s.prev[i] {
					counts[i] = c - s.prev[i]
				}
			}
		}
		s.prev = append(s.prev[:0], h.Counts...)
		s.prevOK = true
	}

	var cpuBusy, cpuTotal float64
	total, okTotal := s.float64(cpuTotalMetric)
	idle, okIdle := s.float64(cpuIdleMetric)
	if okTotal && okIdle {
		if s.prevCPUOK {
			dTotal := total - s.prevCPUTotal
			dIdle := idle - s.prevCPUIdle
			if dTotal > 0 {
				cpuTotal = dTotal
				cpuBusy = math.Max(0, dTotal-dIdle)
			}
		}
		s.prevCPUTotal, s.prevCPUIdle, s.prevCPUOK = total, idle, true
	}

	goroutines := 0
	if v, ok := s.value(goroutinesMetric); ok && v.Kind() == metrics.KindUint64 {
		goroutines = int(v.Uint64())
	}

	from := s.lastTS
	s.lastTS = nowMS
	if from == 0 {
		return // baseline reading
	}

	// A sample straddling a window boundary is credited to the window it ended
	// in. Splitting the histogram proportionally would be false precision: the
	// counts carry no timestamps.
	w := (nowMS / WindowMS) * WindowMS
	acc := s.open[w]
	if acc == nil {
		acc = &windowAcc{fromTS: from}
		s.open[w] = acc
	}
	if from < acc.fromTS {
		acc.fromTS = from
	}
	if nowMS > acc.toTS {
		acc.toTS = nowMS
	}
	acc.samples++
	acc.cpuBusy += cpuBusy
	acc.cpuTotal += cpuTotal
	if goroutines > acc.goroutines {
		acc.goroutines = goroutines
	}
	if counts != nil {
		if acc.counts == nil {
			acc.counts = make([]uint64, len(counts))
		}
		if len(acc.counts) == len(counts) {
			for i, c := range counts {
				acc.counts[i] += c
			}
		}
	}
}

func (s *Sampler) float64(name string) (float64, bool) {
	v, ok := s.value(name)
	if !ok || v.Kind() != metrics.KindFloat64 {
		return 0, false
	}
	return v.Float64(), true
}

// Drain returns the windows that have closed, oldest first, and forgets them.
//
// A window is closed once the clock has moved past its end: still-open windows
// are held back so the control plane is never handed a verdict on a window that
// could still turn out to contain a stall. The residual cells for that window
// are held by the aggregator on the same rule, so the two stay in step.
func (s *Sampler) Drain() []wire.HealthCell {
	return s.DrainAt(s.now().UnixMilli())
}

// DrainAt is Drain against a caller-supplied clock reading. The worker passes
// the same instant to the aggregator, so the two cannot disagree about whether
// a window has closed — a window released by one and held by the other would
// strand residuals with no evidence to qualify them, and they would be dropped.
func (s *Sampler) DrainAt(nowMS int64) []wire.HealthCell {
	var out []wire.HealthCell
	for w, acc := range s.open {
		if w+WindowMS > nowMS {
			continue
		}
		out = append(out, s.cell(w, acc))
		delete(s.open, w)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].WindowTS < out[j].WindowTS })
	return out
}

// DrainAll returns every window including those still open. Used at shutdown,
// where holding a window back means losing it.
func (s *Sampler) DrainAll() []wire.HealthCell {
	var out []wire.HealthCell
	for w, acc := range s.open {
		out = append(out, s.cell(w, acc))
		delete(s.open, w)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].WindowTS < out[j].WindowTS })
	return out
}

func (s *Sampler) cell(w int64, acc *windowAcc) wire.HealthCell {
	c := wire.HealthCell{
		WindowTS:   w,
		FromTS:     acc.fromTS,
		ToTS:       acc.toTS,
		Samples:    acc.samples,
		Goroutines: acc.goroutines,
	}
	if acc.cpuTotal > 0 {
		c.CPUPct = 100 * acc.cpuBusy / acc.cpuTotal
	}
	c.SchedP99Ms, c.SchedMaxMs = percentile(s.buckets, acc.counts, 0.99)
	return c
}

// percentile reads the q-quantile and the top of the highest occupied bucket
// out of a histogram, both in milliseconds.
//
// Bucket upper edges are used, so both numbers are upper bounds on the truth —
// the conservative direction for a gate that decides whether to trust a
// measurement. An open-topped highest bucket reports its lower edge, since
// +Inf is not a number anyone can act on.
func percentile(buckets []float64, counts []uint64, q float64) (p, max float64) {
	if len(buckets) < 2 || len(counts) == 0 || len(counts) != len(buckets)-1 {
		return 0, 0
	}
	var total uint64
	for _, c := range counts {
		total += c
	}
	if total == 0 {
		return 0, 0
	}

	edge := func(i int) float64 {
		hi := buckets[i+1]
		if math.IsInf(hi, 1) {
			hi = buckets[i]
		}
		if math.IsInf(hi, -1) || math.IsNaN(hi) {
			return 0
		}
		return hi * 1000 // seconds to milliseconds
	}

	for i := len(counts) - 1; i >= 0; i-- {
		if counts[i] > 0 {
			max = edge(i)
			break
		}
	}

	target := uint64(math.Ceil(q * float64(total)))
	if target == 0 {
		target = 1
	}
	var seen uint64
	for i, c := range counts {
		seen += c
		if seen >= target {
			return edge(i), max
		}
	}
	return max, max
}
