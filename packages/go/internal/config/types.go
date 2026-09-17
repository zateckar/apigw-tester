// Package config holds the configuration types the worker receives over the
// control channel, mirroring the TypeScript shapes in packages/shared.
package config

// ForwardBasicAuth mirrors the TS "auto" | "always" | "never" union.
type ForwardBasicAuth string

const (
	// ForwardAuto forwards the rig credential only to its own origin.
	ForwardAuto ForwardBasicAuth = "auto"
	// ForwardAlways forwards the rig credential to any target.
	ForwardAlways ForwardBasicAuth = "always"
	// ForwardNever never forwards the rig credential.
	ForwardNever ForwardBasicAuth = "never"
)

// GwConfig mirrors the TS GwConfig interface.
type GwConfig struct {
	BaseURL          string           `json:"baseUrl"`
	APIKey           string           `json:"apiKey"`
	APIKeyHeader     string           `json:"apiKeyHeader"`
	PathPrefix       string           `json:"pathPrefix"`
	ForwardBasicAuth ForwardBasicAuth `json:"forwardBasicAuth"`
}

// GwTargets holds independent REST and SOAP gateway configs.
type GwTargets struct {
	Rest GwConfig `json:"rest"`
	Soap GwConfig `json:"soap"`
}

// ScenarioWeights mirrors the TS ScenarioWeights interface.
type ScenarioWeights struct {
	ListPets   float64 `json:"listPets"`
	GetPet     float64 `json:"getPet"`
	CreatePet  float64 `json:"createPet"`
	UpdatePet  float64 `json:"updatePet"`
	DeletePet  float64 `json:"deletePet"`
	PlaceOrder float64 `json:"placeOrder"`
}

// LoadProfile mirrors the TS LoadProfile interface; optional numeric knobs are
// pointers so absence survives the round trip.
type LoadProfile struct {
	Mode                 string          `json:"mode"`
	DurationMinutes      *float64        `json:"durationMinutes,omitempty"`
	RPS                  *float64        `json:"rps,omitempty"`
	RampFrom             *float64        `json:"rampFrom,omitempty"`
	RampTo               *float64        `json:"rampTo,omitempty"`
	RampMinutes          *float64        `json:"rampMinutes,omitempty"`
	SpikeBase            *float64        `json:"spikeBase,omitempty"`
	SpikePeak            *float64        `json:"spikePeak,omitempty"`
	SpikeEveryMinutes    *float64        `json:"spikeEveryMinutes,omitempty"`
	SpikeDurationSeconds *float64        `json:"spikeDurationSeconds,omitempty"`
	SineMin              *float64        `json:"sineMin,omitempty"`
	SineMax              *float64        `json:"sineMax,omitempty"`
	MaxConcurrency       int             `json:"maxConcurrency"`
	SoapRatioPct         float64         `json:"soapRatioPct"`
	InvalidRatioPct      float64         `json:"invalidRatioPct"`
	ScenarioWeights      ScenarioWeights `json:"scenarioWeights"`
}

// Configure is the payload of the {"op":"configure"} control message.
type Configure struct {
	Gw      GwTargets   `json:"gw"`
	Profile LoadProfile `json:"profile"`
	// SelfOrigin is where the SUT answers with no gateway in front of it. No
	// traffic is sent there; it is what makes forwardBasicAuth "auto" able to
	// tell "this target is us" from "this target is somebody else's gateway".
	SelfOrigin string `json:"selfOrigin"`
	// BasicAuth is the base64 "user:pass" credential, empty when absent.
	BasicAuth string `json:"basicAuth"`
}

// RPSTracker is the interface a LoadProfile plays for the scheduler's cap()
// helper: reach into optional fields with defaults.
type RPSTracker interface {
	Num(p *float64, fallback float64) float64
}

// Num returns the pointed-to value or the fallback.
func Num(p *float64, fallback float64) float64 {
	if p == nil {
		return fallback
	}
	return *p
}
