// Command gwtester-sut runs the bundled Petstore (REST + SOAP) as its own OS
// process.
//
// It is the system under test. The gateway being measured proxies to it, and
// the load generator calls the gateway — so nothing in this process shares a
// runtime with the control plane that records the measurements. That separation
// is the whole point: see the package comment in internal/sut.
//
// Lifecycle is the same shape as gwtester-worker's. The parent spawns it, reads
// one line of JSON from stdout to learn the bound port (PORT=0 asks the OS for a
// free one), and terminates it with SIGTERM. Logs go to stderr so stdout stays a
// clean control channel.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/apigw-tester/go/internal/sut"
)

const defaultPort = 8081

// shutdownGrace bounds how long in-flight requests get to finish. A chaos
// "timeout" response deliberately holds for 30s, and waiting that out on every
// restart would make the rig painful to operate, so the grace period is set
// below it and the stragglers are dropped.
const shutdownGrace = 5 * time.Second

func main() {
	port := envInt("SUT_PORT", defaultPort)

	srv := sut.NewServer(expectedAuthHeader())

	ln, err := net.Listen("tcp", listenHost()+":"+strconv.Itoa(port))
	if err != nil {
		// a bound-but-unreachable SUT is worse than no SUT: the run would
		// measure the gateway's connection failures and call them latency
		fatal("listen on port %d: %v", port, err)
	}
	bound := ln.Addr().(*net.TCPAddr).Port

	httpSrv := &http.Server{
		Handler: srv,
		// Slowloris protection without touching the response path. There is
		// deliberately no WriteTimeout: /api/slow honours up to 10s and a chaos
		// "timeout" holds for 30s, and a write deadline would turn those into
		// connection errors that the run would score against the gateway.
		ReadHeaderTimeout: 10 * time.Second,
		// Keep pooled connections warm. The rig reports connection-setup share
		// as a first-class number, and an idle timeout shorter than the
		// reference stream's inter-arrival gap would manufacture handshakes
		// that the gateway then gets charged for.
		IdleTimeout:    120 * time.Second,
		MaxHeaderBytes: 1 << 20,
	}

	announce(map[string]any{"op": "ready", "port": bound, "pid": os.Getpid()})

	serveErr := make(chan error, 1)
	go func() {
		err := httpSrv.Serve(ln)
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		serveErr <- err
	}()

	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, os.Interrupt, syscall.SIGTERM)

	select {
	case err := <-serveErr:
		if err != nil {
			fatal("serve: %v", err)
		}
	case <-sigs:
		ctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
		defer cancel()
		if err := httpSrv.Shutdown(ctx); err != nil {
			// in-flight requests outlived the grace period; the listener is
			// closed either way, so this is worth saying but not worth failing
			fmt.Fprintf(os.Stderr, "[sut] shutdown: %v\n", err)
		}
	}
}

// announce writes one line of JSON to stdout. The parent reads this to learn the
// port, so nothing else may ever be written there.
func announce(v map[string]any) {
	line, err := json.Marshal(v)
	if err != nil {
		fatal("announce: %v", err)
	}
	fmt.Fprintf(os.Stdout, "%s\n", line)
	// the parent blocks on this line to learn the port; a buffered pipe that
	// never flushes would read as a startup hang
	_ = os.Stdout.Sync()
}

// expectedAuthHeader derives the exact Authorization value to accept from
// APP_BASIC_AUTH ("name:password"), matching packages/app/src/auth.ts. An unset
// or malformed value yields "", and the server then fails closed with a 503
// rather than serving unauthenticated.
func expectedAuthHeader() string {
	raw := strings.TrimSpace(os.Getenv("APP_BASIC_AUTH"))
	if raw == "" {
		return ""
	}
	i := strings.Index(raw, ":")
	if i <= 0 || i == len(raw)-1 {
		return ""
	}
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(raw))
}

// listenHost defaults to every interface, like the control plane's own server.
// The gateway under test is usually a separate host or container and has to be
// able to reach the backend it is fronting, so loopback-only would be the wrong
// default — and the Basic-auth gate applies here exactly as it does there.
// SUT_HOST=127.0.0.1 restricts it when the gateway is local.
func listenHost() string {
	if h := strings.TrimSpace(os.Getenv("SUT_HOST")); h != "" {
		return h
	}
	return "0.0.0.0"
}

func envInt(name string, def int) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < 0 || n > 65535 {
		return def
	}
	return n
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "[sut] "+format+"\n", args...)
	os.Exit(1)
}
