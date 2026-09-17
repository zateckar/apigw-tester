// Command gwtester-worker is the Go load generator for the API GW Tester.
// It speaks line-delimited JSON control messages on stdin/stdout and streams
// NDJSON result batches to a TCP socket named by RESULTS_ADDR.
package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"

	cfg "github.com/apigw-tester/go/internal/config"
	"github.com/apigw-tester/go/internal/hist"
	"github.com/apigw-tester/go/internal/wire"
	"github.com/apigw-tester/go/internal/worker"
)

func main() {
	emitter := wire.NewEmitter(os.Stdout)
	sink := wire.NewResultsSink(cfg.ResultsAddr())
	w := worker.New(worker.Params{Emitter: emitter, Sink: sink})

	// Control reader (owner: main; exits on EOF or decode error). ReadLines
	// blocks on stdin, so it runs on its own goroutine while main waits for a
	// termination signal.
	controlErr := make(chan error, 1)
	go func() { controlErr <- wire.ReadLines(os.Stdin, w) }()

	emitter.Ready(hist.Declare())

	sig := make(chan os.Signal, 2)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)

	select {
	case s := <-sig:
		fmt.Fprintf(os.Stderr, "[worker] received %v, shutting down\n", s)
	case err := <-controlErr:
		// stdin closed (parent exited) or a malformed line: either way the
		// control plane is gone and the worker must not linger.
		if err != nil {
			fmt.Fprintf(os.Stderr, "[worker] control channel error: %v\n", err)
		}
	}

	w.Shutdown()
	os.Exit(0)
}
