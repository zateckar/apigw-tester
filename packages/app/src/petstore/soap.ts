import type { Pet, PetStatus } from "@apigw/shared";
import { PET_STATUSES, isPetStatus } from "@apigw/shared";
import type { PetStore } from "./store.js";

export const WSDL = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
  xmlns:tns="http://petstore.apigw.test/soap"
  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  targetNamespace="http://petstore.apigw.test/soap"
  name="PetService">
  <types>
    <xsd:schema targetNamespace="http://petstore.apigw.test/soap" elementFormDefault="unqualified">
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
${PET_STATUSES.map((s) => `          <xsd:enumeration value="${s}"/>`).join("\n")}
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
      <soap:address location="__SERVICE_LOCATION__"/>
    </port>
  </service>
</definitions>`;

/**
 * Cheap well-formedness check: balanced tags, with the XML declaration,
 * comments, CDATA and self-closing elements skipped.
 *
 * The operation extractors below are regex-based, which means a truncated
 * envelope still yields a usable `<petId>` and used to be answered with a 200.
 * A real SOAP stack rejects that, and so must this one — otherwise the
 * deliberately-malformed slice of the load looks like it passed.
 */
export function isWellFormedXml(xml: string): boolean {
  const stack: string[] = [];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) break;

    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end < 0) return false;
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0) return false;
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt) || xml.startsWith("<!", lt)) {
      const end = xml.indexOf(">", lt + 2);
      if (end < 0) return false;
      i = end + 1;
      continue;
    }

    const gt = xml.indexOf(">", lt + 1);
    if (gt < 0) return false;
    const raw = xml.slice(lt + 1, gt).trim();
    if (raw === "") return false;

    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim();
      if (stack.pop() !== name) return false;
    } else if (!raw.endsWith("/")) {
      const name = raw.split(/[\s/>]/)[0] ?? "";
      if (name === "") return false;
      stack.push(name);
    }
    i = gt + 1;
  }
  return stack.length === 0;
}

export type SoapOperation = "getPetById" | "findPetsByStatus" | "placeOrder";

export const SOAP_OPERATIONS: readonly SoapOperation[] = ["getPetById", "findPetsByStatus", "placeOrder"];

// The operation-detection regexes are fixed at load time — building a RegExp
// per request per operation is pure churn at thousands of SOAP rps.
const OPERATION_RES = new Map<SoapOperation, RegExp>(
  SOAP_OPERATIONS.map(op => [op, new RegExp(`<(?:[\\w.-]+:)?${op}Request(?:[\\s/>])`)])
);

export function detectOperation(soapAction: string | undefined, body: string): SoapOperation | null {
  const action = (soapAction ?? "").replace(/"/g, "").split("/").pop() ?? "";
  for (const op of SOAP_OPERATIONS) {
    // match `<op Request` / `<ns:opRequest` as an element, not as loose text
    if (action === op || OPERATION_RES.get(op)!.test(body)) return op;
  }
  return null;
}

/** Element text extractor. Tolerates namespace prefixes, attributes (xsi:type
 *  and friends) and surrounding whitespace — real SOAP stacks emit all three.
 *  Regexes are cached per (tag, inner): the petstore only ever asks for three
 *  tags, but constructing them per request on the load path shows up in CPU. */
const elementReCache = new Map<string, RegExp>();
function elementRe(tag: string, inner: string): RegExp {
  const key = `${tag}${inner}`;
  let re = elementReCache.get(key);
  if (!re) {
    re = new RegExp(`<(?:[\\w.-]+:)?${tag}(?:\\s[^>]*)?>\\s*(${inner})\\s*</(?:[\\w.-]+:)?${tag}>`);
    elementReCache.set(key, re);
  }
  return re;
}

function extractInt(body: string, tag: string): number | null {
  const m = body.match(elementRe(tag, "-?\\d+"));
  if (!m || m[1] === undefined) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isSafeInteger(n) ? n : null;
}

function extractStr(body: string, tag: string): string | null {
  const m = body.match(elementRe(tag, "[^<]*"));
  return m && m[1] !== undefined ? m[1].trim() : null;
}

/** XML text-node escape. Coerces non-strings — a poisoned store value must not
 *  throw its way into an HTML 500 out of the SOAP endpoint. */
function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function petXml(p: Pet): string {
  return `<pet><id>${esc(p.id)}</id><name>${esc(p.name)}</name><status>${esc(p.status)}</status></pet>`;
}

export function wrapEnvelope(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="http://petstore.apigw.test/soap">` +
    `<soap:Body>${inner}</soap:Body></soap:Envelope>`;
}

/** Insert a padding comment inside the Body so padding keeps the envelope well-formed. */
export function padEnvelope(xml: string, targetBytes: number): string {
  const marker = "<!--pad:";
  const extra = targetBytes - Buffer.byteLength(xml);
  if (extra <= Buffer.byteLength(marker) + 3) return xml;
  const filler = "x".repeat(extra - Buffer.byteLength(marker) - 3);
  return xml.replace("</soap:Body>", `${marker}${filler}--></soap:Body>`);
}

export function soapFault(message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
    `<soap:Fault><faultcode>soap:Client</faultcode><faultstring>${esc(message)}</faultstring></soap:Fault>` +
    `</soap:Body></soap:Envelope>`;
}

export function executeOperation(
  op: SoapOperation,
  body: string,
  store: PetStore
): { ok: boolean; xml: string } {
  switch (op) {
    case "getPetById": {
      const id = extractInt(body, "petId");
      if (id === null) return { ok: false, xml: soapFault("petId is required and must be an integer") };
      const pet = store.get(id);
      if (!pet) return { ok: false, xml: soapFault(`Pet ${id} not found`) };
      return { ok: true, xml: wrapEnvelope(`<tns:getPetByIdResponse>${petXml(pet)}</tns:getPetByIdResponse>`) };
    }
    case "findPetsByStatus": {
      const status = extractStr(body, "status");
      if (!isPetStatus(status)) {
        return { ok: false, xml: soapFault(`status must be one of ${PET_STATUSES.join("|")}`) };
      }
      const { items } = store.list(status as PetStatus, 0, 20);
      const pets = items.map(petXml).join("");
      return { ok: true, xml: wrapEnvelope(`<tns:findPetsByStatusResponse>${pets}</tns:findPetsByStatusResponse>`) };
    }
    case "placeOrder": {
      const petId = extractInt(body, "petId");
      const qty = extractInt(body, "quantity") ?? 1;
      if (petId === null) return { ok: false, xml: soapFault("petId is required and must be an integer") };
      if (qty < 1 || qty > 100) return { ok: false, xml: soapFault("quantity must be between 1 and 100") };
      if (!store.get(petId)) return { ok: false, xml: soapFault(`Pet ${petId} not found`) };
      const order = store.placeOrder({ petId, quantity: qty });
      return {
        ok: true,
        xml: wrapEnvelope(
          `<tns:placeOrderResponse><orderId>${esc(order.id)}</orderId><status>${esc(order.status)}</status></tns:placeOrderResponse>`
        )
      };
    }
  }
}
