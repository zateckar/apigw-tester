package hist

import "testing"

// These tables are a second implementation of the ones in
// packages/shared/src/index.ts. The control plane compares the two at handshake
// and refuses a worker that disagrees, so a drift is caught before anything is
// written — but only at runtime, and only on a machine that has both sides. The
// assertions here pin the values so the same drift fails in Go's own CI, where
// the TypeScript is not around to be compared against.

func TestLatencyEdgesMatchShared(t *testing.T) {
	if len(LatencyEdges) != 40 {
		t.Fatalf("latency edges: %d", len(LatencyEdges))
	}
	// buildEdges() rounds 1.35^n and forces a gap where rounding collides, so
	// the low end walks 1..8 one at a time before the ratio takes over
	want := map[int]float64{
		0: 1, 1: 2, 5: 6, 7: 8, 8: 11, 9: 15, 10: 20,
		20: 404, 30: 8129, 39: 121065,
	}
	for i, w := range want {
		if LatencyEdges[i] != w {
			t.Fatalf("latency edge %d: got %v want %v", i, LatencyEdges[i], w)
		}
	}
	for i := 1; i < len(LatencyEdges); i++ {
		if LatencyEdges[i] <= LatencyEdges[i-1] {
			t.Fatalf("latency edges not strictly increasing at %d: %v", i, LatencyEdges[i-1:i+1])
		}
	}
}

func TestResidualEdgesMatchShared(t *testing.T) {
	// the signed low end is what keeps the reference distribution unbiased
	// instead of floored at zero
	head := []float64{-100, -30, -10, -3, -1, -0.5, -0.2, -0.1, -0.05, 0}
	for i, w := range head {
		if ResidualEdges[i] != w {
			t.Fatalf("residual edge %d: got %v want %v", i, ResidualEdges[i], w)
		}
	}
	// positive side: 20 µs upward at ratio 1.3, each rounded to 4 significant
	// digits exactly as Number(v.toPrecision(4)) does
	pos := []float64{0.02, 0.026, 0.0338, 0.04394, 0.05712, 0.07426}
	for i, w := range pos {
		if ResidualEdges[len(head)+i] != w {
			t.Fatalf("residual edge %d: got %v want %v", len(head)+i, ResidualEdges[len(head)+i], w)
		}
	}
	if len(ResidualEdges) != 67 {
		t.Fatalf("residual edges: %d", len(ResidualEdges))
	}
	if last := ResidualEdges[66]; last != 48070 {
		t.Fatalf("residual table ends at %v, want 48070", last)
	}
	for i := 1; i < len(ResidualEdges); i++ {
		if ResidualEdges[i] <= ResidualEdges[i-1] {
			t.Fatalf("residual edges not strictly increasing at %d: %v", i, ResidualEdges[i-1:i+1])
		}
	}
}

func TestStatusIndexMatchesShared(t *testing.T) {
	cases := map[int]string{
		0: "net", 100: "1xx", 200: "2xx", 301: "3xx",
		400: "400", 401: "401", 403: "403", 404: "404", 405: "405",
		408: "408", 413: "413", 429: "429", 418: "4xx",
		500: "500", 502: "502", 503: "503", 504: "504", 599: "5xx",
	}
	for status, want := range cases {
		if got := StatusBuckets[StatusIndex(status)]; got != want {
			t.Fatalf("status %d: got %q want %q", status, got, want)
		}
	}
}

func TestIndexPutsNegativesBelowZero(t *testing.T) {
	// a residual histogram that folded negatives into the first positive bucket
	// would read every sub-resolution gateway as costing 0–20 µs
	zero := Index(ResidualEdges, 0)
	if Index(ResidualEdges, -0.3) >= zero {
		t.Fatal("negative residual did not land below the zero edge")
	}
	if Index(ResidualEdges, 0.03) <= zero {
		t.Fatal("positive residual did not land above the zero edge")
	}
	// overflow slot
	if Index(ResidualEdges, 1e9) != len(ResidualEdges) {
		t.Fatal("an out-of-range residual must land in the overflow slot")
	}
}
