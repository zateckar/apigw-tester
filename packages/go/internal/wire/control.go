// Package wire implements the worker's control and result channels:
// line-delimited JSON on stdin/stdout and NDJSON over a TCP results socket.
package wire

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"

	"github.com/apigw-tester/go/internal/config"
)

// StartOp carries the run identity for a {"op":"start"} message.
type StartOp struct {
	RunID string
}

// Message is one decoded control line. Exactly one payload field is set,
// selected by Op ("configure", "start" or "stop").
type Message struct {
	Op        string
	Configure *config.Configure
	Start     *StartOp
}

// envelope is the on-the-wire union of all control messages.
type envelope struct {
	Op          string           `json:"op"`
	Gw          config.GwTargets `json:"gw"`
	Profile     json.RawMessage  `json:"profile"`
	BaselineURL string           `json:"baselineUrl"`
	SelfOrigin  string           `json:"selfOrigin"`
	BasicAuth   string           `json:"basicAuth"`
	RunID       string           `json:"runId"`
}

// Handler receives decoded control messages. Returning an error stops the
// reader loop.
type Handler interface {
	Handle(m Message) error
}

// HandlerFunc adapts a plain function to Handler.
type HandlerFunc func(m Message) error

// Handle calls f.
func (f HandlerFunc) Handle(m Message) error { return f(m) }

// HandlerFuncAsHandler is an alias kept for readability at call sites.
func HandlerFuncAsHandler(f func(m Message) error) Handler { return HandlerFunc(f) }

// MaxControlLine bounds one control message (1MB is far beyond any profile).
const MaxControlLine = 1 << 20

// ReadLines consumes line-delimited JSON control messages from r until EOF,
// dispatching each to h. Unknown ops are ignored. A malformed line terminates
// the loop with an error; callers should treat that as fatal for the process.
func ReadLines(r io.Reader, h Handler) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), MaxControlLine)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var env envelope
		if err := json.Unmarshal(line, &env); err != nil {
			return fmt.Errorf("control: malformed message: %w", err)
		}
		switch env.Op {
		case "configure":
			var p config.LoadProfile
			if len(env.Profile) > 0 {
				if err := json.Unmarshal(env.Profile, &p); err != nil {
					return fmt.Errorf("control: malformed profile: %w", err)
				}
			}
			cfg := &config.Configure{
				Gw:          env.Gw,
				Profile:     p,
				BaselineURL: env.BaselineURL,
				SelfOrigin:  env.SelfOrigin,
				BasicAuth:   env.BasicAuth,
			}
			if err := h.Handle(Message{Op: "configure", Configure: cfg}); err != nil {
				return err
			}
		case "start":
			if err := h.Handle(Message{Op: "start", Start: &StartOp{RunID: env.RunID}}); err != nil {
				return err
			}
		case "stop":
			if err := h.Handle(Message{Op: "stop"}); err != nil {
				return err
			}
		default:
			// forward-compatible: ignore unknown ops
		}
	}
	return sc.Err()
}
