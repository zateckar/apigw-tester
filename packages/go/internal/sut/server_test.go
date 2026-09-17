package sut

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

const testAuth = "Basic dGVzdDpwdy0xMjM=" // test:pw-123

// newTestServer returns a server with the simulated backend latency turned off.
// The real profile sleeps 20–900ms per request by design; leaving it on would
// make this suite the slowest thing in the repo and test nothing extra.
func newTestServer(t *testing.T) *Server {
	t.Helper()
	s := NewServer(testAuth)
	flat := map[string]Distribution{}
	for k := range DefaultLatencyProfile() {
		flat[k] = Distribution{Kind: "fixed", Ms: 0}
	}
	s.Profile.Patch(flat)
	return s
}

func do(t *testing.T, s *Server, method, path string, body string, headers ...[2]string) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, strings.NewReader(body))
	}
	r.Header.Set("Authorization", testAuth)
	for _, h := range headers {
		r.Header.Set(h[0], h[1])
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func TestHealthIsPublicAndEverythingElseIsNot(t *testing.T) {
	s := newTestServer(t)

	r := httptest.NewRequest("GET", "/health", nil) // no Authorization
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("health without auth: %d", w.Code)
	}

	for _, p := range []string{"/api/pets", "/api/pets/1", "/soap/petservice?wsdl", "/admin/petstore"} {
		r := httptest.NewRequest("GET", p, nil)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != 401 {
			t.Fatalf("%s without auth: %d", p, w.Code)
		}
		if got := w.Header().Get("WWW-Authenticate"); !strings.HasPrefix(got, "Basic ") {
			t.Fatalf("%s: no Basic challenge (%q)", p, got)
		}
	}
}

func TestWrongCredentialIsRefused(t *testing.T) {
	s := newTestServer(t)
	for _, bad := range []string{"Basic wrong", "Bearer token", testAuth + "x", strings.ToLower(testAuth)} {
		r := httptest.NewRequest("GET", "/api/pets", nil)
		r.Header.Set("Authorization", bad)
		w := httptest.NewRecorder()
		s.ServeHTTP(w, r)
		if w.Code != 401 {
			t.Fatalf("credential %q returned %d", bad, w.Code)
		}
	}
}

func TestUnconfiguredAuthFailsClosed(t *testing.T) {
	// an unset APP_BASIC_AUTH must not mean "serve to everyone": this process
	// is reachable from wherever the gateway is
	s := NewServer("")
	r := httptest.NewRequest("GET", "/api/pets", nil)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 503 {
		t.Fatalf("unconfigured auth returned %d, want 503", w.Code)
	}
	if strings.Contains(w.Body.String(), "Basic") {
		t.Fatalf("the 503 leaked a credential hint: %s", w.Body.String())
	}
}

func TestSecurityHeadersOnEveryResponse(t *testing.T) {
	s := newTestServer(t)
	for _, w := range []*httptest.ResponseRecorder{
		do(t, s, "GET", "/health", ""),
		do(t, s, "GET", "/api/pets?size=5", ""),
		do(t, s, "GET", "/nope", ""),
	} {
		for _, h := range []string{"Content-Security-Policy", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy"} {
			if w.Header().Get(h) == "" {
				t.Fatalf("missing %s", h)
			}
		}
		if w.Header().Get("X-Powered-By") != "" {
			t.Fatal("x-powered-by leaked")
		}
	}
}

func TestServerMsIsStampedOnSUTPathsOnly(t *testing.T) {
	// this header is the entire basis of overhead attribution: the driver
	// subtracts it, so a missing stamp makes the measurement unavailable and a
	// stamp on a non-SUT path credits the backend for work it never did
	s := newTestServer(t)
	for _, p := range []string{"/api/pets?size=2", "/api/pets/1", "/api/slow/0", "/api/echo", "/admin/chaos"} {
		method := "GET"
		body := ""
		if p == "/api/echo" {
			method, body = "POST", "{}"
		}
		w := do(t, s, method, p, body)
		raw := w.Header().Get(ServerMsHeader)
		if raw == "" {
			t.Fatalf("%s carried no %s", p, ServerMsHeader)
		}
		ms, err := strconv.ParseFloat(raw, 64)
		if err != nil || ms < 0 {
			t.Fatalf("%s: unparseable server time %q", p, raw)
		}
	}
	if got := do(t, s, "GET", "/health", "").Header().Get(ServerMsHeader); got != "" {
		t.Fatalf("/health was stamped: %q", got)
	}
}

func TestServerMsExcludesTimeSpentReadingTheBody(t *testing.T) {
	// a slow upload is transport, not SUT processing; counting it would
	// understate gateway overhead on exactly the classes that measure it
	s := newTestServer(t)
	big := `{"name":"Probe","description":"` + strings.Repeat("x", 3000) + `"}`
	w := do(t, s, "POST", "/api/pets", big, [2]string{"Content-Type", "application/json"})
	if w.Code != 201 {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	ms, _ := strconv.ParseFloat(w.Header().Get(ServerMsHeader), 64)
	if ms > 100 {
		t.Fatalf("server time %vms includes more than handler work", ms)
	}
}

// Every route the OpenAPI document declares must answer — neither 404 (missing)
// nor 405 (registered under a different method). The contract suite asserts the
// same thing against the TS petstore.
func TestEveryDocumentedRouteAnswers(t *testing.T) {
	s := newTestServer(t)
	cases := []struct{ method, path, body string }{
		{"GET", "/api/pets?size=5", ""},
		{"POST", "/api/pets", `{"name":"Probe"}`},
		{"GET", "/api/pets/1", ""},
		{"PUT", "/api/pets/1", `{"name":"Probe"}`},
		{"DELETE", "/api/pets/119", ""},
		{"GET", "/api/pets/2/photo", ""},
		{"POST", "/api/store/order", `{"petId":1}`},
		{"GET", "/api/store/order/1", ""},
		{"GET", "/api/slow/0", ""},
		{"GET", "/api/big/1024", ""},
		{"POST", "/api/echo", `{"_pad":"x"}`},
		{"GET", "/soap/petservice?wsdl", ""},
		{"GET", "/admin/latency-profile", ""},
		{"GET", "/admin/chaos", ""},
		{"GET", "/admin/petstore", ""},
	}
	for _, c := range cases {
		w := do(t, s, c.method, c.path, c.body, [2]string{"Content-Type", "application/json"})
		if w.Code == 404 || w.Code == 405 {
			t.Fatalf("%s %s -> %d", c.method, c.path, w.Code)
		}
	}
	// and an unrouted path is a 404, not a match on a neighbouring pattern
	if w := do(t, s, "GET", "/api/nope", ""); w.Code != 404 {
		t.Fatalf("unrouted path: %d", w.Code)
	}
	// a registered path under an unregistered method is a 404 too, as the TS
	// dispatcher's first-match-wins table produced
	if w := do(t, s, "DELETE", "/api/echo", ""); w.Code != 404 {
		t.Fatalf("wrong method: %d", w.Code)
	}
}

func TestListPetsShape(t *testing.T) {
	s := newTestServer(t)
	w := do(t, s, "GET", "/api/pets?status=available&size=5&page=1", "")
	if w.Code != 200 {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	var got struct {
		Items []Pet `json:"items"`
		Total int   `json:"total"`
		Page  int   `json:"page"`
		Size  int   `json:"size"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("%v: %s", err, w.Body.String()[:200])
	}
	if got.Page != 1 || got.Size != 5 || len(got.Items) != 5 {
		t.Fatalf("%+v", got)
	}
	for _, p := range got.Items {
		if p.Status != "available" {
			t.Fatalf("filter leaked %q", p.Status)
		}
	}
}

// The generator's deliberately invalid slice. A 2xx here would be reported as
// the gateway leaking a contract violation to the backend.
func TestInvalidTrafficIsRefusedWith4xx(t *testing.T) {
	s := newTestServer(t)
	cases := []struct{ name, method, path, body string }{
		{"missing-required", "POST", "/api/pets", `{"status":"available"}`},
		{"wrong-type", "POST", "/api/pets", `{"name":12345}`},
		{"bad-enum", "POST", "/api/pets", `{"name":"Contract Breaker","status":"liquidated"}`},
		{"bad-enum-query", "GET", "/api/pets?status=teleported", ""},
		{"range", "GET", "/api/pets?size=9999", ""},
		{"path-type", "GET", "/api/pets/not-a-number", ""},
		{"nested-wrong-type", "POST", "/api/store/order", `{"petId":"120","quantity":0}`},
		{"unparseable-json", "POST", "/api/pets", `{not json`},
		{"empty-update", "PUT", "/api/pets/1", `{}`},
		{"slow-over-ceiling", "GET", "/api/slow/999999", ""},
		{"big-over-ceiling", "GET", "/api/big/999999999", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := do(t, s, c.method, c.path, c.body, [2]string{"Content-Type", "application/json"})
			if w.Code < 400 || w.Code >= 500 {
				t.Fatalf("%s %s -> %d: %s", c.method, c.path, w.Code, w.Body.String())
			}
		})
	}
}

func TestSoapOverHTTP(t *testing.T) {
	s := newTestServer(t)
	xmlHeaders := [2]string{"Content-Type", "text/xml; charset=utf-8"}

	valid := envelope("<tns:getPetByIdRequest><petId>1</petId></tns:getPetByIdRequest>")
	w := do(t, s, "POST", "/soap/petservice", valid, xmlHeaders, [2]string{"SOAPAction", `"getPetById"`})
	if w.Code != 200 || !strings.Contains(w.Body.String(), "soap:Envelope") {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "soap:Fault") {
		t.Fatalf("valid request faulted: %s", w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "text/xml" {
		t.Fatalf("content type %q", ct)
	}

	// the invalid SOAP variants
	for _, c := range []struct{ name, body string }{
		{"bad-enum", envelope("<tns:findPetsByStatusRequest><status>zombified</status></tns:findPetsByStatusRequest>")},
		{"missing-element", envelope("<tns:getPetByIdRequest></tns:getPetByIdRequest>")},
		{"truncated", `<soap:Envelope><soap:Body><tns:getPetByIdRequest><petId>1</petId>`},
		{"not-an-envelope", `<hello/>`},
		{"empty", ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			w := do(t, s, "POST", "/soap/petservice", c.body, xmlHeaders)
			if w.Code != 400 {
				t.Fatalf("-> %d: %s", w.Code, w.Body.String())
			}
			if !strings.Contains(w.Body.String(), "soap:Fault") {
				t.Fatalf("no fault returned: %s", w.Body.String())
			}
		})
	}
}

func TestWSDLIsServedWithTheAdvertisedLocation(t *testing.T) {
	s := newTestServer(t)
	w := do(t, s, "GET", "/soap/petservice?wsdl", "", [2]string{"X-Forwarded-Proto", "https"}, [2]string{"X-Forwarded-Host", "gw.example.com"})
	body := w.Body.String()
	if w.Code != 200 {
		t.Fatalf("%d", w.Code)
	}
	if strings.Contains(body, ServiceLocationPlaceholder) {
		t.Fatal("placeholder not substituted")
	}
	// a gateway in front of us is the normal case; advertising our own loopback
	// address would make the WSDL useless to import
	if !strings.Contains(body, `location="https://gw.example.com/soap/petservice"`) {
		t.Fatalf("forwarded headers ignored: %s", body[strings.Index(body, "<soap:address"):])
	}
	// GET without ?wsdl is not a SOAP call
	if w := do(t, s, "GET", "/soap/petservice", ""); w.Code != 405 {
		t.Fatalf("bare GET: %d", w.Code)
	}
}

func TestResponsesAreSizedLikeARealAPI(t *testing.T) {
	// response size drives whether a gateway buffers, streams or compresses —
	// the most expensive things it does. A rig that only moved 200-byte bodies
	// would report an overhead no production traffic reproduces.
	s := newTestServer(t)

	list := do(t, s, "GET", "/api/pets?size=20", "").Body.Len()
	if list < 6000 || list > 10000 {
		t.Fatalf("list-pets padded to %d bytes, expected ~8000", list)
	}
	photo := do(t, s, "GET", "/api/pets/1/photo", "").Body.Len()
	if photo < 38000 || photo > 62000 {
		t.Fatalf("pet-photo padded to %d bytes, expected ~50000", photo)
	}
	// an explicit override wins over the class default, exactly
	sized := do(t, s, "GET", "/api/pets/1", "", [2]string{"X-Test-Size-B", "4096"})
	if sized.Body.Len() != 4096 {
		t.Fatalf("X-Test-Size-B produced %d bytes", sized.Body.Len())
	}
	// and the padded body is still valid JSON carrying the real payload
	var pet map[string]any
	if err := json.Unmarshal(sized.Body.Bytes(), &pet); err != nil {
		t.Fatalf("padding broke the JSON: %v", err)
	}
	if pet["id"] != float64(1) {
		t.Fatalf("payload lost: %v", pet["id"])
	}
}

func TestBigStreamsExactlyTheRequestedBytes(t *testing.T) {
	s := newTestServer(t)
	for _, size := range []int{0, 1024, 65536, bigChunk + 7} {
		w := do(t, s, "GET", "/api/big/"+strconv.Itoa(size), "")
		if w.Code != 200 {
			t.Fatalf("size %d: %d", size, w.Code)
		}
		if w.Body.Len() != size {
			t.Fatalf("size %d produced %d bytes", size, w.Body.Len())
		}
		if got := w.Header().Get("Content-Length"); got != strconv.Itoa(size) {
			t.Fatalf("size %d declared Content-Length %q", size, got)
		}
		if w.Header().Get("X-Direct") != "1" {
			t.Fatal("stress endpoints must be marked direct")
		}
	}
}

func TestEchoCountsTheUploadWithoutParsingIt(t *testing.T) {
	s := newTestServer(t)
	payload := strings.Repeat("A", 200_000)
	w := do(t, s, "POST", "/api/echo", payload)
	if w.Code != 200 {
		t.Fatalf("%d", w.Code)
	}
	var got struct {
		ReceivedBytes int64 `json:"receivedBytes"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.ReceivedBytes != int64(len(payload)) {
		t.Fatalf("counted %d of %d bytes", got.ReceivedBytes, len(payload))
	}
}

func TestSlowHonoursTheRequestedDelay(t *testing.T) {
	s := newTestServer(t)
	w := do(t, s, "GET", "/api/slow/25", "")
	if w.Code != 200 {
		t.Fatalf("%d", w.Code)
	}
	ms, err := strconv.ParseFloat(w.Header().Get(ServerMsHeader), 64)
	if err != nil {
		t.Fatal(err)
	}
	if ms < 20 {
		t.Fatalf("server time %vms did not include the 25ms sleep", ms)
	}
}

func TestAdminEndpointsRoundTrip(t *testing.T) {
	s := newTestServer(t)

	w := do(t, s, "PATCH", "/admin/latency-profile", `{"get-pet":{"kind":"fixed","ms":7}}`,
		[2]string{"Content-Type", "application/json"})
	if w.Code != 200 {
		t.Fatalf("patch: %d %s", w.Code, w.Body.String())
	}
	var profile map[string]Distribution
	if err := json.Unmarshal(w.Body.Bytes(), &profile); err != nil {
		t.Fatal(err)
	}
	if profile["get-pet"].Ms != 7 {
		t.Fatalf("patch not applied: %+v", profile["get-pet"])
	}
	// a merge, not a replacement — the other endpoints must survive
	if _, ok := profile["list-pets"]; !ok {
		t.Fatal("patch replaced the profile instead of merging into it")
	}

	if w := do(t, s, "PATCH", "/admin/latency-profile", `{"get-pet":{"kind":"warp"}}`,
		[2]string{"Content-Type", "application/json"}); w.Code != 400 {
		t.Fatalf("invalid patch: %d", w.Code)
	}

	w = do(t, s, "PUT", "/admin/chaos", `{"errorRatePct":150,"timeoutRatePct":-1}`,
		[2]string{"Content-Type", "application/json"})
	var chaos Chaos
	if err := json.Unmarshal(w.Body.Bytes(), &chaos); err != nil {
		t.Fatal(err)
	}
	if chaos.ErrorRatePct != 100 || chaos.TimeoutRatePct != 0 {
		t.Fatalf("chaos not clamped: %+v", chaos)
	}

	w = do(t, s, "GET", "/admin/petstore", "")
	var stats struct {
		Pets     int `json:"pets"`
		Capacity int `json:"capacity"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &stats); err != nil {
		t.Fatal(err)
	}
	if stats.Pets != 120 || stats.Capacity != LimitPetStoreSize {
		t.Fatalf("%+v", stats)
	}
}

func TestChaosErrorRateProducesFiveHundreds(t *testing.T) {
	s := newTestServer(t)
	s.Profile.SetChaos(Chaos{ErrorRatePct: 100})
	w := do(t, s, "GET", "/api/pets/1", "")
	if w.Code != 500 {
		t.Fatalf("%d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "chaos monkey") {
		t.Fatalf("%s", w.Body.String())
	}
	// stress endpoints have no variability, so chaos must not reach them: they
	// exist to measure the gateway on a raw path
	if w := do(t, s, "GET", "/api/slow/0", ""); w.Code != 200 {
		t.Fatalf("chaos leaked into a raw path: %d", w.Code)
	}
}

func TestDelayOverrideHeaderIsHonoured(t *testing.T) {
	s := newTestServer(t)
	w := do(t, s, "GET", "/api/pets/1", "", [2]string{"X-Test-Delay-Ms", "30"})
	ms, err := strconv.ParseFloat(w.Header().Get(ServerMsHeader), 64)
	if err != nil {
		t.Fatal(err)
	}
	if ms < 25 {
		t.Fatalf("delay override ignored: %vms", ms)
	}
}

func TestReadAfterWriteIsConsistent(t *testing.T) {
	// the TS petstore served seed pets from a cache it never invalidated, so a
	// GET after a PUT returned the pre-update body
	s := newTestServer(t)
	if w := do(t, s, "PUT", "/api/pets/5", `{"name":"Renamed Pet"}`,
		[2]string{"Content-Type", "application/json"}); w.Code != 200 {
		t.Fatalf("update: %d %s", w.Code, w.Body.String())
	}
	w := do(t, s, "GET", "/api/pets/5", "", [2]string{"X-Test-Size-B", "600"})
	var pet map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &pet); err != nil {
		t.Fatal(err)
	}
	if pet["name"] != "Renamed Pet" {
		t.Fatalf("stale body served: %v", pet["name"])
	}
	// and the listing reflects it too
	list := do(t, s, "GET", "/api/pets?size=10", "").Body.String()
	if !strings.Contains(list, "Renamed Pet") {
		t.Fatal("listing served a stale body")
	}
}

func TestNotFoundPathsUseTheDocumentedStatus(t *testing.T) {
	s := newTestServer(t)
	for _, c := range []struct {
		path string
		want int
	}{
		{"/api/pets/999999", 404},
		{"/api/store/order/999999", 404},
		{"/api/pets/999999/photo", 404},
	} {
		if w := do(t, s, "GET", c.path, ""); w.Code != c.want {
			t.Fatalf("%s -> %d, want %d", c.path, w.Code, c.want)
		}
	}
}

func TestBodyIsReadEvenWhenTheHandlerRejectsIt(t *testing.T) {
	// an unread body wedges keep-alive: the next request on that connection
	// starts mid-payload. The rig reports connection reuse as a headline
	// number, so a handler that poisons the pool would show up as gateway cost.
	s := newTestServer(t)
	r := httptest.NewRequest("POST", "/api/pets", strings.NewReader(`{"name":12345}`))
	r.Header.Set("Authorization", testAuth)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 400 {
		t.Fatalf("%d", w.Code)
	}
	if n, _ := io.Copy(io.Discard, r.Body); n != 0 {
		t.Fatalf("%d bytes of request body left unread", n)
	}
}
