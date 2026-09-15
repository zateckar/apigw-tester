package schedule

import (
	"math"
	"math/rand/v2"

	"github.com/apigw-tester/worker/internal/config"
)

// LimitRPS mirrors LIMITS.rps in the TS shared package.
const LimitRPS = 10_000

func capRPS(n float64) float64 {
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return 0
	}
	return math.Min(LimitRPS, math.Max(0, n))
}

// RealTrafficShaper holds the slow state for mode "real": a randomised
// day-cycle phase, a mean-reverting noise level, and the last tick time. The
// TokenBucket owns it, mirroring the TS scheduler.
type RealTrafficShaper struct {
	phase      float64
	noiseLevel float64
	lastTickMs float64
	hasTick    bool
}

// NewRealTrafficShaper creates a shaper with a random day-cycle phase.
func NewRealTrafficShaper() *RealTrafficShaper {
	return &RealTrafficShaper{phase: rand.Float64() * 2 * math.Pi, noiseLevel: 1}
}

// TargetRPS advances the drift model and returns the target for this tick,
// mirroring RealTrafficShaper.targetRps in packages/app/src/loadgen/scheduler.ts.
func (s *RealTrafficShaper) TargetRPS(nowMs float64, p *config.LoadProfile) float64 {
	const dayMs = 24 * 60 * 60 * 1000
	dayFrac := math.Mod(math.Mod(nowMs, dayMs)/dayMs+s.phase/(2*math.Pi), 1)
	work := math.Exp(-math.Pow((dayFrac-0.37)/0.09, 2)) +
		0.85*math.Exp(-math.Pow((dayFrac-0.62)/0.10, 2))
	const night = 0.08
	baseUserRps := config.Num(p.RPS, 25)
	curveRps := baseUserRps * (night + (1-night)*math.Min(1.15, work))

	if s.hasTick {
		dtMin := (nowMs - s.lastTickMs) / 60_000
		drift := (1 - s.noiseLevel) * math.Min(1, dtMin/3)
		jump := (rand.Float64() - 0.5) * 0.12 * math.Sqrt(math.Max(dtMin, 0.01))
		s.noiseLevel = math.Max(0.6, math.Min(1.8, s.noiseLevel+drift+jump))
	}
	s.lastTickMs = nowMs
	s.hasTick = true

	jitter := 1 + (rand.Float64()-0.5)*0.4
	return math.Max(0, curveRps*s.noiseLevel*jitter)
}

// TargetRPSAt computes the profile's target rate at a point in time,
// mirroring targetRpsAt in the TS scheduler. shaper may be nil for mode
// "real", in which case the base curve is reported without advancing drift.
func TargetRPSAt(p *config.LoadProfile, nowMs, startedAtMs float64, shaper *RealTrafficShaper) float64 {
	switch p.Mode {
	case "constant", "":
		return capRPS(config.Num(p.RPS, 0))
	case "ramp":
		from := config.Num(p.RampFrom, 1)
		to := config.Num(p.RampTo, 100)
		mins := math.Max(0.1, config.Num(p.RampMinutes, 10))
		elapsed := (nowMs - startedAtMs) / 60_000
		t := math.Min(1, math.Max(0, elapsed/mins))
		return capRPS(from + (to-from)*t)
	case "spike":
		base := config.Num(p.SpikeBase, 5)
		peak := config.Num(p.SpikePeak, 100)
		every := math.Max(0.5, config.Num(p.SpikeEveryMinutes, 10))
		dur := math.Max(1, config.Num(p.SpikeDurationSeconds, 30)) / 60
		pos := math.Mod((nowMs-startedAtMs)/60_000, every)
		if pos < dur {
			return capRPS(peak)
		}
		return capRPS(base)
	case "sine-daily":
		min := config.Num(p.SineMin, 2)
		max := config.Num(p.SineMax, 50)
		const periodMs = 24 * 60 * 60 * 1000
		phase := math.Mod(nowMs, periodMs) / periodMs * 2 * math.Pi
		amp := (max - min) / 2
		center := min + amp
		return capRPS(center + amp*math.Sin(phase-math.Pi/2))
	case "real":
		if shaper != nil {
			return capRPS(shaper.TargetRPS(nowMs, p))
		}
		return capRPS(config.Num(p.RPS, 25))
	default:
		return capRPS(config.Num(p.RPS, 0))
	}
}

// PeakTargetRPS is the highest rate a profile can plausibly target; used to
// size the concurrency ceiling, mirroring peakTargetRps in the TS scheduler.
func PeakTargetRPS(p *config.LoadProfile) float64 {
	switch p.Mode {
	case "constant", "":
		return capRPS(config.Num(p.RPS, 0))
	case "ramp":
		return capRPS(math.Max(config.Num(p.RampFrom, 1), config.Num(p.RampTo, 100)))
	case "spike":
		return capRPS(math.Max(config.Num(p.SpikeBase, 5), config.Num(p.SpikePeak, 100)))
	case "sine-daily":
		return capRPS(math.Max(config.Num(p.SineMin, 2), config.Num(p.SineMax, 50)))
	case "real":
		return capRPS(config.Num(p.RPS, 25) * 1.8 * 1.2)
	default:
		return capRPS(config.Num(p.RPS, 0))
	}
}
