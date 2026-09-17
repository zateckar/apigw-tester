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
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		MaxIdleConns:          4096,
		MaxIdleConnsPerHost:   2048,
		MaxConnsPerHost:       0,
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
