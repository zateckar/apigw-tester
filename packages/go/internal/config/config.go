package config

import (
	"fmt"
	"net/url"
	"os"
	"strings"
)

// ResultsAddr reads the listen address for the results socket from
// RESULTS_ADDR in the environment; empty when unset.
func ResultsAddr() string { return os.Getenv("RESULTS_ADDR") }

// OriginOf returns scheme://host:port for a URL, or an error if it is not an
// absolute http(s) URL.
func OriginOf(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("not an absolute http(s) URL: %q", raw)
	}
	return u.Scheme + "://" + u.Host, nil
}

// NormalizeBase strips trailing slashes from a base URL, mirroring the TS
// sanitizeGwConfig behaviour for baseUrl.
func NormalizeBase(u string) string {
	return strings.TrimRight(strings.TrimSpace(u), "/")
}

// URLPrefixFor returns "base without trailing slashes" plus the optional path
// prefix, in one precomputed string, mirroring urlPrefixFor in the TS driver.
func URLPrefixFor(g GwConfig) string {
	base := NormalizeBase(g.BaseURL)
	p := strings.Trim(strings.TrimSpace(g.PathPrefix), "/")
	if p == "" {
		return base
	}
	return base + "/" + p
}

// SendsBasicAuth decides whether the given target may carry the rig's own
// Authorization: Basic header — mirroring sendsOurCredential in the TS driver.
func SendsBasicAuth(g GwConfig, selfOrigin string) bool {
	switch g.ForwardBasicAuth {
	case ForwardAlways:
		return true
	case ForwardNever:
		return false
	default: // auto
		theirs, err := OriginOf(g.BaseURL)
		return err == nil && selfOrigin != "" && theirs == selfOrigin
	}
}
