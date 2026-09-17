package sut

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"io"
	"math"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// ServerMsHeader carries the SUT's own server-side time for the request, entry
// to first byte. The load driver subtracts it per request, so "GW overhead"
// excludes backend latency — including per-request jitter, chaos injection and
// per-class sleep/size randomness — without guessing from a class-median
// baseline. Absent on responses not issued by the SUT (a gateway's own 401/404).
// Without it, overhead attribution is unavailable.
const ServerMsHeader = "X-Server-Ms"

// defaultSizes is the response size each endpoint class aims for before the
// 0.8–1.2x jitter.
var defaultSizes = map[string]int{
	"list-pets": 8000,
	"get-pet":   1200,
	"pet-photo": 50000,
	"soap-ops":  3000,
}

// chaosTimeoutMs is long enough to blow past any sane client budget, but still
// bounded so the socket and its timer are always released.
const chaosTimeoutMs = LimitDelayMs

// bigChunk is the write size for /api/big. At 64KB the per-chunk overhead
// dominated CPU at high big-response rps; fewer, larger writes drop that with
// no fidelity loss on loopback.
const bigChunk = 256 * 1024

type handlerFunc func(*reqCtx)

type route struct {
	method   string
	segments []string
	handler  handlerFunc
	// how to materialise the request body before the handler runs
	body string // "", "json", "text", "bytes"
}

type reqCtx struct {
	srv    *Server
	w      http.ResponseWriter
	r      *http.Request
	params map[string]string
	query  url.Values
	// per-request response size target set by variability; 0 means no padding
	padBytes  int
	jsonBody  any
	textBody  string
	echoBytes int64
	enteredAt time.Time
	path      string
}

// Server is the petstore HTTP handler.
type Server struct {
	Store   *PetStore
	Profile *Profile
	routes  []route
	// expected Authorization header; nil means auth is not configured and the
	// server fails closed
	auth []byte
	// injectable for tests; defaults to the runtime's per-P generator
	Rand func() float64
}

// NewServer builds the route table. authHeader is the exact
// "Basic <base64>" value to accept, or "" to fail closed.
func NewServer(authHeader string) *Server {
	s := &Server{
		Store:   NewPetStore(120, LimitPetStoreSize),
		Profile: NewProfile(),
		Rand:    rand.Float64,
	}
	if authHeader != "" {
		s.auth = []byte(authHeader)
	}
	s.registerRoutes()
	return s
}

func (s *Server) on(key string, h handlerFunc, body string) {
	i := strings.Index(key, " ")
	method, path := key[:i], key[i+1:]
	s.routes = append(s.routes, route{
		method:   method,
		segments: splitPath(path),
		handler:  h,
		body:     body,
	})
}

// withVariability wraps a handler in the simulated latency, size and chaos the
// endpoint class declares.
func (s *Server) withVariability(key string, h handlerFunc) handlerFunc {
	return func(c *reqCtx) {
		if c.applyVariability(key) {
			return // chaos already answered it
		}
		h(c)
	}
}

func (s *Server) registerRoutes() {
	v := s.withVariability

	// ---------- REST: pets ----------
	s.on("GET /api/pets", v("list-pets", handleListPets), "")
	s.on("GET /api/pets/:petId", v("get-pet", handleGetPet), "")
	s.on("POST /api/pets", v("create-pet", handleCreatePet), "json")
	s.on("PUT /api/pets/:petId", v("update-pet", handleUpdatePet), "json")
	s.on("DELETE /api/pets/:petId", v("delete-pet", handleDeletePet), "")
	s.on("GET /api/pets/:petId/photo", v("pet-photo", handlePhoto), "")

	// ---------- REST: store ----------
	s.on("POST /api/store/order", v("place-order", handlePlaceOrder), "json")
	s.on("GET /api/store/order/:orderId", v("get-order", handleGetOrder), "")

	// ---------- Synthetic stress endpoints ----------
	// No variability: raw paths, so what you measure is the gateway.
	s.on("GET /api/slow/:ms", handleSlow, "")
	s.on("GET /api/big/:size", handleBig, "")
	s.on("POST /api/echo", handleEcho, "bytes")

	// ---------- SOAP ----------
	s.on("GET /soap/petservice", handleWSDL, "")
	s.on("POST /soap/petservice", v("soap-ops", handleSoap), "text")

	// ---------- Admin ----------
	s.on("GET /admin/latency-profile", handleGetLatency, "")
	s.on("PATCH /admin/latency-profile", handlePatchLatency, "json")
	s.on("GET /admin/chaos", handleGetChaos, "")
	s.on("PUT /admin/chaos", handlePutChaos, "json")
	s.on("GET /admin/petstore", handleAdminPetstore, "")
}

func splitPath(p string) []string {
	out := make([]string, 0, 4)
	for _, seg := range strings.Split(p, "/") {
		if seg != "" {
			out = append(out, seg)
		}
	}
	return out
}

func (rt *route) match(method string, segs []string) (map[string]string, bool) {
	if rt.method != method || len(rt.segments) != len(segs) {
		return nil, false
	}
	var params map[string]string
	for i, rs := range rt.segments {
		if strings.HasPrefix(rs, ":") {
			if params == nil {
				params = make(map[string]string, 2)
			}
			decoded, err := url.PathUnescape(segs[i])
			if err != nil {
				decoded = segs[i]
			}
			params[rs[1:]] = decoded
		} else if rs != segs[i] {
			return nil, false
		}
	}
	if params == nil {
		params = map[string]string{}
	}
	return params, true
}

// securityHeaders mirrors the control plane's set exactly, including the header
// names the CI smoke suite greps for. x-powered-by is never set.
var securityHeaders = [...][2]string{
	{"Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"},
	{"X-Content-Type-Options", "nosniff"},
	{"X-Frame-Options", "DENY"},
	{"Referrer-Policy", "no-referrer"},
	{"Cross-Origin-Opener-Policy", "same-origin"},
}

// stampsServerMs reports whether a path is SUT-served and therefore carries the
// server-time header. Mirrors the control plane's coverage exactly.
func stampsServerMs(p string) bool {
	return strings.HasPrefix(p, "/api/pets") || strings.HasPrefix(p, "/api/store") ||
		strings.HasPrefix(p, "/soap/") || strings.HasPrefix(p, "/admin/") ||
		p == "/api/slow" || strings.HasPrefix(p, "/api/slow/") ||
		p == "/api/big" || strings.HasPrefix(p, "/api/big/") ||
		p == "/api/echo"
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	enteredAt := time.Now()
	path := r.URL.Path

	h := w.Header()
	for _, kv := range securityHeaders {
		h.Set(kv[0], kv[1])
	}
	if proto := r.Header.Get("X-Forwarded-Proto"); proto == "https" || r.TLS != nil {
		h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
	}

	c := &reqCtx{srv: s, w: w, r: r, query: r.URL.Query(), enteredAt: enteredAt, path: path}

	// public healthcheck — no auth, and no server-ms stamp (it is not SUT work)
	if r.Method == http.MethodGet && path == "/health" {
		c.writeJSON(http.StatusOK, map[string]any{"status": "ok", "sut": "go"})
		return
	}

	if !s.authorize(c) {
		return
	}

	segs := splitPath(path)
	for i := range s.routes {
		rt := &s.routes[i]
		params, ok := rt.match(r.Method, segs)
		if !ok {
			continue
		}
		c.params = params
		if !c.materialiseBody(rt.body) {
			return
		}
		rt.handler(c)
		return
	}

	c.writeJSON(http.StatusNotFound, map[string]any{"error": "not found"})
}

// authorize replies and returns false when the request may not proceed.
func (s *Server) authorize(c *reqCtx) bool {
	if s.auth == nil {
		// fail closed; no credential route leaks
		c.writeJSON(http.StatusServiceUnavailable,
			map[string]any{"error": "server not configured: set APP_BASIC_AUTH=name:password"})
		return false
	}
	got := c.r.Header.Get("Authorization")
	if got == "" {
		c.unauthorized()
		return false
	}
	// constant-time over the whole header; the length guard comes first because
	// the caller already knows the length they sent
	if len(got) != len(s.auth) || subtle.ConstantTimeCompare([]byte(got), s.auth) != 1 {
		c.unauthorized()
		return false
	}
	return true
}

func (c *reqCtx) unauthorized() {
	c.w.Header().Set("WWW-Authenticate", `Basic realm="apigw-tester", charset="UTF-8"`)
	c.writeRaw(http.StatusUnauthorized, "text/plain; charset=utf-8", []byte("Unauthorized"))
}

// materialiseBody reads the request body the route declared. Server time starts
// once the body is fully in: bodies arriving slowly (a 12MB echo upload, a fat
// SOAP envelope) are transport, not SUT processing, and counting them would
// understate gateway overhead on exactly the classes that measure it.
func (c *reqCtx) materialiseBody(kind string) bool {
	switch kind {
	case "json":
		raw, err := io.ReadAll(c.r.Body)
		if err == nil && len(raw) > 0 {
			// a body that does not parse leaves jsonBody nil, and the
			// validators answer "body must be a JSON object" — same as the
			// TS `req.json().catch(() => undefined)`
			_ = json.Unmarshal(raw, &c.jsonBody)
		}
	case "text":
		raw, err := io.ReadAll(c.r.Body)
		if err == nil {
			c.textBody = string(raw)
		}
	case "bytes":
		n, err := io.Copy(io.Discard, c.r.Body)
		if err == nil {
			c.echoBytes = n
		}
	default:
		return true
	}
	c.enteredAt = time.Now()
	return true
}

// applyVariability simulates backend latency, response size and chaos. Returns
// true when it has already answered the request.
func (c *reqCtx) applyVariability(endpointKey string) bool {
	rnd := c.srv.Rand

	delayMs, hasOverride := HeaderInt(c.r.Header.Get("X-Test-Delay-Ms"), LimitDelayMs)
	delay := float64(delayMs)
	if !hasOverride {
		delay = SampleLatency(c.srv.Profile.For(endpointKey), rnd)
	}

	if size, ok := HeaderInt(c.r.Header.Get("X-Test-Size-B"), LimitPadBytes); ok {
		c.padBytes = int(size)
	} else if base, ok := defaultSizes[endpointKey]; ok {
		c.padBytes = int(math.Round(float64(base) * (0.8 + rnd()*0.4)))
	}

	switch DecideChaos(c.srv.Profile.Chaos(), rnd) {
	case "error":
		c.writeJSON(http.StatusInternalServerError, map[string]any{"error": "chaos monkey says 500"})
		return true
	case "timeout":
		delay = chaosTimeoutMs
	}

	// context-aware: a client that walks away cancels the timer rather than
	// holding a goroutine for the full simulated delay
	sleepCtx(c.r.Context(), time.Duration(delay*float64(time.Millisecond)))
	return false
}

func sleepCtx(ctx context.Context, d time.Duration) {
	if d <= 0 {
		return
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
	case <-ctx.Done():
	}
}

// ---- response writers ----

func (c *reqCtx) stamp() {
	if stampsServerMs(c.path) {
		ms := float64(time.Since(c.enteredAt)) / float64(time.Millisecond)
		if ms < 0 {
			ms = 0
		}
		c.w.Header().Set(ServerMsHeader, strconv.FormatFloat(ms, 'f', -1, 64))
	}
}

func (c *reqCtx) writeRaw(status int, contentType string, body []byte) {
	c.stamp()
	h := c.w.Header()
	h.Set("Content-Type", contentType)
	h.Set("Content-Length", strconv.Itoa(len(body)))
	c.w.WriteHeader(status)
	_, _ = c.w.Write(body)
}

// writeJSON emits an unpadded JSON response — the module-level `json()` helper
// in the TS original.
func (c *reqCtx) writeJSON(status int, v any) {
	body, err := json.Marshal(v)
	if err != nil {
		body = []byte(`{"error":"response serialization failed"}`)
		status = http.StatusInternalServerError
	}
	c.writeRaw(status, "application/json", body)
}

// send emits a JSON response with this request's pad target applied — the TS
// `send()`. A 400 from a padded class is padded too, exactly as before.
func (c *reqCtx) send(status int, v any) {
	body, err := json.Marshal(v)
	if err != nil {
		c.writeJSON(http.StatusInternalServerError, map[string]any{"error": "response serialization failed"})
		return
	}
	if c.padBytes > 0 {
		body = PadJSON(body, c.padBytes)
	}
	c.writeRaw(status, "application/json", body)
}

func (c *reqCtx) bad(message string) {
	c.send(http.StatusBadRequest, map[string]any{"error": message})
}

// ---- REST handlers ----

// jsNumber reproduces JavaScript's Number(string): blank is zero, anything
// unparseable is NaN. The query validators below were written against those
// semantics and the invalid-traffic slice depends on them holding.
func jsNumber(s string) float64 {
	t := strings.TrimSpace(s)
	if t == "" {
		return 0
	}
	f, err := strconv.ParseFloat(t, 64)
	if err != nil {
		return math.NaN()
	}
	return f
}

func (c *reqCtx) queryNumber(key string, def float64) float64 {
	if _, present := c.query[key]; !present {
		return def
	}
	return jsNumber(c.query.Get(key))
}

func handleListPets(c *reqCtx) {
	status := ""
	if _, present := c.query["status"]; present {
		status = c.query.Get("status")
		if !IsPetStatus(status) {
			c.bad("status must be one of " + statusList())
			return
		}
	}
	page := c.queryNumber("page", 0)
	size := c.queryNumber("size", 20)
	if !isInteger(page) || page < 0 {
		c.bad("page must be a non-negative integer")
		return
	}
	if !isInteger(size) || size < 1 || size > 100 {
		c.bad("size must be an integer between 1 and 100")
		return
	}

	items, total := c.srv.Store.List(status, int(page), int(size))
	c.send(http.StatusOK, map[string]any{
		"items": items, "total": total, "page": int(page), "size": int(size),
	})
}

func handleGetPet(c *reqCtx) {
	id, ok := PathInt(c.params["petId"])
	if !ok {
		c.bad("petId must be a positive integer")
		return
	}
	pet, found := c.srv.Store.Get(id)
	if !found {
		c.send(http.StatusNotFound, map[string]any{"error": "Pet not found"})
		return
	}
	c.send(http.StatusOK, pet)
}

func handleCreatePet(c *reqCtx) {
	in, err := ValidateNewPet(c.jsonBody)
	if err != "" {
		c.bad(err)
		return
	}
	c.send(http.StatusCreated, c.srv.Store.Create(in))
}

func handleUpdatePet(c *reqCtx) {
	id, ok := PathInt(c.params["petId"])
	if !ok {
		c.bad("petId must be a positive integer")
		return
	}
	in, err := ValidateUpdatePet(c.jsonBody)
	if err != "" {
		c.bad(err)
		return
	}
	pet, found := c.srv.Store.Update(id, in)
	if !found {
		c.send(http.StatusNotFound, map[string]any{"error": "Pet not found"})
		return
	}
	c.send(http.StatusOK, pet)
}

func handleDeletePet(c *reqCtx) {
	id, ok := PathInt(c.params["petId"])
	if !ok {
		c.bad("petId must be a positive integer")
		return
	}
	if !c.srv.Store.Delete(id) {
		c.send(http.StatusNotFound, map[string]any{"error": "Pet not found"})
		return
	}
	c.send(http.StatusOK, map[string]any{"deleted": true, "id": id})
}

func handlePhoto(c *reqCtx) {
	id, ok := PathInt(c.params["petId"])
	if !ok {
		c.bad("petId must be a positive integer")
		return
	}
	if _, found := c.srv.Store.Get(id); !found {
		c.send(http.StatusNotFound, map[string]any{"error": "Pet not found"})
		return
	}
	target := c.padBytes
	if target == 0 {
		target = 50000
	}
	body := []byte(`{"petId":` + itoa(id) + `,"photo":["https://cdn.example.test/pets/` +
		itoa(id) + `.jpg"],"contentType":"image/jpeg"}`)
	c.writeRaw(http.StatusOK, "application/octet-stream", PadJSON(body, target))
}

func handlePlaceOrder(c *reqCtx) {
	petID, quantity, err := ValidateOrder(c.jsonBody)
	if err != "" {
		c.bad(err)
		return
	}
	if _, found := c.srv.Store.Get(petID); !found {
		c.bad("Pet " + itoa(petID) + " not found")
		return
	}
	c.send(http.StatusCreated, c.srv.Store.PlaceOrder(petID, quantity))
}

func handleGetOrder(c *reqCtx) {
	id, ok := PathInt(c.params["orderId"])
	if !ok {
		c.bad("orderId must be a positive integer")
		return
	}
	order, found := c.srv.Store.GetOrder(id)
	if !found {
		c.send(http.StatusNotFound, map[string]any{"error": "Order not found"})
		return
	}
	c.send(http.StatusOK, order)
}

// ---- synthetic stress handlers ----

func handleSlow(c *reqCtx) {
	raw := c.params["ms"]
	if raw == "" || !allDigits(raw) {
		c.bad("ms must be a non-negative integer")
		return
	}
	ms, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || ms > LimitSlowMs {
		c.bad("ms must be between 0 and " + strconv.Itoa(LimitSlowMs))
		return
	}
	sleepCtx(c.r.Context(), time.Duration(ms)*time.Millisecond)
	c.w.Header().Set("X-Direct", "1")
	c.writeJSON(http.StatusOK, map[string]any{"sleptMs": ms, "ts": time.Now().UnixMilli()})
}

func handleBig(c *reqCtx) {
	raw := c.params["size"]
	if raw == "" || !allDigits(raw) {
		c.bad("size must be a non-negative integer")
		return
	}
	size, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || size > LimitBigBytes {
		c.bad("size must be between 0 and " + strconv.Itoa(LimitBigBytes))
		return
	}

	chunk := int64(bigChunk)
	if size < chunk {
		chunk = size
	}
	buf := make([]byte, chunk)
	for i := range buf {
		buf[i] = 'Z'
	}

	c.stamp()
	h := c.w.Header()
	h.Set("Content-Type", "application/octet-stream")
	h.Set("Content-Length", strconv.FormatInt(size, 10))
	h.Set("X-Direct", "1")
	c.w.WriteHeader(http.StatusOK)

	ctx := c.r.Context()
	for written := int64(0); written < size; {
		if ctx.Err() != nil {
			return
		}
		n := size - written
		if n > int64(len(buf)) {
			n = int64(len(buf))
		}
		if _, err := c.w.Write(buf[:n]); err != nil {
			return
		}
		written += n
	}
}

func handleEcho(c *reqCtx) {
	c.w.Header().Set("X-Direct", "1")
	c.writeJSON(http.StatusOK, map[string]any{
		"receivedBytes": c.echoBytes, "ts": time.Now().UnixMilli(),
	})
}

// ---- SOAP handlers ----

func handleWSDL(c *reqCtx) {
	_, wantsWSDL := c.query["wsdl"]
	if !wantsWSDL && strings.Contains(strings.ToLower(c.r.Header.Get("Accept")), "wsdl") {
		wantsWSDL = true
	}
	if !wantsWSDL {
		c.writeJSON(http.StatusMethodNotAllowed, map[string]any{
			"error": "Use POST with a SOAP envelope. /soap/petservice?wsdl returns the WSDL.",
		})
		return
	}
	location := soapBase(c.r) + "/soap/petservice"
	c.writeRaw(http.StatusOK, "text/xml",
		[]byte(strings.Replace(WSDL, ServiceLocationPlaceholder, location, 1)))
}

// soapBase reconstructs `scheme://host` for the WSDL service location, honouring
// a proxy's forwarded headers — a gateway in front of us is the normal case, and
// advertising our own loopback address would make the WSDL useless to import.
func soapBase(r *http.Request) string {
	proto := r.Header.Get("X-Forwarded-Proto")
	if proto == "" {
		if r.TLS != nil {
			proto = "https"
		} else {
			proto = "http"
		}
	}
	host := r.Header.Get("X-Forwarded-Host")
	if host == "" {
		host = r.Host
	}
	return proto + "://" + host
}

func handleSoap(c *reqCtx) {
	body := c.textBody
	if len(body) == 0 {
		c.writeXML(http.StatusBadRequest, SoapFault("Empty body (missing text/xml parser?)"))
		return
	}
	if !strings.Contains(body, "Envelope") || !IsWellFormedXML(body) {
		c.writeXML(http.StatusBadRequest, SoapFault("Malformed SOAP envelope"))
		return
	}
	op := DetectOperation(c.r.Header.Get("SOAPAction"), body)
	if op == "" {
		c.writeXML(http.StatusBadRequest, SoapFault("Unknown operation; set SOAPAction header"))
		return
	}
	ok, xml := ExecuteOperation(op, body, c.srv.Store)
	if c.padBytes > 0 {
		xml = PadEnvelope(xml, c.padBytes)
	}
	status := http.StatusOK
	if !ok {
		status = http.StatusBadRequest
	}
	c.writeXML(status, xml)
}

func (c *reqCtx) writeXML(status int, xml string) {
	c.writeRaw(status, "text/xml", []byte(xml))
}

// ---- admin handlers ----

func handleGetLatency(c *reqCtx) { c.writeJSON(http.StatusOK, c.srv.Profile.Latency()) }

func handlePatchLatency(c *reqCtx) {
	body := c.jsonBody
	if body == nil {
		body = map[string]any{}
	}
	patch, err := ValidateLatencyPatch(body)
	if err != "" {
		c.writeJSON(http.StatusBadRequest, map[string]any{"error": err})
		return
	}
	c.writeJSON(http.StatusOK, c.srv.Profile.Patch(patch))
}

func handleGetChaos(c *reqCtx) { c.writeJSON(http.StatusOK, c.srv.Profile.Chaos()) }

func handlePutChaos(c *reqCtx) {
	c.writeJSON(http.StatusOK, c.srv.Profile.SetChaos(SanitizeChaos(c.jsonBody)))
}

func handleAdminPetstore(c *reqCtx) {
	c.writeJSON(http.StatusOK, map[string]any{
		"pets":     c.srv.Store.Count(),
		"orders":   c.srv.Store.OrderCount(),
		"chaos":    c.srv.Profile.Chaos(),
		"capacity": LimitPetStoreSize,
	})
}
