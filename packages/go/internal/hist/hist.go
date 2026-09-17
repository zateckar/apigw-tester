// Package hist holds the fixed bucket tables the worker rolls results up into.
//
// These arrays ARE the on-disk layout of every histogram column: stored rows
// merge positionally, so an edge added, removed or changed on one side of the
// wire and not the other does not fail — it quietly mixes two different
// distributions into one column and answers every percentile wrong for as long
// as the database lives.
//
// They are duplicated from packages/shared/src/index.ts because Go cannot
// import TypeScript. The duplication is made safe rather than avoided: the
// worker declares these tables in its "ready" message and the control plane
// refuses its results if they differ from its own by so much as one edge.
package hist

import "strconv"

// LatencyEdges mirrors HISTOGRAM_EDGES_MS: 40 log-ish buckets from 1 ms.
var LatencyEdges = buildLatencyEdges()

func buildLatencyEdges() []float64 {
	edges := make([]float64, 0, 40)
	v := 1.0
	for len(edges) < 40 {
		rounded := float64(int64(v + 0.5))
		if len(edges) > 0 && rounded < edges[len(edges)-1]+1 {
			// rounding at the low end collides, e.g. round(1)=1 then round(1.35)=1
			rounded = edges[len(edges)-1] + 1
		} else if len(edges) == 0 && rounded < 1 {
			rounded = 1
		}
		edges = append(edges, rounded)
		v *= 1.35
	}
	return edges
}

// ResidualEdges mirrors RESIDUAL_EDGES_MS: signed, sub-millisecond resolution.
var ResidualEdges = buildResidualEdges()

func buildResidualEdges() []float64 {
	edges := []float64{-100, -30, -10, -3, -1, -0.5, -0.2, -0.1, -0.05, 0}
	for v := 0.02; v < 60_000; v *= 1.3 {
		edges = append(edges, precision4(v))
	}
	return edges
}

// precision4 is JavaScript's Number(v.toPrecision(4)).
//
// Routed through the decimal text on purpose: 1.3^n accumulates a different
// last bit than the TS build's does, and rescaling a mantissa by a computed
// power of ten introduces its own. Formatting to 4 significant digits and
// parsing back lands on exactly the double JS would name, because both sides
// are "nearest double to this decimal string".
func precision4(v float64) float64 {
	f, err := strconv.ParseFloat(strconv.FormatFloat(v, 'g', 4, 64), 64)
	if err != nil {
		return v
	}
	return f
}

// StatusBuckets mirrors STATUS_BUCKETS. Append-only, never reordered.
var StatusBuckets = []string{
	"net", "1xx", "2xx", "3xx",
	"400", "401", "403", "404", "405", "408", "413", "429", "4xx",
	"500", "502", "503", "504", "5xx",
}

var exactStatusBucket = map[int]int{
	400: 4, 401: 5, 403: 6, 404: 7, 405: 8, 408: 9, 413: 10, 429: 11,
	500: 13, 502: 14, 503: 15, 504: 16,
}

// StatusIndex returns the StatusBuckets slot for an HTTP status (0 = no
// response at all).
func StatusIndex(status int) int {
	if status <= 0 {
		return 0
	}
	if i, ok := exactStatusBucket[status]; ok {
		return i
	}
	switch {
	case status < 200:
		return 1
	case status < 300:
		return 2
	case status < 400:
		return 3
	case status < 500:
		return 12
	default:
		return 17
	}
}

// Index returns the bucket a value falls in: the first edge >= v, or
// len(edges) for the overflow slot. Binary search, matching bucketIndex() and
// residualBucketIndex() in packages/app/src/metrics/rollup.ts.
func Index(edges []float64, v float64) int {
	lo, hi := 0, len(edges)-1
	for lo <= hi {
		mid := (lo + hi) / 2
		if v <= edges[mid] {
			hi = mid - 1
		} else {
			lo = mid + 1
		}
	}
	return lo
}

// Add increments the bucket v falls in.
func Add(h []int64, edges []float64, v float64) {
	h[Index(edges, v)]++
}

// NewLatency and NewResidual allocate a counts array of the right width — one
// slot per edge plus the overflow slot.
func NewLatency() []int64  { return make([]int64, len(LatencyEdges)+1) }
func NewResidual() []int64 { return make([]int64, len(ResidualEdges)+1) }
func NewStatus() []int64   { return make([]int64, len(StatusBuckets)) }

// Tables is what the worker declares at handshake so the control plane can
// verify the two implementations agree.
type Tables struct {
	Latency  []float64 `json:"latency"`
	Residual []float64 `json:"residual"`
	Status   []string  `json:"status"`
}

func Declare() Tables {
	return Tables{Latency: LatencyEdges, Residual: ResidualEdges, Status: StatusBuckets}
}
