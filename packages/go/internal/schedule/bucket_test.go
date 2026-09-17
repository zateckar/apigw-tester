package schedule

import (
	"testing"

	"github.com/apigw-tester/go/internal/config"
)

func fp(v float64) *float64 { return &v }

func TestConstantBucketMath(t *testing.T) {
	p := &config.LoadProfile{Mode: "constant", RPS: fp(100), MaxConcurrency: 10}
	b := NewTokenBucket()
	// first tick primes the bucket
	if r := b.Tick(1000, p, 0); r.Due != 0 || r.TargetRPS != 100 {
		t.Fatalf("first tick: due=%d target=%v", r.Due, r.TargetRPS)
	}
	// 20ms at 100rps = 2 tokens per tick
	for i := 0; i < 50; i++ {
		r := b.Tick(float64(1020+i*20), p, 0)
		if r.Due != 2 {
			t.Fatalf("tick %d: due=%d, want 2", i, r.Due)
		}
	}
}

func TestBucketBurstClamp(t *testing.T) {
	p := &config.LoadProfile{Mode: "constant", RPS: fp(10), MaxConcurrency: 10}
	b := NewTokenBucket()
	b.Tick(0, p, 0)
	// nothing ticks for 10 seconds: bucket must clamp at 1s worth (10 tokens)
	r := b.Tick(10_000, p, 0)
	if r.Due != 10 {
		t.Fatalf("due=%d, want clamp at 10", r.Due)
	}
	// 9 seconds of untickable load must be reported as missed
	if r.Missed != 90 {
		t.Fatalf("missed=%d, want 90", r.Missed)
	}
}

func TestRampMode(t *testing.T) {
	p := &config.LoadProfile{Mode: "ramp", RampFrom: fp(10), RampTo: fp(110), RampMinutes: fp(1), MaxConcurrency: 10}
	if got := TargetRPSAt(p, 0, 0, nil); got != 10 {
		t.Fatalf("ramp at t=0: %v", got)
	}
	if got := TargetRPSAt(p, 30_000, 0, nil); got != 60 {
		t.Fatalf("ramp at t=30s: %v", got)
	}
	if got := TargetRPSAt(p, 120_000, 0, nil); got != 110 {
		t.Fatalf("ramp clamped: %v", got)
	}
}

func TestSpikeMode(t *testing.T) {
	p := &config.LoadProfile{Mode: "spike", SpikeBase: fp(5), SpikePeak: fp(100), SpikeEveryMinutes: fp(1), SpikeDurationSeconds: fp(10), MaxConcurrency: 10}
	if got := TargetRPSAt(p, 5_000, 0, nil); got != 100 {
		t.Fatalf("inside spike: %v", got)
	}
	if got := TargetRPSAt(p, 15_000, 0, nil); got != 5 {
		t.Fatalf("outside spike: %v", got)
	}
	// second cycle
	if got := TargetRPSAt(p, 62_000, 0, nil); got != 100 {
		t.Fatalf("second spike: %v", got)
	}
}

func TestSineDailyBounds(t *testing.T) {
	p := &config.LoadProfile{Mode: "sine-daily", SineMin: fp(2), SineMax: fp(50), MaxConcurrency: 10}
	for h := 0; h < 24; h++ {
		got := TargetRPSAt(p, float64(h)*3_600_000, 0, nil)
		if got < 1.99 || got > 50.01 {
			t.Fatalf("hour %d out of band: %v", h, got)
		}
	}
}

func TestPeakTargetRPS(t *testing.T) {
	if PeakTargetRPS(&config.LoadProfile{Mode: "constant", RPS: fp(42)}) != 42 {
		t.Fatal("constant peak")
	}
	if PeakTargetRPS(&config.LoadProfile{Mode: "ramp", RampFrom: fp(1), RampTo: fp(9)}) != 9 {
		t.Fatal("ramp peak")
	}
	if PeakTargetRPS(&config.LoadProfile{Mode: "real", RPS: fp(25)}) != 25*1.8*1.2 {
		t.Fatal("real peak")
	}
}
