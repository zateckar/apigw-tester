// Package fire issues individual HTTP requests with TTFB measurement,
// per-class timeout budgets and pooled resources, mirroring fire() in the TS
// driver.
package fire

import (
	"crypto/tls"
	"net"
	"net/http"
	"time"
)

// DialTimeout bounds one TCP connection attempt.
//
// One second, not the five it used to be, because a dial that fails is not a
// slow request — it is a concurrency slot held for the whole timeout. With the
// generator's 5000-slot ceiling, a five-second dial timeout floors throughput
// at 5000/5s = 1000 rps the moment connections start being refused, which is
// exactly the collapse observed at 10k rps on Windows: measured 1891-2653 rps
// against a SUT still answering in 90ms. At one second the same failure costs
// five times less, which is the difference between a dent and a spiral.
//
// A TCP handshake to a gateway on the same network is sub-millisecond and
// across the internet is tens of milliseconds, so this is ample headroom for a
// dial that is going to succeed. TLS negotiation is governed separately by
// TLSHandshakeTimeout, which is left generous.
const DialTimeout = time.Second

// MaxConnsPerHost bounds total connections — active and idle — per host per
// protocol.
//
// A backstop, not a working limit. It must stay above the generator's
// concurrency ceiling (worker.LimitMaxConcurrency, asserted by a test there),
// so a run that is behaving never reaches it and nothing here can add queueing
// time to a measurement. What it stops is the pathological case: when dials
// start failing, the transport will otherwise open sockets without bound, and
// on Windows every socket() and closesocket() is a blocking syscall that pins
// an OS thread. That storm has been observed killing the worker outright —
// 9743 goroutines in net.socket and 9359 in Closesocket, past Go's
// 10000-thread limit, which is a crash rather than a bad measurement. Beyond
// this limit the transport makes requests wait for a connection instead, which
// is back-pressure the generator can survive and report.
const MaxConnsPerHost = 6_000

// IdlePoolPerHost is the idle connection pool. It has to be able to hold every
// connection the concurrency ceiling permits: a pool smaller than peak
// concurrency closes and reopens sockets in steady state for no reason, and
// that churn is what the backstop above exists to catch.
const IdlePoolPerHost = 6_000

// NewTransport returns the tuned transport shared by the load clients:
// generous idle pools (the gateway outlives requests), no compression (the
// SUT bodies are synthetic and compression would only muddy byte counts), and
// a TLS session cache so gateway runs over https skip handshakes.
//
// Deliberately no Transport.Timeout / Client.Timeout: deadlines are per-class
// and applied with a context on each request through the Reaper.
func NewTransport() *http.Transport {
	return &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   DialTimeout,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		MaxIdleConns:          IdlePoolPerHost,
		MaxIdleConnsPerHost:   IdlePoolPerHost,
		MaxConnsPerHost:       MaxConnsPerHost,
		IdleConnTimeout:       90 * time.Second,
		DisableCompression:    true,
		TLSClientConfig:       &tls.Config{ClientSessionCache: tls.NewLRUClientSessionCache(1024)}, //nolint:gosec -- cert verification stays on by default
		TLSHandshakeTimeout:   5 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		ResponseHeaderTimeout: 0, // per-class context deadlines govern this
		ForceAttemptHTTP2:     false,
	}
}

// Clients are the two per-protocol HTTP clients (separate transports so SOAP
// workload never starves REST idle pools).
type Clients struct {
	Rest *http.Client
	Soap *http.Client
}

// NewClients builds the pair of tuned HTTP clients.
func NewClients() *Clients {
	return &Clients{Rest: &http.Client{Transport: NewTransport()}, Soap: &http.Client{Transport: NewTransport()}}
}

// CloseIdle releases pooled connections on both clients.
func (c *Clients) CloseIdle() {
	c.Rest.CloseIdleConnections()
	c.Soap.CloseIdleConnections()
}
