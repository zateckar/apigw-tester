package worker

import (
	"io"
	"net"
	"testing"

	"github.com/apigw-tester/go/internal/config"
	"github.com/apigw-tester/go/internal/wire"
)

// discardSink accepts and throws away whatever the worker writes, so the flush
// path runs for real without a control plane.
func discardSink(t *testing.T) *wire.ResultsSink {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() { _, _ = io.Copy(io.Discard, c) }()
		}
	}()
	return wire.NewResultsSink(ln.Addr().String())
}

// idleWorker is a worker wired to nothing that will answer: zero rps, so no
// request is ever issued and the test is about run lifecycle only.
func idleWorker(t *testing.T) *Worker {
	t.Helper()
	w := New(Params{Emitter: wire.NewEmitter(io.Discard), Sink: discardSink(t)})
	t.Cleanup(w.Shutdown)
	zero := 0.0
	w.Configure(&config.Configure{
		Gw: config.GwTargets{
			Rest: config.GwConfig{BaseURL: "http://127.0.0.1:1"},
			Soap: config.GwConfig{BaseURL: "http://127.0.0.1:1"},
		},
		Profile: config.LoadProfile{Mode: "constant", RPS: &zero, MaxConcurrency: 1},
	})
	return w
}

func TestRunsCanBeStartedAndStoppedRepeatedly(t *testing.T) {
	// The control plane spawns one worker and reuses it for every run. Each run
	// gets a fresh tick goroutine, and the previous one closed its done channel
	// on the way out — reusing that channel panicked on the second run's stop,
	// which killed the process before Stop's final flush and lost that run's
	// last batch. A panic on any goroutine fails this test by taking the binary
	// down with it, which is the point.
	w := idleWorker(t)
	for i := 0; i < 4; i++ {
		w.Start("run-" + string(rune('a'+i)))
		w.Stop()
	}
}

func TestStopIsSafeWhenIdle(t *testing.T) {
	w := idleWorker(t)
	w.Stop() // never started
	w.Start("run-1")
	w.Stop()
	w.Stop() // already stopped
}

func TestShutdownAfterARunDoesNotBlock(t *testing.T) {
	// Shutdown stops the run, then waits on the flush and status goroutines.
	// t.Cleanup calls it a second time; sync.Once has to hold.
	w := idleWorker(t)
	w.Start("run-1")
	w.Stop()
	w.Shutdown()
}
