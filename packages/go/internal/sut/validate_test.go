package sut

import (
	"encoding/json"
	"testing"
)

// parse turns a JSON literal into the `any` shape the handlers receive, so the
// validators are exercised on exactly what the wire produces — a string "120"
// stays a string, and every number arrives as a float64.
func parse(t *testing.T, s string) any {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(s), &v); err != nil {
		t.Fatalf("bad test fixture %q: %v", s, err)
	}
	return v
}

func TestValidateNewPetAcceptsTheDocumentedShape(t *testing.T) {
	in, err := ValidateNewPet(parse(t, `{
		"name":"Rex","status":"pending",
		"category":{"id":3,"name":"Dog"},
		"tags":[{"id":1,"name":"friendly"}],
		"photoUrls":["https://example.test/a.jpg"],
		"description":"a good dog"
	}`))
	if err != "" {
		t.Fatalf("rejected a valid pet: %s", err)
	}
	if in.Name != "Rex" || in.Status == nil || *in.Status != "pending" {
		t.Fatalf("parsed: %+v", in)
	}
	if in.Category == nil || in.Category.ID != 3 || len(in.Tags) != 1 || len(in.PhotoURLs) != 1 {
		t.Fatalf("parsed: %+v", in)
	}
}

// These are the generator's deliberately invalid variants. Every one must be
// refused: a run scores the gateway on whether contract violations were stopped,
// and a SUT that accepts them reports the gateway as leaking traffic it never
// actually leaked.
func TestValidateNewPetRefusesTheInvalidSlice(t *testing.T) {
	cases := []struct{ name, body, want string }{
		{"missing-required", `{"status":"available"}`, "name is required and must be a string of 1-200 characters"},
		{"wrong-type", `{"name":12345}`, "name is required and must be a string of 1-200 characters"},
		{"bad-enum", `{"name":"Contract Breaker","status":"liquidated"}`, "status must be one of available|pending|sold"},
		{"empty-name", `{"name":""}`, "name is required and must be a string of 1-200 characters"},
		{"not-an-object", `[1,2,3]`, "body must be a JSON object"},
		{"null", `null`, "body must be a JSON object"},
		{"category-not-object", `{"name":"A","category":"Dog"}`, "category must be an object"},
		{"category-bad-id", `{"name":"A","category":{"id":-1,"name":"Dog"}}`, "category.id must be a non-negative integer"},
		{"category-fractional-id", `{"name":"A","category":{"id":1.5,"name":"Dog"}}`, "category.id must be a non-negative integer"},
		{"too-many-tags", `{"name":"A","tags":[` + repeatJSON(`{"id":1,"name":"t"}`, 21) + `]}`, "tags must be an array of at most 20 entries"},
		{"photourls-not-strings", `{"name":"A","photoUrls":[1]}`, "photoUrls must be an array of at most 10 strings"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := ValidateNewPet(parse(t, c.body))
			if err != c.want {
				t.Fatalf("got %q want %q", err, c.want)
			}
		})
	}
}

func repeatJSON(s string, n int) string {
	out := ""
	for i := 0; i < n; i++ {
		if i > 0 {
			out += ","
		}
		out += s
	}
	return out
}

func TestValidateUpdatePetNeedsAtLeastOneField(t *testing.T) {
	if _, err := ValidateUpdatePet(parse(t, `{}`)); err != "body must set at least one of name, status, description" {
		t.Fatalf("empty patch: %q", err)
	}
	if _, err := ValidateUpdatePet(parse(t, `{"status":"available"}`)); err != "" {
		t.Fatalf("valid patch rejected: %q", err)
	}
	if _, err := ValidateUpdatePet(parse(t, `{"status":"teleported"}`)); err == "" {
		t.Fatal("bad enum accepted")
	}
}

func TestValidateOrderRejectsAStringPetIDAndAZeroQuantity(t *testing.T) {
	// the generator's nested-wrong-type variant sends exactly this
	if _, _, err := ValidateOrder(parse(t, `{"petId":"120","quantity":0}`)); err == "" {
		t.Fatal("string petId accepted")
	}
	if _, _, err := ValidateOrder(parse(t, `{"petId":120,"quantity":0}`)); err != "quantity must be an integer between 1 and 100" {
		t.Fatalf("zero quantity: %q", err)
	}
	if _, _, err := ValidateOrder(parse(t, `{"petId":120,"quantity":101}`)); err == "" {
		t.Fatal("quantity over the ceiling accepted")
	}
	if _, _, err := ValidateOrder(parse(t, `{}`)); err != "petId is required and must be a positive integer" {
		t.Fatalf("missing petId: %q", err)
	}
	pet, qty, err := ValidateOrder(parse(t, `{"petId":7}`))
	if err != "" || pet != 7 || qty != 1 {
		t.Fatalf("defaults: %d %d %q", pet, qty, err)
	}
}

func TestPathIntAcceptsOnlyPositiveIntegers(t *testing.T) {
	cases := map[string]int64{"42": 42, "1": 1}
	for in, want := range cases {
		if got, ok := PathInt(in); !ok || got != want {
			t.Fatalf("PathInt(%q) = %d,%v", in, got, ok)
		}
	}
	for _, in := range []string{"0", "-3", "1.5", "abc", "", " 7", "+7", "07x"} {
		if _, ok := PathInt(in); ok {
			t.Fatalf("PathInt(%q) was accepted", in)
		}
	}
}

func TestHeaderIntClampsAndRejects(t *testing.T) {
	if got, ok := HeaderInt("2147483000", LimitDelayMs); !ok || got != LimitDelayMs {
		t.Fatalf("clamp: %d,%v", got, ok)
	}
	if got, ok := HeaderInt("1099511627776", LimitBigBytes); !ok || got != LimitBigBytes {
		t.Fatalf("clamp: %d,%v", got, ok)
	}
	if got, ok := HeaderInt("250", LimitDelayMs); !ok || got != 250 {
		t.Fatalf("plain: %d,%v", got, ok)
	}
	if got, ok := HeaderInt(" 250 ", LimitDelayMs); !ok || got != 250 {
		t.Fatalf("padded: %d,%v", got, ok)
	}
	// exponent notation must not sneak past the digits-only gate — that input
	// is what used to reach setTimeout as NaN
	for _, in := range []string{"", "0", "-1", "abc", "1e999", "1.5"} {
		if _, ok := HeaderInt(in, LimitDelayMs); ok {
			t.Fatalf("HeaderInt(%q) was accepted", in)
		}
	}
	// longer than int64 but unambiguously past the ceiling
	if got, ok := HeaderInt("99999999999999999999999", LimitDelayMs); !ok || got != LimitDelayMs {
		t.Fatalf("overflow: %d,%v", got, ok)
	}
}

func TestLatencyPatchValidation(t *testing.T) {
	got, err := ValidateLatencyPatch(parse(t, `{"get-pet":{"kind":"fixed","ms":5}}`))
	if err != "" || got["get-pet"].Ms != 5 {
		t.Fatalf("valid patch: %+v %q", got, err)
	}
	if _, err := ValidateLatencyPatch(parse(t, `{"get-pet":{"kind":"normal","meanMs":"soon","stddevMs":1}}`)); err == "" {
		t.Fatal("string meanMs accepted — this is the input that became setTimeout(NaN)")
	}
	if _, err := ValidateLatencyPatch(parse(t, `{"x":{"kind":"teleport"}}`)); err != "x: kind must be one of fixed|uniform|normal" {
		t.Fatalf("unknown kind: %q", err)
	}
	if _, err := ValidateLatencyPatch(parse(t, `{"__proto__":{"kind":"fixed","ms":1}}`)); err != "illegal endpoint key '__proto__'" {
		t.Fatalf("prototype key: %q", err)
	}
	// values are clamped, not rejected, exactly as the TS validator did
	got, _ = ValidateLatencyPatch(parse(t, `{"a":{"kind":"uniform","minMs":900000,"maxMs":-5}}`))
	if got["a"].MinMs != 0 || got["a"].MaxMs != LimitDelayMs {
		t.Fatalf("clamping/ordering: %+v", got["a"])
	}
}

func TestSampleLatencyStaysInRange(t *testing.T) {
	seq := []float64{0, 0.5, 0.999999, 1}
	i := 0
	rnd := func() float64 { v := seq[i%len(seq)]; i++; return v }
	for _, d := range []Distribution{
		{Kind: "fixed", Ms: -10},
		{Kind: "fixed", Ms: 1e9},
		{Kind: "uniform", MinMs: 400, MaxMs: 20},
		{Kind: "normal", MeanMs: 50, StddevMs: 1e9},
		{Kind: "unknown-kind"},
	} {
		for n := 0; n < 20; n++ {
			got := SampleLatency(d, rnd)
			if got < 0 || got > LimitDelayMs || got != got {
				t.Fatalf("%+v produced %v", d, got)
			}
		}
	}
}

func TestChaosSplitsTheRangeWithoutOverlap(t *testing.T) {
	c := Chaos{ErrorRatePct: 10, TimeoutRatePct: 20}
	at := func(r float64) string { return DecideChaos(c, func() float64 { return r }) }
	if at(0.05) != "error" || at(0.25) != "timeout" || at(0.95) != "ok" {
		t.Fatalf("%s %s %s", at(0.05), at(0.25), at(0.95))
	}
	// the boundaries belong to the lower band, and zero rates never fire
	if at(0.10) != "timeout" || at(0.30) != "ok" {
		t.Fatalf("boundaries: %s %s", at(0.10), at(0.30))
	}
	zero := Chaos{}
	if DecideChaos(zero, func() float64 { return 0 }) != "ok" {
		t.Fatal("chaos fired with both rates at zero")
	}
}

func TestSanitizeChaosClamps(t *testing.T) {
	got := SanitizeChaos(parse(t, `{"errorRatePct":-5,"timeoutRatePct":999}`))
	if got.ErrorRatePct != 0 || got.TimeoutRatePct != 100 {
		t.Fatalf("%+v", got)
	}
	if got := SanitizeChaos(parse(t, `{"errorRatePct":"lots"}`)); got.ErrorRatePct != 0 {
		t.Fatalf("non-numeric: %+v", got)
	}
}

func TestPadJSONHitsTheTargetExactlyAndStaysValid(t *testing.T) {
	for _, target := range []int{0, 5, 64, 1200, 8000, 50000} {
		body := []byte(`{"a":1,"b":"two"}`)
		out := PadJSON(body, target)
		if target > len(body)+padOverhead {
			if len(out) != target {
				t.Fatalf("target %d produced %d bytes", target, len(out))
			}
		} else if string(out) != string(body) {
			t.Fatalf("target %d should have been a no-op, got %s", target, out)
		}
		var back map[string]any
		if err := json.Unmarshal(out, &back); err != nil {
			t.Fatalf("target %d produced invalid JSON: %v", target, err)
		}
		if back["a"] != float64(1) || back["b"] != "two" {
			t.Fatalf("padding damaged the payload: %v", back)
		}
	}
}

func TestPadJSONNeverEmitsAnInvalidEmptyObject(t *testing.T) {
	out := PadJSON([]byte(`{}`), 512)
	if len(out) != 512 {
		t.Fatalf("length %d", len(out))
	}
	var back map[string]any
	if err := json.Unmarshal(out, &back); err != nil {
		t.Fatalf("invalid JSON: %v (%s)", err, out[:32])
	}
}

func TestPadJSONRefusesToExceedTheCeiling(t *testing.T) {
	out := PadJSON([]byte(`{"a":1}`), LimitPadBytes*4)
	if len(out) != LimitPadBytes {
		t.Fatalf("pad ceiling not honoured: %d", len(out))
	}
}
