package sut

import (
	"strings"
	"testing"
)

func envelope(inner string) string {
	return `<?xml version="1.0" encoding="utf-8"?>` +
		`<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="` + soapNamespace + `">` +
		`<soap:Body>` + inner + `</soap:Body></soap:Envelope>`
}

func TestWSDLCarriesThePlaceholderAndTheStatusEnumeration(t *testing.T) {
	if !strings.Contains(WSDL, ServiceLocationPlaceholder) {
		t.Fatal("no service-location placeholder to substitute")
	}
	if !strings.Contains(WSDL, "PetServicePortType") {
		t.Fatal("missing port type — the CI smoke test greps for this")
	}
	for _, s := range PetStatuses {
		if !strings.Contains(WSDL, `<xsd:enumeration value="`+s+`"/>`) {
			t.Fatalf("status %q missing from the schema", s)
		}
	}
	// a gateway importing this must not be told to call a status the REST side
	// would reject
	if strings.Contains(WSDL, `value="teleported"`) {
		t.Fatal("unexpected enumeration")
	}
}

func TestWellFormednessGateRejectsTruncatedEnvelopes(t *testing.T) {
	// The extractors are regex-based, so a truncated envelope still yields a
	// usable <petId>. Without this gate the deliberately-malformed slice of the
	// load would be answered with a 200 and scored as if the gateway had
	// validated it.
	good := envelope("<tns:getPetByIdRequest><petId>1</petId></tns:getPetByIdRequest>")
	if !IsWellFormedXML(good) {
		t.Fatal("a valid envelope was rejected")
	}
	bad := []string{
		`<soap:Envelope><soap:Body><tns:getPetByIdRequest><petId>1</petId>`,
		`<a></b>`,
		`<a>`,
		`</a>`,
		`<a><!-- unterminated`,
		`<a><![CDATA[ unterminated ]</a>`,
		`<>`,
	}
	for _, x := range bad {
		if IsWellFormedXML(x) {
			t.Fatalf("accepted malformed XML: %q", x)
		}
	}
	// the constructs that must be skipped rather than stacked
	for _, x := range []string{
		`<?xml version="1.0"?><a/>`,
		`<a><!-- comment --></a>`,
		`<a><![CDATA[ <not><a><tag> ]]></a>`,
		`<a><b/></a>`,
		`<a attr="x"><b attr="y"/></a>`,
	} {
		if !IsWellFormedXML(x) {
			t.Fatalf("rejected well-formed XML: %q", x)
		}
	}
}

func TestDetectOperationUsesTheActionThenTheBody(t *testing.T) {
	body := envelope("<tns:placeOrderRequest><petId>1</petId></tns:placeOrderRequest>")
	if got := DetectOperation(`"placeOrder"`, body); got != "placeOrder" {
		t.Fatalf("by action: %q", got)
	}
	// a namespaced URI action, as a real stack sends
	if got := DetectOperation(`"http://petstore.apigw.test/soap/getPetById"`, body); got != "getPetById" {
		t.Fatalf("by namespaced action: %q", got)
	}
	// no action at all: fall back to the request element
	if got := DetectOperation("", body); got != "placeOrder" {
		t.Fatalf("by body: %q", got)
	}
	// loose text that merely mentions an operation is not an element
	if got := DetectOperation("", envelope("<note>please getPetByIdRequest soon</note>")); got != "" {
		t.Fatalf("matched loose text: %q", got)
	}
	if got := DetectOperation("", envelope("<tns:unknownRequest/>")); got != "" {
		t.Fatalf("unknown operation: %q", got)
	}
}

func TestExecuteGetPetById(t *testing.T) {
	store := NewPetStore(120, LimitPetStoreSize)
	ok, xml := ExecuteOperation("getPetById", envelope("<tns:getPetByIdRequest><petId>1</petId></tns:getPetByIdRequest>"), store)
	if !ok {
		t.Fatalf("valid request faulted: %s", xml)
	}
	if !strings.Contains(xml, "<tns:getPetByIdResponse>") || !strings.Contains(xml, "<id>1</id>") {
		t.Fatalf("response: %s", xml)
	}
	if !IsWellFormedXML(xml) {
		t.Fatalf("emitted malformed XML: %s", xml)
	}

	// missing element — one of the generator's invalid variants
	ok, xml = ExecuteOperation("getPetById", envelope("<tns:getPetByIdRequest></tns:getPetByIdRequest>"), store)
	if ok || !strings.Contains(xml, "soap:Fault") {
		t.Fatalf("missing petId was accepted: %s", xml)
	}
	ok, xml = ExecuteOperation("getPetById", envelope("<tns:getPetByIdRequest><petId>999999</petId></tns:getPetByIdRequest>"), store)
	if ok || !strings.Contains(xml, "not found") {
		t.Fatalf("unknown pet: %s", xml)
	}
}

func TestExecuteFindPetsByStatusEnforcesTheEnumeration(t *testing.T) {
	store := NewPetStore(120, LimitPetStoreSize)
	ok, xml := ExecuteOperation("findPetsByStatus", envelope("<tns:findPetsByStatusRequest><status>available</status></tns:findPetsByStatusRequest>"), store)
	if !ok || !strings.Contains(xml, "<pet>") {
		t.Fatalf("valid status: %s", xml)
	}
	// the generator's bad-enum variant
	ok, xml = ExecuteOperation("findPetsByStatus", envelope("<tns:findPetsByStatusRequest><status>zombified</status></tns:findPetsByStatusRequest>"), store)
	if ok || !strings.Contains(xml, "status must be one of available|pending|sold") {
		t.Fatalf("bad enum accepted: %s", xml)
	}
}

func TestExecutePlaceOrder(t *testing.T) {
	store := NewPetStore(120, LimitPetStoreSize)
	ok, xml := ExecuteOperation("placeOrder", envelope("<tns:placeOrderRequest><petId>2</petId><quantity>3</quantity></tns:placeOrderRequest>"), store)
	if !ok || !strings.Contains(xml, "<status>placed</status>") {
		t.Fatalf("valid order: %s", xml)
	}
	ok, _ = ExecuteOperation("placeOrder", envelope("<tns:placeOrderRequest><petId>2</petId><quantity>0</quantity></tns:placeOrderRequest>"), store)
	if ok {
		t.Fatal("zero quantity accepted")
	}
	ok, _ = ExecuteOperation("placeOrder", envelope("<tns:placeOrderRequest><petId>999999</petId></tns:placeOrderRequest>"), store)
	if ok {
		t.Fatal("order for a nonexistent pet accepted")
	}
}

func TestExtractorsToleratePrefixesAttributesAndWhitespace(t *testing.T) {
	store := NewPetStore(120, LimitPetStoreSize)
	for _, body := range []string{
		envelope("<tns:getPetByIdRequest><petId>3</petId></tns:getPetByIdRequest>"),
		envelope("<getPetByIdRequest><ns2:petId>3</ns2:petId></getPetByIdRequest>"),
		envelope("<getPetByIdRequest><petId xsi:type=\"xsd:long\">3</petId></getPetByIdRequest>"),
		envelope("<getPetByIdRequest><petId>\n  3\n  </petId></getPetByIdRequest>"),
	} {
		ok, xml := ExecuteOperation("getPetById", body, store)
		if !ok || !strings.Contains(xml, "<id>3</id>") {
			t.Fatalf("%s -> %s", body, xml)
		}
	}
}

func TestFaultsEscapeTheirMessage(t *testing.T) {
	// a fault string is operator- or request-derived text; unescaped it would
	// break the envelope it is reporting an error in
	f := SoapFault(`bad <input> & "quotes"`)
	if strings.Contains(f, "<input>") || !strings.Contains(f, "&lt;input&gt;") || !strings.Contains(f, "&amp;") {
		t.Fatalf("unescaped fault: %s", f)
	}
	if !IsWellFormedXML(f) {
		t.Fatalf("fault is not well-formed: %s", f)
	}
	if !strings.Contains(f, "<faultcode>soap:Client</faultcode>") {
		t.Fatalf("faults must be client faults: %s", f)
	}
}

func TestPetNamesAreEscapedInResponses(t *testing.T) {
	store := NewPetStore(1, 10)
	name := `Rex <script> & co`
	store.Update(1, UpdatePetInput{Name: &name})
	ok, xml := ExecuteOperation("getPetById", envelope("<tns:getPetByIdRequest><petId>1</petId></tns:getPetByIdRequest>"), store)
	if !ok {
		t.Fatalf("faulted: %s", xml)
	}
	if strings.Contains(xml, "<script>") {
		t.Fatalf("store content escaped into markup: %s", xml)
	}
	if !IsWellFormedXML(xml) {
		t.Fatalf("not well-formed: %s", xml)
	}
}

func TestPadEnvelopeKeepsTheDocumentWellFormed(t *testing.T) {
	base := WrapEnvelope("<tns:x/>")
	for _, target := range []int{0, len(base), len(base) + 5, 3000, 30000} {
		out := PadEnvelope(base, target)
		if !IsWellFormedXML(out) {
			t.Fatalf("target %d produced malformed XML", target)
		}
		if target > len(base)+16 {
			if len(out) != target {
				t.Fatalf("target %d produced %d bytes", target, len(out))
			}
			if !strings.Contains(out, "<!--pad:") {
				t.Fatal("no padding inserted")
			}
		} else if out != base {
			t.Fatalf("target %d should have been a no-op", target)
		}
	}
}
