package fire

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"syscall"
	"testing"
)

func TestNeverLeftTheGeneratorRecognisesADialFailure(t *testing.T) {
	// the shape net/http actually produces: *url.Error wrapping *net.OpError
	// with Op "dial". This is the 10k-rps collapse's error, and misreading it
	// is what turned 66,329 refused connections into "gateway errors".
	err := &url.Error{
		Op:  "Get",
		URL: "http://127.0.0.1:8081/api/pets",
		Err: &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED},
	}
	if !NeverLeftTheGenerator(err) {
		t.Fatal("a refused dial must not be charged to the target")
	}
}

func TestNeverLeftTheGeneratorRecognisesNameResolution(t *testing.T) {
	err := &url.Error{Op: "Get", URL: "http://nope.invalid/", Err: &net.DNSError{Name: "nope.invalid"}}
	if !NeverLeftTheGenerator(err) {
		t.Fatal("a name that does not resolve is our problem, not the gateway's")
	}
}

func TestTheTargetKeepsTheBlameForEverythingElse(t *testing.T) {
	// Deliberately narrow. Once the request is on the wire, a reset is
	// indistinguishable from the target hanging up, and resolving that
	// ambiguity in the generator's favour is the bias this must not have.
	cases := []struct {
		name string
		err  error
	}{
		{"nil", nil},
		{"read reset mid-request", &net.OpError{Op: "read", Net: "tcp", Err: syscall.ECONNRESET}},
		{"write failed mid-request", &net.OpError{Op: "write", Net: "tcp", Err: syscall.EPIPE}},
		{"budget expired", context.DeadlineExceeded},
		{"unexpected EOF from the target", fmt.Errorf("unexpected EOF")},
		{"malformed response", errors.New("net/http: HTTP/1.x transport connection broken")},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if NeverLeftTheGenerator(c.err) {
				t.Fatalf("%v was excused as a generator fault", c.err)
			}
		})
	}
}

func TestARealRefusedDialIsClassified(t *testing.T) {
	// not a constructed error: bind a port, close it, and dial the hole
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()

	c := &http.Client{Transport: NewTransport()}
	//nolint:noctx // the transport's own dial timeout is what is under test
	_, err = c.Get("http://" + addr + "/")
	if err == nil {
		t.Fatal("expected the dial to fail")
	}
	if !NeverLeftTheGenerator(err) {
		t.Fatalf("a real refused dial was charged to the target: %v", err)
	}
}
