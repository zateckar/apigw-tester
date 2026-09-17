package scen

import (
	"strings"
	"testing"

	"github.com/apigw-tester/go/internal/config"
)

func testProfile() config.LoadProfile {
	return config.LoadProfile{
		Mode:            "constant",
		MaxConcurrency:  25,
		SoapRatioPct:    25,
		InvalidRatioPct: 2,
		ScenarioWeights: config.ScenarioWeights{
			ListPets: 50, GetPet: 20, CreatePet: 10, UpdatePet: 5, DeletePet: 5, PlaceOrder: 10,
		},
	}
}

func TestPadBodyExactSize(t *testing.T) {
	for _, size := range []int{64 * 1024, 256 * 1024, 1024 * 1024} {
		b := PadBody(size)
		if len(b) != size {
			t.Fatalf("size=%d got %d bytes", size, len(b))
		}
		if !strings.HasPrefix(string(b), `{"_pad":"`) {
			t.Fatalf("bad prefix: %q", b[:20])
		}
		// cached: same slice across calls
		if &PadBody(size)[0] != &b[0] {
			t.Fatal("pad body not cached")
		}
	}
}

func TestClassDistributionHonoursRatios(t *testing.T) {
	p := testProfile()
	ids := NewIDTracker(120)
	counts := map[string]int{}
	const n = 50_000
	for i := 0; i < n; i++ {
		s := BuildSpec(&p, ids)
		counts[s.Class]++
	}
	// invalidRatioPct = 2 → ~2% ± 0.5%
	if got := float64(counts["invalid"]) / n * 100; got < 1.5 || got > 2.5 {
		t.Fatalf("invalid ratio %v%%", got)
	}
	// soapRatioPct=25 of remainder
	if got := float64(counts["soap"]) / n * 100; got < 23 || got > 27 {
		t.Fatalf("soap ratio %v%%", got)
	}
	// big-request ≈ 2/80 of the rest after invalid+soap removed
	if counts["big-request"] == 0 || counts["small-rest"] == 0 {
		t.Fatal("class coverage missing")
	}
}

func TestEveryInvalidVariantShape(t *testing.T) {
	ids := NewIDTracker(120)
	for i, mk := range invalidVariants {
		s := mk(ids)
		if s.Class != "invalid" || !s.ExpectInvalid {
			t.Fatalf("variant %d not tagged invalid", i)
		}
		if s.Method == "" || s.Path == "" {
			t.Fatalf("variant %d incomplete", i)
		}
	}
	if len(invalidVariants) != 11 {
		t.Fatalf("want 11 variants, got %d", len(invalidVariants))
	}
}

func TestSOAPSpecShape(t *testing.T) {
	ids := NewIDTracker(120)
	s := BuildSoapSpec(ids)
	if s.Protocol != "soap" || s.Path != "/soap/petservice" {
		t.Fatalf("soap routing wrong: %+v", s)
	}
	if s.Headers["SOAPAction"] == "" || s.Headers["Content-Type"] != "text/xml; charset=utf-8" {
		t.Fatalf("soap headers: %+v", s.Headers)
	}
	body := string(s.Body)
	if !strings.Contains(body, "soap:Envelope") || !strings.Contains(body, "tns:") {
		t.Fatalf("envelope malformed: %s", body)
	}
}

func TestIDTrackerDeletablePrefersCreated(t *testing.T) {
	ids := NewIDTracker(120)
	// with nothing created: falls back to seedId+1+rand(10000)
	for i := 0; i < 5; i++ {
		id := ids.DeletablePetID()
		if id < 121 || id > 10120 {
			t.Fatalf("fallback id %d out of range", id)
		}
	}
	ids.Track(777)
	ids.Track(778)
	got := map[int]bool{ids.DeletablePetID(): true, ids.DeletablePetID(): true}
	if !got[777] || !got[778] {
		t.Fatalf("did not prefer created ids: %v", got)
	}
}
