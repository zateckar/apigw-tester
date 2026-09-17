package health

import (
	"math"
	"runtime"
	"sync"
	"testing"
	"time"
)

const t0 = int64(1_800_000_000_000) // window-aligned

func TestPercentileReadsBucketUpperEdges(t *testing.T) {
	// Upper edges, so both numbers are upper bounds on the truth. A gate that
	// decides whether to trust a measurement should err towards distrust.
	buckets := []float64{0, 0.001, 0.002, 0.004, 0.008}
	counts := []uint64{90, 5, 4, 1}

	p, max := percentile(buckets, counts, 0.99)
	if p != 4 {
		t.Fatalf("p99: got %v want 4", p)
	}
	if max != 8 {
		t.Fatalf("max: got %v want 8", max)
	}
}

func TestPercentileIsNotTheMaximum(t *testing.T) {
	// The whole point of p99 over max: one unlucky wakeup in a 2s window must
	// not disqualify ten thousand requests that were timed cleanly.
	buckets := []float64{0, 0.0001, 0.001, 1}
	counts := []uint64{9_999, 0, 1}

	p, max := percentile(buckets, counts, 0.99)
	if p != 0.1 {
		t.Fatalf("p99: got %v want 0.1", p)
	}
	if max != 1000 {
		t.Fatalf("max: got %v want 1000", max)
	}
}

func TestPercentileOpenTopBucketReportsItsLowerEdge(t *testing.T) {
	// +Inf is not a number anyone can threshold against
	buckets := []float64{0, 0.001, math.Inf(1)}
	counts := []uint64{99, 1}

	p, max := percentile(buckets, counts, 0.99)
	if p != 1 || max != 1 {
		t.Fatalf("p99=%v max=%v, want 1 and 1", p, max)
	}
}

func TestPercentileOfNothingIsZeroNotAPanic(t *testing.T) {
	buckets := []float64{0, 0.001, 0.002}
	cases := []struct {
		name    string
		buckets []float64
		counts  []uint64
	}{
		{"no samples", buckets, []uint64{0, 0}},
		{"no counts", buckets, nil},
		{"mismatched lengths", buckets, []uint64{1, 2, 3}},
		{"degenerate buckets", []float64{0}, []uint64{1}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if p, max := percentile(c.buckets, c.counts, 0.99); p != 0 || max != 0 {
				t.Fatalf("p=%v max=%v, want zeroes", p, max)
			}
		})
	}
}

// fixedClock returns a clock the test moves by hand, and a pointer to move it.
func fixedClock(startMS int64) (func() time.Time, *time.Time) {
	now := time.UnixMilli(startMS)
	return func() time.Time { return now }, &now
}

func TestFirstSampleIsOnlyABaseline(t *testing.T) {
	// Every number here is a delta off a cumulative counter, and a first reading
	// has nothing to subtract from. Crediting it would charge the window with
	// the whole process lifetime.
	clock, _ := fixedClock(t0)
	s := newWithClock(clock)
	s.Sample()

	if cells := s.DrainAll(); len(cells) != 0 {
		t.Fatalf("baseline reading produced a window: %+v", cells)
	}
}

func TestSamplesLandInTheWindowTheyEndIn(t *testing.T) {
	clock, now := fixedClock(t0)
	s := newWithClock(clock)
	s.Sample() // baseline
	for i := 0; i < 12; i++ {
		*now = now.Add(SampleInterval)
		s.Sample()
	}

	cells := s.DrainAll()
	if len(cells) != 2 {
		t.Fatalf("windows: %+v", cells)
	}
	if cells[0].WindowTS != t0 || cells[1].WindowTS != t0+WindowMS {
		t.Fatalf("window keys: %d %d", cells[0].WindowTS, cells[1].WindowTS)
	}
	// samples ending at +250..+1750 fall in the first window, +2000..+3000 in
	// the second; the one straddling the boundary is credited to where it ended
	if cells[0].Samples != 7 || cells[1].Samples != 5 {
		t.Fatalf("sample counts: %d %d", cells[0].Samples, cells[1].Samples)
	}
	// coverage, so an unobserved window cannot read as a healthy one
	if cells[0].FromTS != t0 || cells[0].ToTS != t0+1750 {
		t.Fatalf("coverage: %+v", cells[0])
	}
}

func TestDrainHoldsTheWindowStillInProgress(t *testing.T) {
	// A window is only judged once it can no longer turn out to contain a stall.
	// The aggregator holds that window's residuals on the same rule, so the two
	// stay in step and a residual never outruns its evidence.
	clock, now := fixedClock(t0)
	s := newWithClock(clock)
	s.Sample()
	for i := 0; i < 12; i++ {
		*now = now.Add(SampleInterval)
		s.Sample()
	}

	cells := s.Drain() // now t0+3000: the second window runs to t0+4000
	if len(cells) != 1 || cells[0].WindowTS != t0 {
		t.Fatalf("drain released an open window: %+v", cells)
	}
	if cells := s.Drain(); len(cells) != 0 {
		t.Fatalf("closed window shipped twice: %+v", cells)
	}

	*now = now.Add(2 * time.Second)
	cells = s.Drain()
	if len(cells) != 1 || cells[0].WindowTS != t0+WindowMS {
		t.Fatalf("window not released once closed: %+v", cells)
	}
}

func TestDrainAtUsesTheCallersClock(t *testing.T) {
	// The worker reads the clock once and hands the same instant to both drains.
	// Two readings straddling a boundary would release residuals whose health
	// cell is still held, and those residuals would be dropped for want of it.
	clock, now := fixedClock(t0)
	s := newWithClock(clock)
	s.Sample()
	*now = now.Add(SampleInterval)
	s.Sample()

	if n := len(s.DrainAt(t0 + WindowMS - 1)); n != 0 {
		t.Fatalf("released before the caller's clock left the window: %d", n)
	}
	if n := len(s.DrainAt(t0 + WindowMS)); n != 1 {
		t.Fatalf("not released once the caller's clock passed the window: %d", n)
	}
}

func TestDrainAllReleasesOpenWindows(t *testing.T) {
	// at shutdown, holding a window back is losing it, not deferring it
	clock, now := fixedClock(t0)
	s := newWithClock(clock)
	s.Sample()
	*now = now.Add(SampleInterval)
	s.Sample()

	if n := len(s.DrainAll()); n != 1 {
		t.Fatalf("open window withheld at shutdown: %d", n)
	}
	if n := len(s.DrainAll()); n != 0 {
		t.Fatalf("window shipped twice: %d", n)
	}
}

func TestSchedulingLatencyIsActuallyObserved(t *testing.T) {
	// If the runtime ever stops exposing /sched/latencies:seconds the sampler
	// keeps working and reports a flat zero — which reads as a perfectly healthy
	// generator and disables the gate without anything failing. This is the test
	// that notices.
	s := New()
	if _, ok := s.idx[schedLatencyMetric]; !ok {
		t.Fatalf("this runtime does not expose %s; the health gate is blind", schedLatencyMetric)
	}
	s.Sample()

	var wg sync.WaitGroup
	for i := 0; i < 500; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			runtime.Gosched()
		}()
	}
	wg.Wait()
	s.Sample()

	cells := s.DrainAll()
	if len(cells) == 0 {
		t.Fatal("no window")
	}
	var max float64
	var goroutines int
	for _, c := range cells {
		if c.SchedMaxMs > max {
			max = c.SchedMaxMs
		}
		if c.Goroutines > goroutines {
			goroutines = c.Goroutines
		}
		if c.CPUPct < 0 || c.CPUPct > 100 {
			t.Fatalf("cpuPct out of range: %v", c.CPUPct)
		}
		if c.SchedP99Ms > c.SchedMaxMs {
			t.Fatalf("p99 above max: %+v", c)
		}
	}
	if max <= 0 {
		t.Fatal("500 goroutines produced no measurable scheduling latency")
	}
	if goroutines <= 0 {
		t.Fatal("goroutine count not reported")
	}
}
