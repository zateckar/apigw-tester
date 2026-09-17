package agg

import (
	"testing"

	"github.com/apigw-tester/go/internal/wire"
)

const t0 = int64(1_800_000_000_000) // minute- and window-aligned

// newAgg builds an aggregator whose clock sits well past the fixtures, so every
// residual window is closed and the drain releases it.
//
// The fixtures are stamped at a fixed t0 rather than at the wall clock, which
// means under the real clock their windows either have closed or never will
// depending on the date the tests are run. Every test below is about what goes
// into a cell, not about when it is released; that rule has its own tests.
func newAgg() *Aggregator {
	return NewWithClock(func() int64 { return t0 + 10*minuteMS })
}

func res(over func(*wire.RequestResult)) *wire.RequestResult {
	ttfb, server := 40.0, 10.0
	r := &wire.RequestResult{
		RunID: "r1", RequestID: "abc", TS: t0, Protocol: "rest", Endpoint: "GET /api/pets",
		Class: "small-rest", Method: "GET", Status: 200, LatencyMs: 100,
		TTFBMs: &ttfb, ServerMs: &server, MeasurementVersion: wire.MeasurementVersion,
		BytesReq: 10, BytesResp: 100, ReachedBackend: true,
	}
	if over != nil {
		over(r)
	}
	return r
}

func totalOf(h []int64) int64 {
	var n int64
	for _, v := range h {
		n += v
	}
	return n
}

func TestCellsKeyedByMinuteProtocolEndpointClass(t *testing.T) {
	a := newAgg()
	a.Add(res(nil))
	a.Add(res(func(r *wire.RequestResult) { r.TS = t0 + 10 }))
	a.Add(res(func(r *wire.RequestResult) { r.TS = t0 + 60_000 }))
	a.Add(res(func(r *wire.RequestResult) { r.Protocol = "soap"; r.Class = "soap"; r.Endpoint = "SOAP getPetById" }))

	b := a.Drain("b1", nil)
	if len(b.Cells) != 3 {
		t.Fatalf("cells: %d", len(b.Cells))
	}
	for _, c := range b.Cells {
		if c.BucketTS == t0 && c.Class == "small-rest" {
			if c.Count != 2 || c.FirstTS != t0 || c.LastTS != t0+10 {
				t.Fatalf("cell: %+v", c)
			}
			return
		}
	}
	t.Fatal("no cell for the first minute")
}

func TestCellCountersMatchTheControlPlane(t *testing.T) {
	a := newAgg()
	a.Add(res(func(r *wire.RequestResult) { r.Status = 200; r.LatencyMs = 10 }))
	a.Add(res(func(r *wire.RequestResult) { r.Status = 503; r.LatencyMs = 40; r.ReachedBackend = false }))
	// no X-Server-Ms: the gateway rejected it before the backend was reached
	a.Add(res(func(r *wire.RequestResult) { r.Status = 404; r.LatencyMs = 20; r.ReachedBackend = false }))
	// the backend rejected it
	a.Add(res(func(r *wire.RequestResult) { r.Status = 404; r.LatencyMs = 30 }))

	c := a.Drain("b2", nil).Cells[0]
	if c.Count != 4 || c.OK2xx != 1 || c.Errors != 1 {
		t.Fatalf("counts: %+v", c)
	}
	if c.Rejected4xx != 2 || c.Rejected4xxGw != 1 {
		t.Fatalf("4xx split: %+v", c)
	}
	if c.ReachedBackend != 2 {
		t.Fatalf("reachedBackend: %d", c.ReachedBackend)
	}
	if c.LatencySumMs != 100 || c.MaxLatencyMs != 40 {
		t.Fatalf("latency: %+v", c)
	}
	if totalOf(c.Hist) != 4 || totalOf(c.StatusHist) != 4 {
		t.Fatalf("histograms: %v %v", c.Hist, c.StatusHist)
	}
}

func TestAFailureThatNeverLeftTheGeneratorIsNotTheTargetsError(t *testing.T) {
	// It still counts as issued — the achieved rate must not improve when the
	// generator breaks — but it is not evidence about the gateway, and the old
	// behaviour reported a dial storm as the gateway erroring on two thirds of
	// its traffic.
	a := newAgg()
	a.Add(res(func(r *wire.RequestResult) { r.Status = 0; r.GenFault = true; r.ReachedBackend = false }))
	a.Add(res(func(r *wire.RequestResult) { r.Status = 0; r.ReachedBackend = false })) // really failed at the target
	a.Add(res(func(r *wire.RequestResult) { r.Status = 503; r.ReachedBackend = false }))

	c := a.Drain("g1", nil).Cells[0]
	if c.Count != 3 {
		t.Fatalf("count: %d — an issued request is issued whoever failed it", c.Count)
	}
	if c.Errors != 2 {
		t.Fatalf("errors: %d want 2", c.Errors)
	}
	// nothing is hidden: the status histogram still carries all three
	if totalOf(c.StatusHist) != 3 {
		t.Fatalf("status histogram: %v", c.StatusHist)
	}
}

func TestAGeneratorFaultIsNotCountedAsASuccessEither(t *testing.T) {
	a := newAgg()
	a.Add(res(func(r *wire.RequestResult) { r.Status = 200; r.GenFault = true }))
	c := a.Drain("g2", nil).Cells[0]
	if c.OK2xx != 0 || c.Errors != 0 {
		t.Fatalf("a generator fault landed in a verdict bucket: %+v", c)
	}
}

func TestResidualsAreKeyedByHealthWindow(t *testing.T) {
	// contaminated windows are withheld whole, which cannot be done at the
	// minute grain the other cells use
	a := newAgg()
	a.Add(res(nil))
	a.Add(res(func(r *wire.RequestResult) { r.TS = t0 + HealthWindowMS }))
	a.AddDirect(wire.BaselineSample{TS: t0, Class: "small-rest", ResidualMs: -0.25})

	b := a.Drain("b3", nil)
	gw, direct := 0, 0
	windows := map[int64]bool{}
	for _, r := range b.Residuals {
		switch r.Path {
		case "gw":
			gw++
			windows[r.WindowTS] = true
			if r.SumMs != 30 {
				t.Fatalf("gw residual: %+v", r)
			}
		case "direct":
			direct++
			// negative residuals must survive: clamping them lifts the
			// reference distribution and understates the gateway
			if r.SumMs != -0.25 {
				t.Fatalf("direct residual: %+v", r)
			}
		}
	}
	if gw != 2 || direct != 1 {
		t.Fatalf("arms: gw=%d direct=%d", gw, direct)
	}
	if !windows[t0] || !windows[t0+HealthWindowMS] {
		t.Fatalf("windows: %v", windows)
	}
}

func TestNoResidualWithoutBothClocks(t *testing.T) {
	a := newAgg()
	a.Add(res(func(r *wire.RequestResult) { r.ServerMs = nil })) // gateway answered it
	a.Add(res(func(r *wire.RequestResult) { r.TTFBMs = nil }))   // no headers arrived

	b := a.Drain("b4", nil)
	if len(b.Residuals) != 0 {
		t.Fatalf("residuals: %+v", b.Residuals)
	}
	// but both still count toward throughput and latency — that is what the
	// run delivered
	if b.Cells[0].Count != 2 {
		t.Fatalf("count: %d", b.Cells[0].Count)
	}
}

func TestConnectionSetupComesOffTheResidual(t *testing.T) {
	// A DNS lookup, a TCP handshake and a TLS handshake all sit inside TTFB and
	// none of them is per-request gateway cost. Left in, a gateway would be
	// charged for every connection the pool failed to keep — and the reference
	// arm, running a near-idle pool of its own, pays that on a different
	// schedule entirely, so the difference would land squarely in the Δ.
	a := newAgg()
	connect := 12.0
	a.Add(res(func(r *wire.RequestResult) { r.ConnectMs = &connect; r.ConnReused = false }))

	b := a.Drain("c1", nil)
	if len(b.Residuals) != 1 {
		t.Fatalf("residuals: %+v", b.Residuals)
	}
	// ttfb 40 − server 10 − connect 12
	if got := b.Residuals[0].SumMs; got != 18 {
		t.Fatalf("residual: got %v want 18", got)
	}
	if b.Cells[0].ConnSetups != 1 || b.Cells[0].ConnSetupSumMs != 12 || b.Cells[0].ConnMeasured != 1 {
		t.Fatalf("conn counters: %+v", b.Cells[0])
	}
}

func TestReusedConnectionIsMeasuredButNotCountedAsASetup(t *testing.T) {
	a := newAgg()
	reuse := 0.05 // a pool hit is not free, and the wait is still ours not the gateway's
	a.Add(res(func(r *wire.RequestResult) { r.ConnectMs = &reuse; r.ConnReused = true }))

	b := a.Drain("c2", nil)
	c := b.Cells[0]
	if c.ConnMeasured != 1 || c.ConnSetups != 0 || c.ConnSetupSumMs != 0 {
		t.Fatalf("conn counters: %+v", c)
	}
	if got := b.Residuals[0].SumMs; got != 40-10-0.05 {
		t.Fatalf("residual: got %v", got)
	}
}

func TestUnmeasuredConnectionIsNotTreatedAsZero(t *testing.T) {
	// nil is "this generator cannot see connection events", which must not read
	// as perfect reuse — the share is a fraction of ConnMeasured for that reason
	a := newAgg()
	a.Add(res(func(r *wire.RequestResult) { r.ConnectMs = nil }))

	c := a.Drain("c3", nil).Cells[0]
	if c.ConnMeasured != 0 || c.ConnSetups != 0 {
		t.Fatalf("conn counters: %+v", c)
	}
}

func TestRunCountsAreExact(t *testing.T) {
	// the roll-ups carry no run id, so this is what lets a per-run report say
	// how much of its window was somebody else's traffic
	a := newAgg()
	a.Add(res(nil))
	a.Add(res(func(r *wire.RequestResult) { r.RunID = "other" }))
	a.Add(res(nil))

	got := map[string]int64{}
	for _, r := range a.Drain("b5", nil).Runs {
		got[r.RunID] = r.Count
	}
	if got["r1"] != 2 || got["other"] != 1 {
		t.Fatalf("runs: %v", got)
	}
}

func TestTailIsBoundedAndPrefersWhatIsWorthLookingAt(t *testing.T) {
	a := newAgg()
	for i := 0; i < 5_000; i++ {
		a.Add(res(func(r *wire.RequestResult) { r.TS = t0 + int64(i) }))
	}
	boom := "boom"
	for i := 0; i < 7; i++ {
		a.Add(res(func(r *wire.RequestResult) { r.Status = 500; r.Error = &boom }))
	}
	for i := 0; i < 3; i++ {
		a.Add(res(func(r *wire.RequestResult) { r.Class = "soap" }))
	}

	b := a.Drain("b6", nil)
	if len(b.Tail) != TailPerFlush {
		t.Fatalf("tail: %d", len(b.Tail))
	}
	errs, soap := 0, 0
	for _, r := range b.Tail {
		if r.Status >= 500 {
			errs++
		}
		if r.Class == "soap" {
			soap++
		}
	}
	if errs != 7 || soap != 3 {
		t.Fatalf("notable rows dropped: errs=%d soap=%d", errs, soap)
	}
	for i := 1; i < len(b.Tail); i++ {
		if b.Tail[i].TS < b.Tail[i-1].TS {
			t.Fatal("tail must read as a timeline")
		}
	}
	// every aggregate stays exact regardless of what the tail kept
	var counted int64
	for _, c := range b.Cells {
		counted += c.Count
	}
	if counted != 5_010 {
		t.Fatalf("cells lost requests the tail dropped: %d", counted)
	}
}

func TestTailStaysBoundedUnderAFloodOfFailures(t *testing.T) {
	a := newAgg()
	boom := "boom"
	for i := 0; i < 20_000; i++ {
		a.Add(res(func(r *wire.RequestResult) { r.Status = 500; r.Error = &boom }))
	}
	if n := len(a.Drain("b7", nil).Tail); n != TailPerFlush {
		t.Fatalf("tail: %d", n)
	}
}

func TestDrainResetsSoNothingShipsTwice(t *testing.T) {
	a := newAgg()
	a.Add(res(nil))
	if a.Empty() {
		t.Fatal("aggregator reported empty with a result in it")
	}
	first := a.Drain("b8", nil)
	if !a.Empty() {
		t.Fatal("drain left state behind")
	}
	second := a.Drain("b9", nil)
	if len(second.Cells) != 0 || len(second.Tail) != 0 {
		t.Fatalf("second drain: %+v", second)
	}
	// the first batch must not alias the reset buffers
	if len(first.Cells) != 1 || len(first.Tail) != 1 {
		t.Fatalf("first drain: %+v", first)
	}
}

func TestResidualsWaitForTheirWindowToClose(t *testing.T) {
	// A residual may only ship with the verdict on the window it fell in, and
	// that verdict is not known while the window can still turn out to contain a
	// stall. Everything else ships immediately: throughput and latency describe
	// what the run delivered whatever the generator's scheduling was doing.
	now := t0 + 500
	a := NewWithClock(func() int64 { return now })
	a.Add(res(nil))

	b := a.Drain("w1", nil)
	if len(b.Residuals) != 0 {
		t.Fatalf("shipped a residual from an open window: %+v", b.Residuals)
	}
	if len(b.Cells) != 1 || b.Cells[0].Count != 1 {
		t.Fatalf("held back more than the residual: %+v", b.Cells)
	}

	now = t0 + HealthWindowMS
	b = a.Drain("w2", nil)
	if len(b.Residuals) != 1 || b.Residuals[0].SumMs != 30 {
		t.Fatalf("closed window not released: %+v", b.Residuals)
	}
	if len(b.Cells) != 0 {
		t.Fatal("cells shipped twice")
	}
	if !a.Empty() {
		t.Fatal("released residual left behind")
	}
}

func TestOnlyTheClosedWindowIsReleased(t *testing.T) {
	now := t0 + HealthWindowMS + 500
	a := NewWithClock(func() int64 { return now })
	a.Add(res(nil))                                                        // closed window
	a.Add(res(func(r *wire.RequestResult) { r.TS = t0 + HealthWindowMS })) // open one

	b := a.Drain("w3", nil)
	if len(b.Residuals) != 1 || b.Residuals[0].WindowTS != t0 {
		t.Fatalf("residuals: %+v", b.Residuals)
	}
	if a.Empty() {
		t.Fatal("the open window was released too")
	}
}

func TestDrainAllReleasesOpenWindows(t *testing.T) {
	// at shutdown, holding a window back is not deferring the verdict, it is
	// losing the measurement
	now := t0 + 500
	a := NewWithClock(func() int64 { return now })
	a.Add(res(nil))

	b := a.DrainAll("w4", nil)
	if len(b.Residuals) != 1 {
		t.Fatalf("residuals: %+v", b.Residuals)
	}
	if !a.Empty() {
		t.Fatal("drain-all left state behind")
	}
}

func TestDrainAtUsesTheCallersClock(t *testing.T) {
	// the worker reads the clock once and gives the same instant to the health
	// sampler, so the two cannot disagree about which windows have closed
	a := NewWithClock(func() int64 { t.Fatal("DrainAt read the clock itself"); return 0 })
	a.Add(res(nil))

	if n := len(a.DrainAt("w5", nil, t0+HealthWindowMS-1).Residuals); n != 0 {
		t.Fatalf("released with the caller's clock inside the window: %d", n)
	}
	if n := len(a.DrainAt("w6", nil, t0+HealthWindowMS).Residuals); n != 1 {
		t.Fatalf("not released with the caller's clock past the window: %d", n)
	}
}
