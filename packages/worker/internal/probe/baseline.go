// Package probe periodically measures direct-to-SUT per-class baselines so
// the control plane can compute gateway overhead per request.
package probe

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptrace"
	"strconv"
	"sync"
	"time"

	"github.com/apigw-tester/worker/internal/fire"
	"github.com/apigw-tester/worker/internal/scen"
)

// Interval is the baseline probe cadence, mirroring BASELINE_PROBE_MS in the
// TS driver.
const Interval = 120 * time.Second

// SamplesPerClass bounds the rolling window.
const SamplesPerClass = 8

// ProbeTimeout mirrors BASELINE_PROBE_TIMEOUT_MS.
const ProbeTimeout = 15 * time.Second

// Snapshot is published to the control plane via {"op":"baseline"}: per-class
// rolling windows and the last probe timestamp per class (epoch ms).
type Snapshot struct {
	At      map[string]int64     `json:"at"`
	ByClass map[string][]float64 `json:"byClass"`
}

// Baseline is the output of a probe cycle; UpdateBaseliner consumes it.
type Baseliner interface {
	// Sample returns the current median-less rolling window median for class.
	Sample(class string) float64
}

// Params controls a Prober.
type Params struct {
	// URL is the direct baseline origin, e.g. "http://127.0.0.1:8080".
	URL string
	// AuthHeader is the full "Basic base64" header or "" — probes hit the
	// SUT directly, which requires it when auth is on.
	AuthHeader string
	// Client is the HTTP client used for probes (its own transport, so the
	// probe never shares a socket pool with the load path).
	Client *http.Client
	// Publish broadcasts a refreshed snapshot; nil drops it.
	Publish func(Snapshot)
}

// Prober runs the 120s baseline cycle on one goroutine it owns.
//
// Owner: the worker creates and Stops it. The goroutine exits when Stop is
// called or the cycle is done and no restart is requested.
type Prober struct {
	params Params

	mu      sync.Mutex
	window  map[string][]float64
	at      map[string]int64
	ids     *scen.IDTracker
	stop    chan struct{}
	done    chan struct{}
	running bool
	probeMu sync.Mutex // re-entrancy guard, mirroring TS probing flag
}

// NewProber creates a prober; call Start to launch the cycle goroutine.
func NewProber(p Params, ids *scen.IDTracker) *Prober {
	if p.Client == nil {
		p.Client = &http.Client{Transport: fire.NewTransport()}
	}
	return &Prober{
		params: p,
		window: map[string][]float64{},
		at:     map[string]int64{},
		ids:    ids,
		stop:   make(chan struct{}),
		done:   make(chan struct{}),
	}
}

// Configure swaps the probe target; safe to call anytime.
func (p *Prober) Configure(url, auth string) {
	p.mu.Lock()
	p.params.URL = url
	p.params.AuthHeader = auth
	p.mu.Unlock()
}

// Start launches the probe goroutine. Idempotent.
func (p *Prober) Start() {
	p.mu.Lock()
	if p.running {
		p.mu.Unlock()
		return
	}
	p.running = true
	p.mu.Unlock()
	go p.loop()
}

// Stop terminates the cycle. Blocks until the goroutine exits.
func (p *Prober) Stop() {
	close(p.stop)
	<-p.done
}

// Sample returns the current median direct-transport estimate for class, 0
// when no sample has been recorded yet.
func (p *Prober) Sample(class string) float64 {
	p.mu.Lock()
	arr := append([]float64(nil), p.window[class]...)
	p.mu.Unlock()
	if len(arr) == 0 {
		return 0
	}
	// insertion-sort copy — at 8 samples this beats sort overhead
	for i := 1; i < len(arr); i++ {
		for k := i; k > 0 && arr[k] < arr[k-1]; k-- {
			arr[k], arr[k-1] = arr[k-1], arr[k]
		}
	}
	return arr[len(arr)/2]
}

// Snapshot serialises the current rolling windows for broadcast.
func (p *Prober) Snapshot() Snapshot {
	p.mu.Lock()
	defer p.mu.Unlock()
	at := map[string]int64{}
	by := map[string][]float64{}
	for k, v := range p.at {
		at[k] = v
	}
	for k, v := range p.window {
		by[k] = append([]float64(nil), v...)
	}
	return Snapshot{At: at, ByClass: by}
}

// loop owns the probe cadence. Exit condition: Stop. The very first cycle
// runs immediately so the first minute of a run reports real overhead.
func (p *Prober) loop() {
	defer close(p.done)
	p.cycle()
	t := time.NewTicker(Interval)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			p.cycle()
		case <-p.stop:
			return
		}
	}
}

// cycle fires each baseline probe sequentially against the direct URL,
// mirroring probeBaselines in the TS driver.
func (p *Prober) cycle() {
	if !p.probeMu.TryLock() {
		return
	}
	defer p.probeMu.Unlock()

	p.mu.Lock()
	url := p.params.URL
	auth := p.params.AuthHeader
	p.mu.Unlock()
	if url == "" {
		return
	}

	for _, spec := range scen.BuildBaselineProbe(p.ids) {
		lat, ok := p.timeOne(url, auth, spec)
		if !ok {
			continue
		}
		p.mu.Lock()
		arr := append(p.window[spec.Class], lat)
		if len(arr) > SamplesPerClass {
			arr = arr[len(arr)-SamplesPerClass:]
		}
		p.window[spec.Class] = arr
		p.at[spec.Class] = time.Now().UnixMilli()
		pub := p.params.Publish
		p.mu.Unlock()
		_ = pub // published once per full cycle below
	}
	if p.params.Publish != nil {
		p.params.Publish(p.Snapshot())
	}
}

// timeOne fires one probe and returns (ttfb - serverMs), mirroring timeDirect
// in the TS driver.
func (p *Prober) timeOne(url, auth string, spec *scen.Spec) (float64, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), ProbeTimeout)
	defer cancel()

	var body io.Reader
	if spec.Body != nil {
		body = bytesReader(spec.Body)
	}
	req, err := http.NewRequestWithContext(ctx, spec.Method, url+spec.Path, body)
	if err != nil {
		return 0, false
	}
	for k, v := range spec.Headers {
		req.Header.Set(k, v)
	}
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	start := time.Now()
	ttfb := -1.0
	trace := &httptrace.ClientTrace{
		GotFirstResponseByte: func() { ttfb = float64(time.Since(start).Microseconds()) / 1000.0 },
	}
	req = req.WithContext(httptrace.WithClientTrace(req.Context(), trace))
	res, err := p.params.Client.Do(req)
	if err != nil {
		return 0, false
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, res.Body)
	serverMs := parseMs(res.Header.Get(fire.ServerMSHeader))
	if serverMs == nil || ttfb < 0 {
		return 0, false
	}
	return max(0, ttfb-*serverMs), true
}

func bytesReader(b []byte) io.Reader { return bytes.NewReader(b) }

func parseMs(raw string) *float64 {
	if raw == "" {
		return nil
	}
	n, err := strconv.ParseFloat(raw, 64)
	if err != nil || n < 0 {
		return nil
	}
	return &n
}
