package schedule

import (
	"math"

	"github.com/apigw-tester/worker/internal/config"
)

// TickResult is what one scheduler tick yields: how many requests to issue
// now, the current target rate, and how much load was shed to the 1s bucket
// clamp (mirroring missed in the TS TokenBucket).
type TickResult struct {
	Due       int
	Missed    int
	TargetRPS float64
}

// TokenBucket is the per-run RPS scheduler: same math as the TS TokenBucket
// in packages/app/src/loadgen/scheduler.ts, with a burst allowance of one
// second of the current target rate.
type TokenBucket struct {
	tokens  float64
	lastMs  float64
	hasTick bool
	shaper  *RealTrafficShaper
}

// NewTokenBucket returns an empty bucket with its own real-traffic shaper.
func NewTokenBucket() *TokenBucket {
	return &TokenBucket{shaper: NewRealTrafficShaper()}
}

// Tick advances the bucket to nowMs against profile p started at startedAtMs.
func (b *TokenBucket) Tick(nowMs float64, p *config.LoadProfile, startedAtMs float64) TickResult {
	target := TargetRPSAt(p, nowMs, startedAtMs, b.shaper)
	if !b.hasTick {
		b.lastMs = nowMs
		b.hasTick = true
		return TickResult{TargetRPS: target}
	}
	dtSec := math.Max(0, (nowMs-b.lastMs)/1000)
	b.lastMs = nowMs
	available := b.tokens + dtSec*target
	missed := int(math.Floor(math.Max(0, available-target)))
	b.tokens = math.Min(target, available)
	due := int(math.Floor(b.tokens))
	b.tokens -= float64(due)
	if target == 0 {
		b.tokens = 0
	}
	return TickResult{Due: due, Missed: missed, TargetRPS: target}
}
