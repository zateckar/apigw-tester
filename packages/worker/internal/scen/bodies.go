// Package scen produces concrete request specs for each scenario class,
// mirroring packages/app/src/loadgen/scenarios.ts.
package scen

import (
	"math/rand/v2"
	"strconv"
	"strings"
	"sync"
)

// Spec is one concrete HTTP request to issue, tagged by scenario class.
type Spec struct {
	Protocol      string // "rest" | "soap"
	Endpoint      string
	Class         string
	Method        string
	Path          string
	Headers       map[string]string
	Body          []byte
	ExpectInvalid bool
	// CaptureID asks the driver to learn a created pet id from the response.
	CaptureID bool
}

var petStatuses = []string{"available", "pending", "sold"}
var petNames = []string{"Buddy", "Luna", "Milo", "Cookie", "Rocky", "Sadie", "Ziggy"}

// Envelope wraps an inner SOAP body in the petstore envelope template,
// mirroring envelope() in scenarios.ts.
func Envelope(inner string) string {
	return `<?xml version="1.0" encoding="utf-8"?>` +
		`<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="http://petstore.apigw.test/soap">` +
		`<soap:Body>` + inner + `</soap:Body></soap:Envelope>`
}

// PadBody returns the cached padded JSON body of exactly size bytes:
// {"_pad":"xxxx…"} with pad sized so the whole document is size bytes.
// Bodies are built once per size and shared (read-only), mirroring
// bigRequestBody in scenarios.ts.
var (
	padMu    sync.Mutex
	padCache = map[int][]byte{}
)

// PadBody returns the shared body for size {65536, 262144, 1048576}.
func PadBody(size int) []byte {
	padMu.Lock()
	defer padMu.Unlock()
	if b, ok := padCache[size]; ok {
		return b
	}
	// {"_pad":"…"}: prefix is 9 bytes, suffix 2; pad fills the remainder so
	// the whole document is exactly size bytes.
	pad := size - 11
	if pad < 0 {
		pad = 0
	}
	var sb strings.Builder
	sb.Grow(size)
	sb.WriteString(`{"_pad":"`)
	sb.WriteString(strings.Repeat("x", pad))
	sb.WriteString(`"}`)
	b := []byte(sb.String())
	padCache[size] = b
	return b
}

func pickStr(arr []string) string { return arr[rand.IntN(len(arr))] }

// weightedPick mirrors the TS weightedPick over string-keyed weights.
func weightedPick(weights [][2]any, sum float64) string {
	if sum <= 0 {
		return weights[0][0].(string)
	}
	r := rand.Float64() * sum
	for _, kv := range weights {
		w := kv[1].(float64)
		if w <= 0 {
			continue
		}
		r -= w
		if r <= 0 {
			return kv[0].(string)
		}
	}
	return weights[len(weights)-1][0].(string)
}

func itoa(n int) string { return strconv.Itoa(n) }
