package wire

import (
	"bufio"
	"encoding/json"
	"net"
	"strings"
	"testing"
	"time"
)

func TestBatchNDJSONShape(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	sink := NewResultsSink(ln.Addr().String())
	defer sink.Close()

	val := 1.5
	batch := Batch{
		BatchID: "11111111-2222-4333-8444-555555555555",
		Shed:    []LoadShedSample{{BucketTS: 1730000000000, Dropped: 3, TargetSum: 100.5, Ticks: 50}},
		Results: []RequestResult{{
			RunID: "run-1", RequestID: "abc", TS: 1730000000001, Protocol: "rest", Endpoint: "GET /api/pets",
			Class: "small-rest", Method: "GET", Status: 200, LatencyMs: 5.5, TTFBMs: &val, BaselineMs: 3,
			MeasurementVersion: 2, BytesReq: 0, BytesResp: 120, ReachedBackend: true,
		}},
	}
	if err := sink.WriteBatch(&batch); err != nil {
		t.Fatalf("write: %v", err)
	}

	ln.(*net.TCPListener).SetDeadline(time.Now().Add(2 * time.Second))
	conn, err := ln.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(line), &m); err != nil {
		t.Fatalf("not JSON: %v", err)
	}
	if m["batchId"] != batch.BatchID {
		t.Fatalf("batchId: %v", m["batchId"])
	}
	res := m["results"].([]any)
	if len(res) != 1 {
		t.Fatalf("results: %v", res)
	}
	r := res[0].(map[string]any)
	for _, k := range []string{"runId", "requestId", "ts", "protocol", "endpoint", "class", "method",
		"status", "latencyMs", "ttfbMs", "baselineMs", "overheadMs", "overheadReason", "measurementVersion",
		"bytesReq", "bytesResp", "reachedBackend", "error"} {
		if _, ok := r[k]; !ok {
			t.Fatalf("missing result field %q", k)
		}
	}
	if r["overheadMs"] != nil || r["overheadReason"] != nil || r["error"] != nil {
		t.Fatalf("nulls not preserved: %v", r)
	}
	shed := m["shed"].([]any)
	s0 := shed[0].(map[string]any)
	if s0["bucketTs"].(float64) != 1730000000000 || s0["dropped"].(float64) != 3 {
		t.Fatalf("shed: %v", s0)
	}

	// shed omitted when empty
	batch2 := Batch{BatchID: "x", Results: batch.Results}
	if err := sink.WriteBatch(&batch2); err != nil {
		t.Fatal(err)
	}
	line2, _ := bufio.NewReader(conn).ReadString('\n')
	if strings.Contains(line2, `"shed"`) {
		t.Fatalf("empty shed must be omitted: %s", line2)
	}
}

func TestControlDecoding(t *testing.T) {
	var got []Message
	h := HandlerFuncAsHandler(func(m Message) error { got = append(got, m); return nil })
	in := strings.NewReader(
		`{"op":"configure","gw":{"rest":{"baseUrl":"http://x","apiKey":"","apiKeyHeader":"X-API-Key","pathPrefix":"","forwardBasicAuth":"auto"},"soap":{"baseUrl":"http://y","apiKey":"k","apiKeyHeader":"X-Key","pathPrefix":"/p","forwardBasicAuth":"never"}},"profile":{"mode":"constant","rps":10,"maxConcurrency":25,"soapRatioPct":25,"invalidRatioPct":2,"scenarioWeights":{"listPets":50,"getPet":20,"createPet":10,"updatePet":5,"deletePet":5,"placeOrder":10}},"baselineUrl":"http://x","selfOrigin":"http://x","basicAuth":"dTpw"}` + "\n" +
			`{"op":"start","runId":"run-1"}` + "\n" +
			`{"op":"stop"}` + "\n" +
			`{"op":"future-unknown-op"}` + "\n",
	)
	if err := ReadLines(in, h); err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("messages: %d", len(got))
	}
	c := got[0].Configure
	if c.Gw.Rest.BaseURL != "http://x" || c.Gw.Soap.APIKey != "k" {
		t.Fatalf("configure gw: %+v", c.Gw)
	}
	if c.BasicAuth != "dTpw" || c.SelfOrigin != "http://x" {
		t.Fatalf("configure fields: %+v", c)
	}
	if got[1].Start.RunID != "run-1" || got[2].Op != "stop" {
		t.Fatalf("ops: %+v", got)
	}
}
