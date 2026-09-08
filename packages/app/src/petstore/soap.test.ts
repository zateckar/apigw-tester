import { describe, expect, it } from "vitest";
import { detectOperation, executeOperation, WSDL } from "./soap.js";
import { PetStore } from "./store.js";

const store = new PetStore(10);

describe("detectOperation", () => {
  it("uses SOAPAction header", () => {
    expect(detectOperation('"getPetById"', "")).toBe("getPetById");
    expect(detectOperation("http://petstore.apigw.test/soap/placeOrder", "")).toBe("placeOrder");
  });

  it("falls back to body element name", () => {
    expect(detectOperation(undefined, "<tns:findPetsByStatusRequest>")).toBe("findPetsByStatus");
  });

  it("returns null on nothing", () => {
    expect(detectOperation(undefined, "<nope/>")).toBeNull();
  });
});

describe("executeOperation", () => {
  it("getPetById returns the pet", () => {
    const r = executeOperation("getPetById", "<petId>1</petId>", store);
    expect(r.ok).toBe(true);
    expect(r.xml).toContain("<id>1</id>");
    expect(r.xml).toContain("soap:Envelope");
  });

  it("getPetById faults on missing pet", () => {
    const r = executeOperation("getPetById", "<petId>9999</petId>", store);
    expect(r.ok).toBe(false);
    expect(r.xml).toContain("soap:Fault");
  });

  it("getPetById faults on bad input", () => {
    const r = executeOperation("getPetById", "<petId></petId>", store);
    expect(r.ok).toBe(false);
  });

  it("findPetsByStatus returns found pets", () => {
    const r = executeOperation("findPetsByStatus", "<status>available</status>", store);
    expect(r.ok).toBe(true);
    expect(r.xml).toContain("findPetsByStatusResponse");
    expect(r.xml).toContain("<pet>");
  });

  it("placeOrder creates order", () => {
    const r = executeOperation("placeOrder", "<petId>2</petId><quantity>3</quantity>", store);
    expect(r.ok).toBe(true);
    expect(r.xml).toContain("<orderId>1</orderId>");
  });
});

describe("soap utilities", () => {
  it("padEnvelope keeps the envelope well-formed", async () => {
    const { padEnvelope } = await import("./soap.js");
    const base = executeOperation("getPetById", "<petId>1</petId>", store);
    const padded = padEnvelope(base.xml, 5000);
    expect(Buffer.byteLength(padded)).toBeGreaterThanOrEqual(5000);
    expect(padded).toContain("</soap:Body></soap:Envelope>");
    expect(padded).toContain("<!--pad:");
    expect(padded.indexOf("<!--pad:")).toBeLessThan(padded.indexOf("</soap:Body>"));
  });
});

describe("WSDL", () => {
  it("exposes all three operations", () => {
    for (const op of ["getPetById", "findPetsByStatus", "placeOrder"]) {
      expect(WSDL).toContain(`<operation name="${op}">`);
    }
  });
});
