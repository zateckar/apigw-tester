package scen

import (
	"encoding/json"
	"fmt"
	"math/rand/v2"

	"github.com/apigw-tester/worker/internal/config"
)

// DefaultStressMix mirrors DEFAULT_STRESS_MIX in scenarios.ts: the split of
// non-SOAP, non-invalid traffic across the REST stress classes.
var DefaultStressMix = [][2]any{
	{"small-rest", 55.0},
	{"big-response", 8.0},
	{"big-request", 2.0},
	{"slow-upstream", 6.0},
	{"concurrency", 9.0},
}

var stressMixSum = 55.0 + 8.0 + 2.0 + 6.0 + 9.0

// PickClass honours the operator's knobs: invalidRatioPct slices off contract
// violations, soapRatioPct takes a share of the remainder, and the rest
// splits by DefaultStressMix. Mirrors pickClass in scenarios.ts.
func PickClass(p *config.LoadProfile) string {
	if rand.Float64()*100 < p.InvalidRatioPct {
		return "invalid"
	}
	if rand.Float64()*100 < p.SoapRatioPct {
		return "soap"
	}
	return weightedPick(DefaultStressMix, stressMixSum)
}

// BuildSpec builds a concrete request for the class chosen per profile,
// mirroring buildSpec in scenarios.ts.
func BuildSpec(p *config.LoadProfile, ids *IDTracker) *Spec {
	switch PickClass(p) {
	case "soap":
		return BuildSoapSpec(ids)
	case "big-response":
		return BuildBigResponseSpec()
	case "big-request":
		return BuildBigRequestSpec()
	case "slow-upstream":
		return BuildSlowSpec()
	case "concurrency":
		return BuildConcurrencySpec(ids)
	case "invalid":
		return BuildInvalidSpec(ids)
	default:
		return BuildRestSpec(p, ids)
	}
}

// BuildRestSpec implements the small-rest class: the weighted small-CRUD mix
// driven by profile.scenarioWeights. Mirrors buildRestSpec in scenarios.ts.
func BuildRestSpec(p *config.LoadProfile, ids *IDTracker) *Spec {
	w := p.ScenarioWeights
	scenario := weightedPick([][2]any{
		{"listPets", w.ListPets},
		{"getPet", w.GetPet},
		{"createPet", w.CreatePet},
		{"updatePet", w.UpdatePet},
		{"deletePet", w.DeletePet},
		{"placeOrder", w.PlaceOrder},
	}, w.ListPets+w.GetPet+w.CreatePet+w.UpdatePet+w.DeletePet+w.PlaceOrder)

	switch scenario {
	case "listPets":
		status := pickStr(petStatuses)
		size := 10 + rand.IntN(30)
		return &Spec{
			Protocol: "rest", Endpoint: "GET /api/pets", Class: "small-rest",
			Method: "GET", Path: fmt.Sprintf("/api/pets?status=%s&size=%d", status, size),
			Headers: map[string]string{},
		}
	case "getPet":
		id := ids.ExistingPetID()
		if rand.Float64() < 0.2 {
			return &Spec{
				Protocol: "rest", Endpoint: "GET /api/pets/{id}/photo", Class: "small-rest",
				Method: "GET", Path: fmt.Sprintf("/api/pets/%d/photo", id),
				Headers: map[string]string{},
			}
		}
		return &Spec{
			Protocol: "rest", Endpoint: "GET /api/pets/{id}", Class: "small-rest",
			Method: "GET", Path: fmt.Sprintf("/api/pets/%d", id),
			Headers: map[string]string{},
		}
	case "createPet":
		name := fmt.Sprintf("%s %d", pickStr(petNames), rand.IntN(999))
		body, _ := json.Marshal(map[string]any{
			"name":      name,
			"status":    pickStr(petStatuses),
			"category":  map[string]any{"id": 1 + rand.IntN(8), "name": "Dog"},
			"tags":      []map[string]any{{"id": 1, "name": "synthetic"}},
			"photoUrls": []string{"https://cdn.example.test/pets/synthetic.jpg"},
		})
		return &Spec{
			Protocol: "rest", Endpoint: "POST /api/pets", Class: "small-rest",
			Method: "POST", Path: "/api/pets",
			Headers:   map[string]string{"Content-Type": "application/json"},
			Body:      body,
			CaptureID: true,
		}
	case "updatePet":
		body, _ := json.Marshal(map[string]any{"status": pickStr(petStatuses)})
		return &Spec{
			Protocol: "rest", Endpoint: "PUT /api/pets/{id}", Class: "small-rest",
			Method: "PUT", Path: fmt.Sprintf("/api/pets/%d", ids.ExistingPetID()),
			Headers: map[string]string{"Content-Type": "application/json"},
			Body:    body,
		}
	case "deletePet":
		return &Spec{
			Protocol: "rest", Endpoint: "DELETE /api/pets/{id}", Class: "small-rest",
			Method: "DELETE", Path: fmt.Sprintf("/api/pets/%d", ids.DeletablePetID()),
			Headers: map[string]string{},
		}
	default: // placeOrder
		body, _ := json.Marshal(map[string]any{
			"petId":    ids.ExistingPetID(),
			"quantity": 1 + rand.IntN(3),
		})
		return &Spec{
			Protocol: "rest", Endpoint: "POST /api/store/order", Class: "small-rest",
			Method: "POST", Path: "/api/store/order",
			Headers: map[string]string{"Content-Type": "application/json"},
			Body:    body,
		}
	}
}

// BuildSoapSpec mirrors buildSoapSpec in scenarios.ts.
func BuildSoapSpec(ids *IDTracker) *Spec {
	r := rand.Float64()
	var op, inner string
	switch {
	case r < 0.5:
		op = "getPetById"
		inner = fmt.Sprintf("<tns:getPetByIdRequest><petId>%d</petId></tns:getPetByIdRequest>", ids.ExistingPetID())
	case r < 0.8:
		op = "findPetsByStatus"
		inner = fmt.Sprintf("<tns:findPetsByStatusRequest><status>%s</status></tns:findPetsByStatusRequest>", pickStr(petStatuses))
	default:
		op = "placeOrder"
		inner = fmt.Sprintf("<tns:placeOrderRequest><petId>%d</petId><quantity>%d</quantity></tns:placeOrderRequest>",
			ids.ExistingPetID(), 1+rand.IntN(3))
	}
	return &Spec{
		Protocol: "soap", Endpoint: "SOAP " + op, Class: "soap",
		Method: "POST", Path: "/soap/petservice",
		Headers: map[string]string{
			"Content-Type": "text/xml; charset=utf-8",
			"SOAPAction":   `"` + op + `"`,
		},
		Body: []byte(Envelope(inner)),
	}
}

// BuildBigResponseSpec mirrors buildBigResponseSpec in scenarios.ts.
func BuildBigResponseSpec() *Spec {
	size := []int{256 * 1024, 1024 * 1024, 4 * 1024 * 1024}[rand.IntN(3)]
	return &Spec{
		Protocol: "rest", Endpoint: "GET /api/big/{size}", Class: "big-response",
		Method: "GET", Path: fmt.Sprintf("/api/big/%d", size),
		Headers: map[string]string{},
	}
}

// bigRequestSizes are the undocumented upload sizes, mirroring scenarios.ts.
var bigRequestSizes = []int{64 * 1024, 256 * 1024, 1024 * 1024}

// BuildBigRequestSpec mirrors buildBigRequestSpec in scenarios.ts. The padded
// bodies are built once per size and shared.
func BuildBigRequestSpec() *Spec {
	size := bigRequestSizes[rand.IntN(len(bigRequestSizes))]
	return &Spec{
		Protocol: "rest", Endpoint: "POST /api/echo", Class: "big-request",
		Method: "POST", Path: "/api/echo",
		Headers: map[string]string{"Content-Type": "application/json"},
		Body:    PadBody(size),
	}
}

// BuildSlowSpec mirrors buildSlowSpec in scenarios.ts.
func BuildSlowSpec() *Spec {
	ms := []int{500, 1000, 2000}[rand.IntN(3)]
	return &Spec{
		Protocol: "rest", Endpoint: "GET /api/slow/{ms}", Class: "slow-upstream",
		Method: "GET", Path: fmt.Sprintf("/api/slow/%d", ms),
		Headers: map[string]string{},
	}
}

// BuildConcurrencySpec mirrors buildConcurrencySpec in scenarios.ts.
func BuildConcurrencySpec(ids *IDTracker) *Spec {
	if rand.Float64() < 0.5 {
		return &Spec{
			Protocol: "rest", Endpoint: "GET /api/pets", Class: "concurrency",
			Method: "GET", Path: "/api/pets?size=5",
			Headers: map[string]string{},
		}
	}
	return &Spec{
		Protocol: "rest", Endpoint: "GET /api/pets/{id}", Class: "concurrency",
		Method: "GET", Path: fmt.Sprintf("/api/pets/%d", ids.ExistingPetID()),
		Headers: map[string]string{},
	}
}

// BuildInvalidSpec mirrors buildInvalidSpec in scenarios.ts: the same eleven
// contract-violating variants, one drawn uniformly.
func BuildInvalidSpec(ids *IDTracker) *Spec {
	return invalidVariants[rand.IntN(len(invalidVariants))](ids)
}

var invalidVariants = []func(ids *IDTracker) *Spec{
	// body: required property missing
	func(ids *IDTracker) *Spec {
		return &Spec{
			Protocol: "rest", Endpoint: "POST /api/pets [invalid:missing-required]", Class: "invalid",
			Method: "POST", Path: "/api/pets",
			Headers: map[string]string{"Content-Type": "application/json"},
			Body:    []byte(`{"status":"available"}`), ExpectInvalid: true,
		}
	},
	// body: wrong type for a declared property
	func(ids *IDTracker) *Spec {
		return &Spec{
			Protocol: "rest", Endpoint: "POST /api/pets [invalid:wrong-type]", Class: "invalid",
			Method: "POST", Path: "/api/pets",
			Headers: map[string]string{"Content-Type": "application/json"},
			Body:    []byte(`{"name":12345}`), ExpectInvalid: true,
		}
	},
	// body: value outside the declared enum
	func(ids *IDTracker) *Spec {
		return &Spec{
			Protocol: "rest", Endpoint: "POST /api/pets [invalid:bad-enum]", Class: "invalid",
			Method: "POST", Path: "/api/pets",
			Headers: map[string]string{"Content-Type": "application/json"},
			Body:    []byte(`{"name":"Contract Breaker","status":"liquidated"}`), ExpectInvalid: true,
		}
	},
	// query: value outside the declared enum
	func(ids *IDTracker) *Spec {
		return &Spec{
			Protocol: "rest", Endpoint: "GET /api/pets [invalid:bad-enum-query]", Class: "invalid",
			Method: "GET", Path: "/api/pets?status=teleported",
			Headers: map[string]string{}, ExpectInvalid: true,
		}
	},
	// query: number outside the declared range
	func(ids *IDTracker) *Spec {
		return &Spec{
			Protocol: "rest", Endpoint: "GET /api/pets [invalid:range]", Class: "invalid",
			Method: "GET", Path: "/api/pets?size=9999",
			Headers: map[string]string{}, ExpectInvalid: true,
		}
	},
	// path: wrong primitive type
	func(ids *IDTracker) *Spec {
		return &Spec{
			Protocol: "rest", Endpoint: "GET /api/pets/{id} [invalid:path-type]", Class: "invalid",
			Method: "GET", Path: "/api/pets/not-a-number",
			Headers: map[string]string{}, ExpectInvalid: true,
		}
	},
	// body: wrong type on a nested required property
	func(ids *IDTracker) *Spec {
		return &Spec{
			Protocol: "rest", Endpoint: "POST /api/store/order [invalid:wrong-type]", Class: "invalid",
			Method: "POST", Path: "/api/store/order",
			Headers:       map[string]string{"Content-Type": "application/json"},
			Body:          []byte(fmt.Sprintf(`{"petId":"%d","quantity":0}`, ids.ExistingPetID())),
			ExpectInvalid: true,
		}
	},
	// SOAP: element that violates the declared enumeration
	func(ids *IDTracker) *Spec {
		return &Spec{
			Protocol: "soap", Endpoint: "SOAP findPetsByStatus [invalid:bad-enum]", Class: "invalid",
			Method: "POST", Path: "/soap/petservice",
			Headers:       map[string]string{"Content-Type": "text/xml; charset=utf-8", "SOAPAction": `"findPetsByStatus"`},
			Body:          []byte(Envelope("<tns:findPetsByStatusRequest><status>zombified</status></tns:findPetsByStatusRequest>")),
			ExpectInvalid: true,
		}
	},
	// SOAP: mandatory element missing
	func(ids *IDTracker) *Spec {
		return &Spec{
			Protocol: "soap", Endpoint: "SOAP getPetById [invalid:missing-element]", Class: "invalid",
			Method: "POST", Path: "/soap/petservice",
			Headers:       map[string]string{"Content-Type": "text/xml; charset=utf-8", "SOAPAction": `"getPetById"`},
			Body:          []byte(Envelope("<tns:getPetByIdRequest></tns:getPetByIdRequest>")),
			ExpectInvalid: true,
		}
	},
	// SOAP: not a well-formed envelope at all
	func(ids *IDTracker) *Spec {
		return &Spec{
			Protocol: "soap", Endpoint: "SOAP [invalid:malformed-xml]", Class: "invalid",
			Method: "POST", Path: "/soap/petservice",
			Headers:       map[string]string{"Content-Type": "text/xml; charset=utf-8", "SOAPAction": `"getPetById"`},
			Body:          []byte(`<?xml version="1.0"?><soap:Envelope><soap:Body><tns:getPetByIdRequest><petId>1</petId>`),
			ExpectInvalid: true,
		}
	},
	// query: range violation on a second parameter (keeps the TS count at 11)
	func(ids *IDTracker) *Spec {
		return &Spec{
			Protocol: "rest", Endpoint: "GET /api/pets [invalid:range-negative]", Class: "invalid",
			Method: "GET", Path: "/api/pets?size=-5",
			Headers: map[string]string{}, ExpectInvalid: true,
		}
	}}

// BuildBaselineProbe returns the seven fixed probes used to calibrate direct
// transport per class, mirroring buildBaselineProbe in scenarios.ts.
func BuildBaselineProbe(ids *IDTracker) []*Spec {
	return []*Spec{
		{Protocol: "rest", Endpoint: "GET /api/pets", Class: "small-rest", Method: "GET",
			Path: "/api/pets?size=10", Headers: map[string]string{}},
		{Protocol: "soap", Endpoint: "SOAP getPetById", Class: "soap", Method: "POST",
			Path:    "/soap/petservice",
			Headers: map[string]string{"Content-Type": "text/xml; charset=utf-8", "SOAPAction": `"getPetById"`},
			Body:    []byte(Envelope(fmt.Sprintf("<tns:getPetByIdRequest><petId>%d</petId></tns:getPetByIdRequest>", ids.ExistingPetID())))},
		BuildBigResponseSpec(),
		{Protocol: "rest", Endpoint: "POST /api/echo", Class: "big-request", Method: "POST",
			Path:    "/api/echo",
			Headers: map[string]string{"Content-Type": "application/json"},
			Body:    PadBody(64 * 1024)},
		{Protocol: "rest", Endpoint: "GET /api/slow/{ms}", Class: "slow-upstream", Method: "GET",
			Path: "/api/slow/500", Headers: map[string]string{}},
		{Protocol: "rest", Endpoint: "GET /api/pets", Class: "concurrency", Method: "GET",
			Path: "/api/pets?size=5", Headers: map[string]string{}},
		{Protocol: "rest", Endpoint: "GET /api/pets [invalid:bad-enum-query]", Class: "invalid", Method: "GET",
			Path: "/api/pets?status=teleported", Headers: map[string]string{}, ExpectInvalid: true},
	}
}
