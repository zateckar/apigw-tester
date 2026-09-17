package fire

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/apigw-tester/go/internal/scen"
	"github.com/apigw-tester/go/internal/schedule"
	"github.com/apigw-tester/go/internal/wire"
)

type capture struct {
	lastAuth        atomic.Value
	lastReqID       atomic.Value
	lastTraceparent atomic.Value
	lastAPIKey      atomic.Value
	reqBody         atomic.Value
}

func newSUT(t *testing.T, delayMs int) (*httptest.Server, *capture) {
	t.Helper()
	c := &capture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c.lastAuth.Store(r.Header.Get("Authorization"))
		c.lastReqID.Store(r.Header.Get("x-request-id"))
		c.lastTraceparent.Store(r.Header.Get("traceparent"))
		c.lastAPIKey.Store(r.Header.Get("X-API-Key"))
		if r.Body != nil {
			b, _ := io.ReadAll(r.Body)
			c.reqBody.Store(string(b))
		}
		if delayMs > 0 {
			time.Sleep(time.Duration(delayMs) * time.Millisecond)
		}
		w.Header().Set(ServerMSHeader, "7")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"id":4242,"name":"x"}`)
	}))
	t.Cleanup(srv.Close)
	return srv, c
}

func TestFireRequestShapeAndCaptureID(t *testing.T) {
	srv, cap_ := newSUT(t, 0)
	clients := NewClients()
	reaper := schedule.NewReaper()
	defer reaper.Stop()
	ids := scen.NewIDTracker(120)
	f := NewFirer(clients, reaper, ids)

	j := GetJob()
	j.Spec = &scen.Spec{
		Protocol: "rest", Endpoint: "POST /api/pets", Class: "small-rest",
		Method: "POST", Path: "/api/pets",
		Headers:   map[string]string{"Content-Type": "application/json"},
		Body:      []byte(`{"name":"Buddy 1"}`),
		CaptureID: true,
	}
	j.RunID = "run-1"
	rid := &RequestIds{}
	rid.Reset()
	j.RequestID, j.Traceparent = rid.Next()
	j.URL = srv.URL + "/api/pets"
	j.AuthHeader = "Basic " + base64.StdEncoding.EncodeToString([]byte("u:p"))
	j.APIKey = "k1"
	j.APIKeyHdr = "X-API-Key"
	f.Fire(j)
	r := j.Result

	if r.Status != 200 || r.Error != nil {
		t.Fatalf("status=%d err=%v", r.Status, r.Error)
	}
	if !r.ReachedBackend {
		t.Fatal("expected reachedBackend via X-Server-Ms")
	}
	if r.TTFBMs == nil || *r.TTFBMs <= 0 {
		t.Fatalf("ttfb missing: %v", r.TTFBMs)
	}
	if r.LatencyMs < *r.TTFBMs {
		t.Fatalf("latency %v < ttfb %v", r.LatencyMs, *r.TTFBMs)
	}
	if r.ServerMs == nil || *r.ServerMs != 7 {
		t.Fatalf("serverMs=%v, want the SUT's reported 7", r.ServerMs)
	}
	if r.BytesResp == 0 || r.BytesReq == 0 {
		t.Fatalf("byte counts missing: req=%d resp=%d", r.BytesReq, r.BytesResp)
	}
	if r.MeasurementVersion != wire.MeasurementVersion {
		t.Fatalf("measurementVersion=%d", r.MeasurementVersion)
	}

	if got := cap_.lastAuth.Load().(string); got != j.AuthHeader {
		t.Fatalf("auth header: %q", got)
	}
	if got := cap_.lastAPIKey.Load().(string); got != "k1" {
		t.Fatalf("api key: %q", got)
	}
	if got := cap_.lastReqID.Load().(string); got != j.RequestID {
		t.Fatalf("x-request-id: %q", got)
	}
	tp := cap_.lastTraceparent.Load().(string)
	if !strings.Contains(tp, j.RequestID) || !strings.HasPrefix(tp, "00-") || !strings.HasSuffix(tp, "-01") {
		t.Fatalf("traceparent malformed: %q", tp)
	}
	// captureId: the firer must have learned the returned pet id
	nextIds := ids.DeletablePetID()
	if nextIds == 4242+1+120 { // fallback when nothing tracked
		t.Fatalf("created pet id not captured")
	}
	PutJob(j)
}

func TestFireOmitsCredentialsWhenNotConfigured(t *testing.T) {
	srv, cap_ := newSUT(t, 0)
	clients := NewClients()
	reaper := schedule.NewReaper()
	defer reaper.Stop()
	f := NewFirer(clients, reaper, scen.NewIDTracker(120))

	j := GetJob()
	j.Spec = &scen.Spec{Protocol: "rest", Endpoint: "GET /api/pets", Class: "small-rest",
		Method: "GET", Path: "/api/pets", Headers: map[string]string{}}
	j.RunID = "run-1"
	rid := &RequestIds{}
	rid.Reset()
	j.RequestID, j.Traceparent = rid.Next()
	j.URL = srv.URL + "/api/pets"
	f.Fire(j)
	if cap_.lastAuth.Load().(string) != "" {
		t.Fatalf("unexpected Authorization: %q", cap_.lastAuth.Load())
	}
	if cap_.lastAPIKey.Load().(string) != "" {
		t.Fatalf("unexpected API key header")
	}
	PutJob(j)
}

func TestFireErrorAgainstDeadServer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close() // nothing listening now

	clients := NewClients()
	reaper := schedule.NewReaper()
	defer reaper.Stop()
	f := NewFirer(clients, reaper, scen.NewIDTracker(120))

	j := GetJob()
	j.Spec = &scen.Spec{Protocol: "rest", Endpoint: "GET /api/pets", Class: "small-rest",
		Method: "GET", Path: "/", Headers: map[string]string{}}
	j.RunID = "run-1"
	j.URL = url + "/"
	f.Fire(j)
	r := j.Result
	if r.Error == nil {
		t.Fatal("expected an error against a dead server")
	}
	if r.Status != 0 {
		t.Fatalf("status=%d, want 0", r.Status)
	}
	if r.ReachedBackend {
		t.Fatal("must not report reachedBackend on error")
	}
	if r.ServerMs != nil {
		t.Fatalf("serverMs=%v on a request that got no response", *r.ServerMs)
	}
	PutJob(j)
}

// The residual the store differences against the reference stream is
// ttfb - serverMs, so the firer has to hand both back exactly as observed and
// leave serverMs nil whenever the backend did not sign the response. A zero
// there would read as "the backend took no time" and charge the request's
// entire TTFB to the gateway.
func TestFireRecordsRawTimings(t *testing.T) {
	slow, _ := newSUT(t, 40)
	noServerMs := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{}`)
	}))
	t.Cleanup(noServerMs.Close)

	cases := []struct {
		name     string
		url      string
		wantServ bool
	}{
		{"backend signed the response", slow.URL, true},
		{"backend silent", noServerMs.URL, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			clients := NewClients()
			reaper := schedule.NewReaper()
			defer reaper.Stop()
			f := NewFirer(clients, reaper, scen.NewIDTracker(120))

			j := GetJob()
			defer PutJob(j)
			j.Spec = &scen.Spec{Protocol: "rest", Endpoint: "GET /api/pets", Class: "small-rest",
				Method: "GET", Path: "/api/pets", Headers: map[string]string{}}
			j.RunID = "run-1"
			j.URL = tc.url + "/api/pets"
			f.Fire(j)
			r := j.Result

			if r.Error != nil {
				t.Fatalf("unexpected error: %v", *r.Error)
			}
			// >= 0, not > 0: the clock is microsecond-resolution and a loopback
			// hop can round to zero. Which is the point of keeping residuals
			// signed rather than assuming they are comfortably positive.
			if r.TTFBMs == nil || *r.TTFBMs < 0 {
				t.Fatalf("ttfb missing: %v", r.TTFBMs)
			}
			if !tc.wantServ {
				if r.ServerMs != nil {
					t.Fatalf("serverMs=%v, want nil when the backend sent no header", *r.ServerMs)
				}
				if r.ReachedBackend {
					t.Fatal("reachedBackend must follow serverMs")
				}
				return
			}
			if r.ServerMs == nil || *r.ServerMs != 7 {
				t.Fatalf("serverMs=%v, want 7", r.ServerMs)
			}
			// the SUT sleeps 40ms and self-reports 7, so the residual is the
			// rest of the wall time and is comfortably positive here
			if *r.TTFBMs-*r.ServerMs <= 0 {
				t.Fatalf("residual %v is not positive against a 40ms SUT", *r.TTFBMs-*r.ServerMs)
			}
		})
	}
}

// Connection acquisition is measured so the control plane can take it out of
// the residual. The first request over a fresh client pays a dial; the second
// should find the socket in the pool and be marked as reused, which is the
// distinction ConnSetups counts.
func TestFireTagsConnectionAcquisition(t *testing.T) {
	srv, _ := newSUT(t, 0)
	clients := NewClients()
	reaper := schedule.NewReaper()
	defer reaper.Stop()
	f := NewFirer(clients, reaper, scen.NewIDTracker(120))

	fireOne := func() wire.RequestResult {
		j := GetJob()
		defer PutJob(j)
		j.Spec = &scen.Spec{Protocol: "rest", Endpoint: "GET /api/pets", Class: "small-rest",
			Method: "GET", Path: "/api/pets", Headers: map[string]string{}}
		j.RunID = "run-1"
		j.URL = srv.URL + "/api/pets"
		f.Fire(j)
		return j.Result
	}

	first := fireOne()
	if first.Error != nil {
		t.Fatalf("unexpected error: %v", *first.Error)
	}
	if first.ConnectMs == nil {
		t.Fatal("connectMs must be measured, not nil — nil means 'unobservable'")
	}
	if first.ConnReused {
		t.Fatal("the first request over a fresh client cannot have reused a connection")
	}
	// acquisition happens before the first byte, so it cannot exceed TTFB
	if first.TTFBMs != nil && *first.ConnectMs > *first.TTFBMs {
		t.Fatalf("connect %v exceeds ttfb %v", *first.ConnectMs, *first.TTFBMs)
	}

	second := fireOne()
	if second.ConnectMs == nil {
		t.Fatal("a pool hit is still an acquisition and must be measured")
	}
	if !second.ConnReused {
		t.Fatal("the second request should have reused the pooled connection")
	}
	// a pool hit must be far cheaper than a dial, or the tagging is not
	// distinguishing the two things it exists to distinguish
	if *second.ConnectMs > *first.ConnectMs {
		t.Fatalf("pool hit %v cost more than the dial %v", *second.ConnectMs, *first.ConnectMs)
	}
}

func TestTimeoutBudgetSelection(t *testing.T) {
	if BudgetFor("small-rest") != 15_000 {
		t.Fatal("small budget")
	}
	if BudgetFor("big-request") != 60_000 || BudgetFor("slow-upstream") != 60_000 || BudgetFor("big-response") != 60_000 {
		t.Fatal("large budget")
	}
}

func TestRequestIdsShape(t *testing.T) {
	var r RequestIds
	r.Reset()
	id, tp := r.Next()
	if len(id) != 32 {
		t.Fatalf("id len %d", len(id))
	}
	id2, _ := r.Next()
	if id == id2 {
		t.Fatal("ids must be unique")
	}
	parts := strings.Split(tp, "-")
	if len(parts) != 4 || parts[0] != "00" || parts[1] != id || parts[3] != "01" {
		t.Fatalf("traceparent malformed: %q", tp)
	}
	if len(parts[2]) != 16 {
		t.Fatalf("span id len %d", len(parts[2]))
	}
}

func TestResultFieldNamesMatchTS(t *testing.T) {
	// serialize a fully-populated result and check the camelCase keys TS expects
	val := 1.5
	serv := 0.5
	conn := 0.25
	err := "boom"
	r := wire.RequestResult{
		RunID: "run", RequestID: "id", TS: 1, Protocol: "rest", Endpoint: "e", Class: "c", Method: "GET",
		Status: 200, LatencyMs: 5, TTFBMs: &val, ServerMs: &serv, ConnectMs: &conn, ConnReused: true,
		MeasurementVersion: wire.MeasurementVersion, BytesReq: 10, BytesResp: 20, ReachedBackend: true, Error: &err,
	}
	b, _ := json.Marshal(r)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	want := []string{"runId", "requestId", "ts", "protocol", "endpoint", "class", "method", "status",
		"latencyMs", "ttfbMs", "serverMs", "connectMs", "connReused", "measurementVersion",
		"bytesReq", "bytesResp", "reachedBackend", "error"}
	for _, k := range want {
		if _, ok := m[k]; !ok {
			t.Fatalf("missing field %q in %s", k, b)
		}
	}
}
