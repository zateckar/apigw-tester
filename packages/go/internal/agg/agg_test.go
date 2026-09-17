package agg

import (
	"testing"

	"github.com/apigw-tester/go/internal/wire"
)

const t0 = int64(1_800_000_000_000) // minute-aligned

func newAgg() *Aggregator { return New() }

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

func TestNonBackendTimeLandsInTheSameCellAsEverythingElse(t *testing.T) {
	// Being a column on the cell rather than a table of its own is the whole
	// point: it is then readable per endpoint, per class and per minute at any
	// percentile, off the same rows the latency numbers come from.
	a := newAgg()
	a.Add(res(nil))
	a.Add(res(func(r *wire.RequestResult) { r.Class = "soap"; r.Protocol = "soap"; r.Endpoint = "SOAP getPetById" }))

	b := a.Drain("b3", nil)
	if len(b.Cells) != 2 {
		t.Fatalf("cells: %d", len(b.Cells))
	}
	for _, c := range b.Cells {
		if c.NonBackendCount != 1 || c.NonBackendSumMs != 30 { // ttfb 40 − server 10
			t.Fatalf("non-backend on %s: %+v", c.Class, c)
		}
		if totalOf(c.NonBackendHist) != 1 {
			t.Fatalf("histogram on %s: %v", c.Class, c.NonBackendHist)
		}
	}
}

func TestNegativeNonBackendTimeSurvives(t *testing.T) {
	// The two clocks are read at different layers, so a fast local hop
	// legitimately lands below zero. Flooring those at zero shifts every
	// percentile above them up by exactly that amount.
	a := newAgg()
	ttfb, server := 9.75, 10.0
	a.Add(res(func(r *wire.RequestResult) { r.TTFBMs = &ttfb; r.ServerMs = &server }))

	c := a.Drain("b3n", nil).Cells[0]
	if c.NonBackendCount != 1 || c.NonBackendSumMs != -0.25 {
		t.Fatalf("non-backend: %+v", c)
	}
	if totalOf(c.NonBackendHist) != 1 {
		t.Fatalf("negative value fell out of the histogram: %v", c.NonBackendHist)
	}
}

func TestNoNonBackendTimeWithoutBothClocks(t *testing.T) {
	a := newAgg()
	a.Add(res(func(r *wire.RequestResult) { r.ServerMs = nil })) // gateway answered it
	a.Add(res(func(r *wire.RequestResult) { r.TTFBMs = nil }))   // no headers arrived

	c := a.Drain("b4", nil).Cells[0]
	if c.NonBackendCount != 0 || c.NonBackendSumMs != 0 {
		t.Fatalf("measured what it could not see: %+v", c)
	}
	// but both still count toward throughput and latency — that is what the
	// run delivered
	if c.Count != 2 {
		t.Fatalf("count: %d", c.Count)
	}
}

func TestConnectionSetupComesOffNonBackendTime(t *testing.T) {
	// A DNS lookup, a TCP handshake and a TLS handshake all sit inside TTFB and
	// none of them is per-request gateway cost. Left in, a gateway would be
	// charged for every connection the pool failed to keep — a cost that is
	// real but belongs in ConnSetups, where it can be read on its own.
	a := newAgg()
	connect := 12.0
	a.Add(res(func(r *wire.RequestResult) { r.ConnectMs = &connect; r.ConnReused = false }))

	c := a.Drain("c1", nil).Cells[0]
	// ttfb 40 − server 10 − connect 12
	if c.NonBackendCount != 1 || c.NonBackendSumMs != 18 {
		t.Fatalf("non-backend: %+v", c)
	}
	if c.ConnSetups != 1 || c.ConnSetupSumMs != 12 || c.ConnMeasured != 1 {
		t.Fatalf("conn counters: %+v", c)
	}
}

func TestReusedConnectionIsMeasuredButNotCountedAsASetup(t *testing.T) {
	a := newAgg()
	reuse := 0.05 // a pool hit is not free, and the wait is still ours not the gateway's
	a.Add(res(func(r *wire.RequestResult) { r.ConnectMs = &reuse; r.ConnReused = true }))

	c := a.Drain("c2", nil).Cells[0]
	if c.ConnMeasured != 1 || c.ConnSetups != 0 || c.ConnSetupSumMs != 0 {
		t.Fatalf("conn counters: %+v", c)
	}
	if c.NonBackendSumMs != 40-10-0.05 {
		t.Fatalf("non-backend: %v", c.NonBackendSumMs)
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

func TestNothingIsHeldBackAcrossADrain(t *testing.T) {
	// Residual cells used to wait here until their health window closed, so the
	// control plane could drop the ones taken while the process was stalled.
	// Nothing waits now: a measurement the operator cannot see is a measurement
	// they cannot ask about, and the filter it was waiting for is gone.
	a := newAgg()
	a.Add(res(nil))

	b := a.Drain("w1", nil)
	if len(b.Cells) != 1 || b.Cells[0].NonBackendCount != 1 {
		t.Fatalf("held a measurement back: %+v", b.Cells)
	}
	if !a.Empty() {
		t.Fatal("drain left state behind")
	}
}
