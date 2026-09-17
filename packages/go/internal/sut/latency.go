package sut

import (
	"math"
	"sort"
	"sync"
)

// Simulated backend latency and chaos injection, mirroring
// packages/app/src/petstore/latency.ts.
//
// This is what makes the SUT a stand-in for a real backend rather than a
// null responder: without it every response is sub-millisecond, the gateway's
// own cost dominates the total, and a run cannot distinguish a gateway that
// adds 2ms from one that adds 20ms. The sampled delay is reported back in
// X-Server-Ms, so the driver subtracts the simulation rather than attributing
// it to the gateway.

type Distribution struct {
	Kind     string  `json:"kind"`
	Ms       float64 `json:"ms,omitempty"`
	MinMs    float64 `json:"minMs,omitempty"`
	MaxMs    float64 `json:"maxMs,omitempty"`
	MeanMs   float64 `json:"meanMs,omitempty"`
	StddevMs float64 `json:"stddevMs,omitempty"`
}

type Chaos struct {
	ErrorRatePct   float64 `json:"errorRatePct"`
	TimeoutRatePct float64 `json:"timeoutRatePct"`
}

// DefaultLatencyProfile mirrors DEFAULT_LATENCY_PROFILE exactly. The values are
// not arbitrary: they are wide enough that a percentile actually has a shape to
// it, which is what makes p95/p99 overhead meaningful rather than a constant
// offset on a spike.
func DefaultLatencyProfile() map[string]Distribution {
	return map[string]Distribution{
		"list-pets":   {Kind: "uniform", MinMs: 20, MaxMs: 250},
		"get-pet":     {Kind: "normal", MeanMs: 60, StddevMs: 25},
		"create-pet":  {Kind: "normal", MeanMs: 120, StddevMs: 50},
		"update-pet":  {Kind: "normal", MeanMs: 100, StddevMs: 40},
		"delete-pet":  {Kind: "normal", MeanMs: 80, StddevMs: 30},
		"place-order": {Kind: "uniform", MinMs: 50, MaxMs: 400},
		"get-order":   {Kind: "normal", MeanMs: 55, StddevMs: 20},
		"pet-photo":   {Kind: "uniform", MinMs: 100, MaxMs: 900},
		"soap-ops":    {Kind: "normal", MeanMs: 75, StddevMs: 30},
		"unmapped":    {Kind: "fixed", Ms: 50},
	}
}

func clampDelay(n float64) float64 {
	if math.IsNaN(n) || math.IsInf(n, 0) {
		return 0
	}
	return math.Min(LimitDelayMs, math.Max(0, n))
}

// SampleLatency draws a delay in ms, always finite and within [0, LimitDelayMs].
func SampleLatency(d Distribution, rand func() float64) float64 {
	switch d.Kind {
	case "fixed":
		return clampDelay(d.Ms)
	case "uniform":
		lo, hi := math.Min(d.MinMs, d.MaxMs), math.Max(d.MinMs, d.MaxMs)
		return clampDelay(lo + rand()*(hi-lo))
	case "normal":
		// Box-Muller, with u1 floored so log() stays finite
		u1 := math.Max(rand(), 1e-9)
		u2 := rand()
		z := math.Sqrt(-2*math.Log(u1)) * math.Cos(2*math.Pi*u2)
		return clampDelay(d.MeanMs + z*d.StddevMs)
	default:
		return 0 // future kinds default to no delay
	}
}

// DecideChaos returns "ok", "error" or "timeout".
func DecideChaos(c Chaos, rand func() float64) string {
	r := rand() * 100
	if r < c.ErrorRatePct {
		return "error"
	}
	if r < c.ErrorRatePct+c.TimeoutRatePct {
		return "timeout"
	}
	return "ok"
}

// Profile holds the mutable latency profile and chaos settings.
//
// The TS original could hold these in plain closures because one event loop
// meant one writer. Here an operator PATCHing the profile races every in-flight
// request, so reads take the shared lock and writes take it exclusively.
type Profile struct {
	mu      sync.RWMutex
	latency map[string]Distribution
	chaos   Chaos
}

func NewProfile() *Profile {
	return &Profile{latency: DefaultLatencyProfile()}
}

// For returns the distribution for an endpoint key, falling back to "unmapped"
// and then to a fixed 50ms, exactly as the TS lookup chain did.
func (p *Profile) For(key string) Distribution {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if d, ok := p.latency[key]; ok {
		return d
	}
	if d, ok := p.latency["unmapped"]; ok {
		return d
	}
	return Distribution{Kind: "fixed", Ms: 50}
}

func (p *Profile) Latency() map[string]Distribution {
	p.mu.RLock()
	defer p.mu.RUnlock()
	out := make(map[string]Distribution, len(p.latency))
	for k, v := range p.latency {
		out[k] = v
	}
	return out
}

// Patch merges validated overrides, the way Object.assign did.
func (p *Profile) Patch(in map[string]Distribution) map[string]Distribution {
	p.mu.Lock()
	for k, v := range in {
		p.latency[k] = v
	}
	out := make(map[string]Distribution, len(p.latency))
	for k, v := range p.latency {
		out[k] = v
	}
	p.mu.Unlock()
	return out
}

func (p *Profile) Chaos() Chaos {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.chaos
}

func (p *Profile) SetChaos(c Chaos) Chaos {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.chaos = c
	return p.chaos
}

// ValidateDistribution checks one distribution from operator input. It rejects
// the string-meanMs class of mistake that used to become setTimeout(NaN).
func ValidateDistribution(v any) (Distribution, string) {
	m, ok := asObject(v)
	if !ok {
		return Distribution{}, "must be an object"
	}
	bound := func(n float64) float64 { return math.Min(LimitDelayMs, math.Max(0, n)) }
	num := func(key string) (float64, bool) {
		f, isNum := m[key].(float64)
		if isNum && !math.IsNaN(f) && !math.IsInf(f, 0) {
			return f, true
		}
		return 0, false
	}
	switch m["kind"] {
	case "fixed":
		ms, ok := num("ms")
		if !ok {
			return Distribution{}, "fixed.ms must be a number"
		}
		return Distribution{Kind: "fixed", Ms: bound(ms)}, ""
	case "uniform":
		lo, okLo := num("minMs")
		hi, okHi := num("maxMs")
		if !okLo || !okHi {
			return Distribution{}, "uniform.minMs and uniform.maxMs must be numbers"
		}
		return Distribution{Kind: "uniform", MinMs: bound(math.Min(lo, hi)), MaxMs: bound(math.Max(lo, hi))}, ""
	case "normal":
		mean, okMean := num("meanMs")
		sd, okSd := num("stddevMs")
		if !okMean || !okSd {
			return Distribution{}, "normal.meanMs and normal.stddevMs must be numbers"
		}
		return Distribution{Kind: "normal", MeanMs: bound(mean), StddevMs: bound(math.Abs(sd))}, ""
	default:
		return Distribution{}, "kind must be one of fixed|uniform|normal"
	}
}

// ValidateLatencyPatch checks a PATCH /admin/latency-profile body.
//
// Key iteration is sorted so a body with several bad entries always names the
// same one: Go map order is randomised per run, and an error message that moves
// between identical requests is not a contract.
func ValidateLatencyPatch(body any) (map[string]Distribution, string) {
	m, ok := asObject(body)
	if !ok {
		return nil, "body must be an object keyed by endpoint"
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	out := make(map[string]Distribution, len(m))
	for _, k := range keys {
		// Go has no prototype to poison, but the key is rejected anyway: the
		// profile is echoed back to a JS dashboard that does have one
		if k == "__proto__" || k == "constructor" || k == "prototype" {
			return nil, "illegal endpoint key '" + k + "'"
		}
		d, err := ValidateDistribution(m[k])
		if err != "" {
			return nil, k + ": " + err
		}
		out[k] = d
	}
	return out, ""
}

// SanitizeChaos clamps operator input to [0,100], treating anything unparseable
// as zero — the TS `pct()` helper.
func SanitizeChaos(body any) Chaos {
	m, ok := asObject(body)
	if !ok {
		return Chaos{}
	}
	pct := func(key string) float64 {
		f, isNum := m[key].(float64)
		if !isNum || math.IsNaN(f) || math.IsInf(f, 0) {
			return 0
		}
		return math.Max(0, math.Min(100, f))
	}
	return Chaos{ErrorRatePct: pct("errorRatePct"), TimeoutRatePct: pct("timeoutRatePct")}
}
