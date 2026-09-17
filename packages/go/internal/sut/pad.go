package sut

import "sync"

// Response padding.
//
// The point is to make responses the size a real API's responses are, because
// response size is what decides whether a gateway buffers, streams, compresses
// or chunks — and those are among the most expensive things a gateway does. A
// rig that only ever moved 200-byte bodies would report an overhead figure that
// no production traffic would ever reproduce.
//
// The TS petstore padded by rebuilding the payload with a `_pad` property and
// re-stringifying, then cached the result per rounded target size because doing
// that per request dominated its event loop. Here the pad is spliced into
// already-marshalled bytes, which is one allocation and one copy, so there is
// nothing left worth caching — and no cache to serve a stale body out of.

// padKey is the JSON fragment introducing the filler: `,"_pad":"` … `"`.
const padOpen = `,"_pad":"`
const padClose = `"`

// padOverhead is what the fragment costs before any filler.
const padOverhead = len(padOpen) + len(padClose)

var (
	fillerMu sync.RWMutex
	filler   = make([]byte, 64*1024)
)

func init() {
	for i := range filler {
		filler[i] = 'x'
	}
}

// fillerOf returns a slice of n filler bytes, growing the shared buffer if this
// is the largest request so far. Sizes settle within the first few requests —
// the default targets are 8KB, 50KB and 3KB — so the write lock is effectively
// never taken on the hot path.
func fillerOf(n int) []byte {
	fillerMu.RLock()
	if n <= len(filler) {
		defer fillerMu.RUnlock()
		return filler[:n]
	}
	fillerMu.RUnlock()

	fillerMu.Lock()
	defer fillerMu.Unlock()
	if n > len(filler) {
		grown := make([]byte, n)
		for i := range grown {
			grown[i] = 'x'
		}
		filler = grown
	}
	return filler[:n]
}

// PadJSON grows a marshalled JSON object to exactly targetBytes by splicing a
// `_pad` string in before the closing brace. Returns the input untouched when
// the target is not comfortably larger than the object, when the target exceeds
// the hard ceiling, or when the input is not a brace-terminated object.
func PadJSON(body []byte, targetBytes int) []byte {
	if targetBytes > LimitPadBytes {
		targetBytes = LimitPadBytes
	}
	need := targetBytes - len(body) - padOverhead
	if need <= 0 || len(body) < 2 || body[len(body)-1] != '}' {
		return body
	}
	// `{}` has no preceding member, so the separating comma would be a syntax
	// error. No padded route currently returns an empty object, but a padder
	// that can emit invalid JSON is a trap for the next one that does.
	open := padOpen
	if len(body) == 2 {
		open = padOpen[1:]
		need++
	}
	out := make([]byte, 0, targetBytes)
	out = append(out, body[:len(body)-1]...)
	out = append(out, open...)
	out = append(out, fillerOf(need)...)
	out = append(out, padClose...)
	out = append(out, '}')
	return out
}
