import type { Pet, PetStatus } from "@apigw/shared";
import type { PetStore } from "./store.js";

export const WSDL = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"
  xmlns:tns="http://petstore.apigw.test/soap"
  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  targetNamespace="http://petstore.apigw.test/soap"
  name="PetService">
  <types>
    <xsd:schema targetNamespace="http://petstore.apigw.test/soap">
      <xsd:element name="getPetByIdRequest">
        <xsd:complexType><xsd:sequence><xsd:element name="petId" type="xsd:int"/></xsd:sequence></xsd:complexType>
      </xsd:element>
      <xsd:element name="getPetByIdResponse">
        <xsd:complexType><xsd:sequence><xsd:element name="pet" type="tns:Pet"/></xsd:sequence></xsd:complexType>
      </xsd:element>
      <xsd:element name="findPetsByStatusRequest">
        <xsd:complexType><xsd:sequence><xsd:element name="status" type="xsd:string"/></xsd:sequence></xsd:complexType>
      </xsd:element>
      <xsd:element name="findPetsByStatusResponse">
        <xsd:complexType><xsd:sequence><xsd:element name="pet" type="tns:Pet" maxOccurs="unbounded"/></xsd:sequence></xsd:complexType>
      </xsd:element>
      <xsd:element name="placeOrderRequest">
        <xsd:complexType><xsd:sequence>
          <xsd:element name="petId" type="xsd:int"/>
          <xsd:element name="quantity" type="xsd:int"/>
        </xsd:sequence></xsd:complexType>
      </xsd:element>
      <xsd:element name="placeOrderResponse">
        <xsd:complexType><xsd:sequence>
          <xsd:element name="orderId" type="xsd:int"/>
          <xsd:element name="status" type="xsd:string"/>
        </xsd:sequence></xsd:complexType>
      </xsd:element>
      <xsd:complexType name="Pet">
        <xsd:sequence>
          <xsd:element name="id" type="xsd:int"/>
          <xsd:element name="name" type="xsd:string"/>
          <xsd:element name="status" type="xsd:string"/>
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
  <portType name="PetServicePortType">
    <operation name="getPetById"><input message="tns:getPetByIdInput"/><output message="tns:getPetByIdOutput"/></operation>
    <operation name="findPetsByStatus"><input message="tns:findPetsByStatusInput"/><output message="tns:findPetsByStatusOutput"/></operation>
    <operation name="placeOrder"><input message="tns:placeOrderInput"/><output message="tns:placeOrderOutput"/></operation>
  </portType>
  <binding name="PetServiceBinding" type="tns:PetServicePortType">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <operation name="getPetById"><soap:operation soapAction="getPetById"/>
      <input><soap:body use="literal"/></input><output><soap:body use="literal"/></output></operation>
    <operation name="findPetsByStatus"><soap:operation soapAction="findPetsByStatus"/>
      <input><soap:body use="literal"/></input><output><soap:body use="literal"/></output></operation>
    <operation name="placeOrder"><soap:operation soapAction="placeOrder"/>
      <input><soap:body use="literal"/></input><output><soap:body use="literal"/></output></operation>
  </binding>
  <service name="PetService">
    <port name="PetServicePort" binding="tns:PetServiceBinding">
      <soap:address location="__SERVICE_LOCATION__"/>
    </port>
  </service>
</definitions>`;

export type SoapOperation = "getPetById" | "findPetsByStatus" | "placeOrder";

export function detectOperation(soapAction: string | undefined, body: string): SoapOperation | null {
  const action = (soapAction ?? "").replace(/"/g, "").split("/").pop() ?? "";
  for (const op of ["getPetById", "findPetsByStatus", "placeOrder"] as const) {
    if (action === op || body.includes(`<${op}Request`) || body.includes(`<tns:${op}Request`)) return op;
  }
  return null;
}

function extractInt(body: string, tag: string): number | null {
  const m = body.match(new RegExp(`<(?:\\w+:)?${tag}>(-?\\d+)</(?:\\w+:)?${tag}>`));
  return m && m[1] !== undefined ? parseInt(m[1], 10) : null;
}

function extractStr(body: string, tag: string): string | null {
  const m = body.match(new RegExp(`<(?:\\w+:)?${tag}>([^<]*)</(?:\\w+:)?${tag}>`));
  return m && m[1] !== undefined ? m[1] : null;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function petXml(p: Pet): string {
  return `<pet><id>${p.id}</id><name>${esc(p.name)}</name><status>${p.status}</status></pet>`;
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
    `<soap:Fault><faultcode>soap:Server</faultcode><faultstring>${esc(message)}</faultstring></soap:Fault>` +
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
      if (!status || !["available", "pending", "sold"].includes(status)) {
        return { ok: false, xml: soapFault("status must be one of available|pending|sold") };
      }
      const { items } = store.list(status as PetStatus, 0, 20);
      const pets = items.map(petXml).join("");
      return { ok: true, xml: wrapEnvelope(`<tns:findPetsByStatusResponse>${pets}</tns:findPetsByStatusResponse>`) };
    }
    case "placeOrder": {
      const petId = extractInt(body, "petId");
      const qty = extractInt(body, "quantity") ?? 1;
      if (petId === null) return { ok: false, xml: soapFault("petId is required and must be an integer") };
      if (!store.get(petId)) return { ok: false, xml: soapFault(`Pet ${petId} not found`) };
      const order = store.placeOrder({ petId, quantity: qty });
      return {
        ok: true,
        xml: wrapEnvelope(
          `<tns:placeOrderResponse><orderId>${order.id}</orderId><status>${order.status}</status></tns:placeOrderResponse>`
        )
      };
    }
  }
}
