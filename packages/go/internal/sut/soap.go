package sut

import (
	"regexp"
	"strconv"
	"strings"
)

// SOAP half of the SUT, mirroring packages/app/src/petstore/soap.ts.
//
// Deliberately regex-driven rather than a real XML binding: a gateway under test
// is being measured on what it does to the bytes, and a hand-rolled reader keeps
// per-request cost flat and predictable. The well-formedness gate below is what
// stops that shortcut from turning a truncated envelope into a 200.

const soapNamespace = "http://petstore.apigw.test/soap"

// ServiceLocationPlaceholder is substituted with the advertised endpoint when
// the WSDL is served, so an importing gateway points at the right host.
const ServiceLocationPlaceholder = "__SERVICE_LOCATION__"

// WSDL is built once at init because the only variable part is the status
// enumeration, which comes from the same constant the REST side validates on.
var WSDL = buildWSDL()

func buildWSDL() string {
	var enums strings.Builder
	for i, s := range PetStatuses {
		if i > 0 {
			enums.WriteString("\n")
		}
		enums.WriteString(`          <xsd:enumeration value="` + s + `"/>`)
	}
	return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
  xmlns:tns="` + soapNamespace + `"
  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  targetNamespace="` + soapNamespace + `"
  name="PetService">
  <types>
    <xsd:schema targetNamespace="` + soapNamespace + `" elementFormDefault="unqualified">
      <xsd:element name="getPetByIdRequest">
        <xsd:complexType><xsd:sequence><xsd:element name="petId" type="xsd:long"/></xsd:sequence></xsd:complexType>
      </xsd:element>
      <xsd:element name="getPetByIdResponse">
        <xsd:complexType><xsd:sequence><xsd:element name="pet" type="tns:Pet"/></xsd:sequence></xsd:complexType>
      </xsd:element>
      <xsd:element name="findPetsByStatusRequest">
        <xsd:complexType><xsd:sequence><xsd:element name="status" type="tns:PetStatus"/></xsd:sequence></xsd:complexType>
      </xsd:element>
      <xsd:element name="findPetsByStatusResponse">
        <xsd:complexType><xsd:sequence><xsd:element name="pet" type="tns:Pet" minOccurs="0" maxOccurs="unbounded"/></xsd:sequence></xsd:complexType>
      </xsd:element>
      <xsd:element name="placeOrderRequest">
        <xsd:complexType><xsd:sequence>
          <xsd:element name="petId" type="xsd:long"/>
          <xsd:element name="quantity" type="xsd:int" minOccurs="0"/>
        </xsd:sequence></xsd:complexType>
      </xsd:element>
      <xsd:element name="placeOrderResponse">
        <xsd:complexType><xsd:sequence>
          <xsd:element name="orderId" type="xsd:long"/>
          <xsd:element name="status" type="xsd:string"/>
        </xsd:sequence></xsd:complexType>
      </xsd:element>
      <xsd:element name="faultDetail">
        <xsd:complexType><xsd:sequence><xsd:element name="reason" type="xsd:string"/></xsd:sequence></xsd:complexType>
      </xsd:element>
      <xsd:simpleType name="PetStatus">
        <xsd:restriction base="xsd:string">
` + enums.String() + `
        </xsd:restriction>
      </xsd:simpleType>
      <xsd:complexType name="Pet">
        <xsd:sequence>
          <xsd:element name="id" type="xsd:long"/>
          <xsd:element name="name" type="xsd:string"/>
          <xsd:element name="status" type="tns:PetStatus"/>
        </xsd:sequence>
      </xsd:complexType>
    </xsd:schema>
  </types>
  <message name="getPetByIdInput"><part name="body" element="tns:getPetByIdRequest"/></message>
  <message name="getPetByIdOutput"><part name="body" element="tns:getPetByIdResponse"/></message>
  <message name="findPetsByStatusInput"><part name="body" element="tns:findPetsByStatusRequest"/></message>
  <message name="findPetsByStatusOutput"><part name="body" element="tns:findPetsByStatusResponse"/></message>
  <message name="placeOrderInput"><part name="body" element="tns:placeOrderRequest"/></message>
  <message name="placeOrderOutput"><part name="body" element="tns:placeOrderResponse"/></message>
  <message name="serviceFault"><part name="body" element="tns:faultDetail"/></message>
  <portType name="PetServicePortType">
    <operation name="getPetById">
      <input message="tns:getPetByIdInput"/><output message="tns:getPetByIdOutput"/>
      <fault name="serviceFault" message="tns:serviceFault"/>
    </operation>
    <operation name="findPetsByStatus">
      <input message="tns:findPetsByStatusInput"/><output message="tns:findPetsByStatusOutput"/>
      <fault name="serviceFault" message="tns:serviceFault"/>
    </operation>
    <operation name="placeOrder">
      <input message="tns:placeOrderInput"/><output message="tns:placeOrderOutput"/>
      <fault name="serviceFault" message="tns:serviceFault"/>
    </operation>
  </portType>
  <binding name="PetServiceBinding" type="tns:PetServicePortType">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="getPetById"><soap:operation soapAction="getPetById"/>
      <input><soap:body use="literal"/></input><output><soap:body use="literal"/></output>
      <fault name="serviceFault"><soap:fault name="serviceFault" use="literal"/></fault></operation>
    <operation name="findPetsByStatus"><soap:operation soapAction="findPetsByStatus"/>
      <input><soap:body use="literal"/></input><output><soap:body use="literal"/></output>
      <fault name="serviceFault"><soap:fault name="serviceFault" use="literal"/></fault></operation>
    <operation name="placeOrder"><soap:operation soapAction="placeOrder"/>
      <input><soap:body use="literal"/></input><output><soap:body use="literal"/></output>
      <fault name="serviceFault"><soap:fault name="serviceFault" use="literal"/></fault></operation>
  </binding>
  <service name="PetService">
    <port name="PetServicePort" binding="tns:PetServiceBinding">
      <soap:address location="` + ServiceLocationPlaceholder + `"/>
    </port>
  </service>
</definitions>`
}

// SoapOperations is the set the service answers, in detection order.
var SoapOperations = [...]string{"getPetById", "findPetsByStatus", "placeOrder"}

// Compiled once: building a regexp per request per operation is pure churn at
// thousands of SOAP rps.
var operationRes = func() map[string]*regexp.Regexp {
	m := make(map[string]*regexp.Regexp, len(SoapOperations))
	for _, op := range SoapOperations {
		m[op] = regexp.MustCompile(`<(?:[\w.-]+:)?` + op + `Request(?:[\s/>])`)
	}
	return m
}()

var (
	rePetID    = elementRe("petId", `-?\d+`)
	reQuantity = elementRe("quantity", `-?\d+`)
	reStatus   = elementRe("status", `[^<]*`)
)

// elementRe builds an extractor tolerating namespace prefixes, attributes
// (xsi:type and friends) and surrounding whitespace — real SOAP stacks emit all
// three.
func elementRe(tag, inner string) *regexp.Regexp {
	return regexp.MustCompile(`<(?:[\w.-]+:)?` + tag + `(?:\s[^>]*)?>\s*(` + inner + `)\s*</(?:[\w.-]+:)?` + tag + `>`)
}

// IsWellFormedXML is a cheap balanced-tag check, skipping the XML declaration,
// comments, CDATA and self-closing elements.
//
// The extractors above are regex-based, which means a truncated envelope still
// yields a usable <petId> and would be answered with a 200. A real SOAP stack
// rejects that, and so must this one — otherwise the deliberately-malformed
// slice of the load looks like it passed, and the run reports a gateway as
// contract-clean on traffic it never validated.
func IsWellFormedXML(xml string) bool {
	var stack []string
	i := 0
	for i < len(xml) {
		lt := strings.Index(xml[i:], "<")
		if lt < 0 {
			break
		}
		lt += i

		switch {
		case strings.HasPrefix(xml[lt:], "<!--"):
			end := strings.Index(xml[lt+4:], "-->")
			if end < 0 {
				return false
			}
			i = lt + 4 + end + 3
			continue
		case strings.HasPrefix(xml[lt:], "<![CDATA["):
			end := strings.Index(xml[lt+9:], "]]>")
			if end < 0 {
				return false
			}
			i = lt + 9 + end + 3
			continue
		case strings.HasPrefix(xml[lt:], "<?"), strings.HasPrefix(xml[lt:], "<!"):
			end := strings.Index(xml[lt+2:], ">")
			if end < 0 {
				return false
			}
			i = lt + 2 + end + 1
			continue
		}

		gt := strings.Index(xml[lt+1:], ">")
		if gt < 0 {
			return false
		}
		gt += lt + 1
		raw := strings.TrimSpace(xml[lt+1 : gt])
		if raw == "" {
			return false
		}

		if strings.HasPrefix(raw, "/") {
			name := strings.TrimSpace(raw[1:])
			if len(stack) == 0 || stack[len(stack)-1] != name {
				return false
			}
			stack = stack[:len(stack)-1]
		} else if !strings.HasSuffix(raw, "/") {
			name := splitTagName(raw)
			if name == "" {
				return false
			}
			stack = append(stack, name)
		}
		i = gt + 1
	}
	return len(stack) == 0
}

// splitTagName takes the element name up to the first whitespace, '/' or '>' —
// the JS `raw.split(/[\s/>]/)[0]`.
func splitTagName(raw string) string {
	for i := 0; i < len(raw); i++ {
		c := raw[i]
		if isSpace(c) || c == '/' || c == '>' {
			return raw[:i]
		}
	}
	return raw
}

// DetectOperation resolves the operation from the SOAPAction header or, failing
// that, from the request element in the body.
func DetectOperation(soapAction, body string) string {
	action := strings.ReplaceAll(soapAction, `"`, "")
	if i := strings.LastIndex(action, "/"); i >= 0 {
		action = action[i+1:]
	}
	for _, op := range SoapOperations {
		if action == op || operationRes[op].MatchString(body) {
			return op
		}
	}
	return ""
}

func extractInt(re *regexp.Regexp, body string) (int64, bool) {
	m := re.FindStringSubmatch(body)
	if m == nil {
		return 0, false
	}
	n, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil || !isSafeInteger(float64(n)) {
		return 0, false
	}
	return n, true
}

func extractStr(re *regexp.Regexp, body string) (string, bool) {
	m := re.FindStringSubmatch(body)
	if m == nil {
		return "", false
	}
	return strings.TrimSpace(m[1]), true
}

// escXML escapes a text node. Matches the TS `esc`: the three characters that
// can break out of element content.
func escXML(s string) string {
	if !strings.ContainsAny(s, "&<>") {
		return s
	}
	var b strings.Builder
	b.Grow(len(s) + 16)
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '&':
			b.WriteString("&amp;")
		case '<':
			b.WriteString("&lt;")
		case '>':
			b.WriteString("&gt;")
		default:
			b.WriteByte(s[i])
		}
	}
	return b.String()
}

func petXML(p Pet) string {
	return "<pet><id>" + itoa(p.ID) + "</id><name>" + escXML(p.Name) +
		"</name><status>" + escXML(p.Status) + "</status></pet>"
}

func WrapEnvelope(inner string) string {
	return `<?xml version="1.0" encoding="UTF-8"?>` +
		`<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="` + soapNamespace + `">` +
		`<soap:Body>` + inner + `</soap:Body></soap:Envelope>`
}

// SoapFault renders a client fault. Always a soap:Client code: everything that
// reaches it is a malformed or contract-violating request, and labelling those
// as server faults would make the SUT look like the failing party in a report
// scoring gateway behaviour.
func SoapFault(message string) string {
	return `<?xml version="1.0" encoding="UTF-8"?>` +
		`<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
		`<soap:Fault><faultcode>soap:Client</faultcode><faultstring>` + escXML(message) +
		`</faultstring></soap:Fault>` +
		`</soap:Body></soap:Envelope>`
}

// PadEnvelope grows the response to roughly targetBytes by inserting a comment
// inside the Body, so padding keeps the envelope well-formed and a validating
// gateway still accepts it.
func PadEnvelope(xml string, targetBytes int) string {
	const marker = "<!--pad:"
	extra := targetBytes - len(xml)
	if extra <= len(marker)+3 {
		return xml
	}
	filler := strings.Repeat("x", extra-len(marker)-3)
	return strings.Replace(xml, "</soap:Body>", marker+filler+"--></soap:Body>", 1)
}

// ExecuteOperation runs a detected operation. ok=false means the response is a
// fault and must be sent with a 400.
func ExecuteOperation(op, body string, store *PetStore) (ok bool, xml string) {
	switch op {
	case "getPetById":
		id, found := extractInt(rePetID, body)
		if !found {
			return false, SoapFault("petId is required and must be an integer")
		}
		pet, exists := store.Get(id)
		if !exists {
			return false, SoapFault("Pet " + itoa(id) + " not found")
		}
		return true, WrapEnvelope("<tns:getPetByIdResponse>" + petXML(pet) + "</tns:getPetByIdResponse>")

	case "findPetsByStatus":
		status, found := extractStr(reStatus, body)
		if !found || !IsPetStatus(status) {
			return false, SoapFault("status must be one of " + statusList())
		}
		items, _ := store.List(status, 0, 20)
		var b strings.Builder
		for _, p := range items {
			b.WriteString(petXML(p))
		}
		return true, WrapEnvelope("<tns:findPetsByStatusResponse>" + b.String() + "</tns:findPetsByStatusResponse>")

	case "placeOrder":
		petID, found := extractInt(rePetID, body)
		if !found {
			return false, SoapFault("petId is required and must be an integer")
		}
		qty := int64(1)
		if q, has := extractInt(reQuantity, body); has {
			qty = q
		}
		if qty < 1 || qty > 100 {
			return false, SoapFault("quantity must be between 1 and 100")
		}
		if _, exists := store.Get(petID); !exists {
			return false, SoapFault("Pet " + itoa(petID) + " not found")
		}
		order := store.PlaceOrder(petID, int(qty))
		return true, WrapEnvelope("<tns:placeOrderResponse><orderId>" + itoa(order.ID) +
			"</orderId><status>" + escXML(order.Status) + "</status></tns:placeOrderResponse>")
	}
	return false, SoapFault("Unknown operation; set SOAPAction header")
}
