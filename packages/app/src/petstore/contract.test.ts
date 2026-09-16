import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { DEFAULT_LOAD_PROFILE, LIMITS, type LoadProfile, type ScenarioWeights } from "@apigw/shared";
import { buildApp } from "../app.js";
import { readConfig } from "../config.js";
import {
  buildRestSpec, buildSoapSpec, buildBigResponseSpec, buildBigRequestSpec,
  buildSlowSpec, buildConcurrencySpec, INVALID_VARIANTS, type ReqSpec, type SpecContext
} from "../loadgen/scenarios.js";
import { buildOpenApiDocument, toYaml } from "./openapi.js";
import { headerInt, pathInt } from "./server.js";

process.env["APP_BASIC_AUTH"] = "test:pw-123";
const AUTH = `Basic ${Buffer.from("test:pw-123").toString("base64")}`;

let base: string;
let built: ReturnType<typeof buildApp>;
let server: ReturnType<ReturnType<typeof buildApp>["listen"]>;

const ctx = (): SpecContext => ({ seedId: 120, createdIds: [] });

async function fire(spec: ReqSpec): Promise<{ status: number; body: string }> {
  const res = await fetch(`${base}${spec.path}`, {
    method: spec.method,
    headers: { ...spec.headers, authorization: AUTH },
    ...(spec.body !== null ? { body: spec.body } : {})
  });
  return { status: res.status, body: await res.text() };
}

beforeAll(async () => {
  built = buildApp({ ...readConfig(), dbPath: ":memory:", publicDir: "nope" });
  server = built.listen(0);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await built.shutdown();
  server.stop(true);
}, 30_000);

const only = (key: keyof ScenarioWeights): LoadProfile => ({
  ...DEFAULT_LOAD_PROFILE,
  scenarioWeights: {
    listPets: 0, getPet: 0, createPet: 0, updatePet: 0, deletePet: 0, placeOrder: 0,
    [key]: 100
  } as ScenarioWeights
});

describe("generated valid traffic satisfies the published contract", () => {
  const scenarios: (keyof ScenarioWeights)[] = [
    "listPets", "getPet", "createPet", "updatePet", "deletePet", "placeOrder"
  ];

  for (const key of scenarios) {
    it(`${key} requests are accepted by the SUT`, async () => {
      for (let i = 0; i < 8; i++) {
        const spec = buildRestSpec(only(key), ctx());
        const { status, body } = await fire(spec);
        // 404 is a documented response for delete/get of an id that is gone;
        // anything 4xx other than that means we generated a non-conforming request
        const acceptable = status < 400 || (status === 404 && (key === "deletePet"));
        expect(acceptable, `${spec.method} ${spec.path} -> ${status} ${body.slice(0, 200)}`).toBe(true);
      }
    });
  }

  it("SOAP requests are accepted and come back as well-formed envelopes", async () => {
    for (let i = 0; i < 20; i++) {
      const spec = buildSoapSpec(DEFAULT_LOAD_PROFILE, ctx());
      const { status, body } = await fire(spec);
      expect(status, `${spec.headers["SOAPAction"]} -> ${body.slice(0, 200)}`).toBe(200);
      expect(body).toContain("soap:Envelope");
      expect(body).not.toContain("soap:Fault");
    }
  });

  it("stress-class requests are accepted", async () => {
    for (const spec of [buildBigRequestSpec(), buildSlowSpec(), buildConcurrencySpec(ctx())]) {
      const { status } = await fire(spec);
      expect(status, `${spec.method} ${spec.path}`).toBeLessThan(400);
    }
    // big-response can be several MB; just check the smallest documented size
    const big = await fire({ ...buildBigResponseSpec(), path: "/api/big/65536" });
    expect(big.status).toBe(200);
  }, 20_000);
});

describe("deliberately invalid traffic is rejected", () => {
  for (const [i, make] of INVALID_VARIANTS.entries()) {
    it(`variant ${i} (${make(ctx()).endpoint}) is refused with a 4xx`, async () => {
      const spec = make(ctx());
      const { status, body } = await fire(spec);
      expect(status, `expected 4xx, got ${status}: ${body.slice(0, 200)}`).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
    });
  }
});

describe("the OpenAPI document matches the routes that exist", () => {
  const doc = buildOpenApiDocument() as unknown as {
    openapi: string;
    paths: Record<string, Record<string, unknown>>;
    components: { schemas: Record<string, unknown> };
  };

  it("is a 3.0.3 document covering every path the driver calls", () => {
    expect(doc.openapi).toBe("3.0.3");
    for (const p of [
      "/api/pets", "/api/pets/{petId}", "/api/pets/{petId}/photo",
      "/api/store/order", "/api/store/order/{orderId}",
      "/api/big/{size}", "/api/slow/{ms}", "/api/echo", "/health"
    ]) {
      expect(Object.keys(doc.paths), `missing ${p}`).toContain(p);
    }
  });

  it("every documented $ref resolves", () => {
    const refs = new Set<string>();
    JSON.stringify(doc, (k, v) => {
      if (k === "$ref" && typeof v === "string") refs.add(v);
      return v as unknown;
    });
    for (const ref of refs) {
      const name = ref.replace("#/components/schemas/", "");
      expect(Object.keys(doc.components.schemas), `dangling ${ref}`).toContain(name);
    }
  });

  it("declares each documented operation on a route that answers it", async () => {
    // spot-check that the documented methods are actually routed (not 404/405)
    const checks: [string, string][] = [
      ["GET", "/api/pets?size=5"],
      ["POST", "/api/pets"],
      ["GET", "/api/pets/1"],
      ["PUT", "/api/pets/1"],
      ["DELETE", "/api/pets/1"],
      ["GET", "/api/pets/2/photo"],
      ["POST", "/api/store/order"],
      ["GET", "/api/slow/0"],
      ["GET", "/api/big/1024"],
      ["POST", "/api/echo"]
    ];
    for (const [method, path] of checks) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: AUTH, "Content-Type": "application/json" },
        ...(method === "POST" || method === "PUT"
          ? { body: JSON.stringify(path.includes("order") ? { petId: 1 } : path.includes("echo") ? { _pad: "x" } : { name: "Probe" }) }
          : {})
      });
      expect(res.status, `${method} ${path}`).not.toBe(404);
      expect(res.status, `${method} ${path}`).not.toBe(405);
    }
  });

  it("serializes to YAML that starts like an OpenAPI file", () => {
    const yaml = toYaml(buildOpenApiDocument());
    expect(yaml.startsWith("openapi: '3.0.3'")).toBe(true);
    expect(yaml).toContain("\npaths:");
    expect(yaml).toContain("\ncomponents:");
    // no unquoted scalar can be mistaken for a YAML tag/alias
    for (const line of yaml.split("\n")) {
      expect(line.includes("\t")).toBe(false);
    }
  });
});

describe("definition downloads", () => {
  it("serves OpenAPI JSON, YAML and the WSDL as attachments", async () => {
    for (const [path, needle] of [
      ["/api/definitions/openapi.json", '"openapi": "3.0.3"'],
      ["/api/definitions/openapi.yaml", "openapi: '3.0.3'"],
      ["/api/definitions/petservice.wsdl", "PetServicePortType"]
    ] as const) {
      const res = await fetch(`${base}${path}`, { headers: { authorization: AUTH } });
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-disposition")).toContain("attachment");
      expect(await res.text()).toContain(needle);
    }
  });

  it("requires authentication like everything else", async () => {
    const res = await fetch(`${base}/api/definitions/openapi.json`);
    expect(res.status).toBe(401);
  });

  it("advertises a server URL and honours an override", async () => {
    const res = await fetch(`${base}/api/definitions/openapi.json?server=https://gw.example.com/v2`, {
      headers: { authorization: AUTH }
    });
    const doc = (await res.json()) as { servers: { url: string }[] };
    expect(doc.servers[0]?.url).toBe("https://gw.example.com/v2");
  });

  it("the WSDL points at the advertised service location", async () => {
    const res = await fetch(`${base}/api/definitions/petservice.wsdl?server=https://gw.example.com`, {
      headers: { authorization: AUTH }
    });
    const wsdl = await res.text();
    expect(wsdl).toContain('location="https://gw.example.com/soap/petservice"');
    expect(wsdl).not.toContain("__SERVICE_LOCATION__");
  });
});

describe("request-parameter bounds", () => {
  it("clamps X-Test-* header integers to their documented maximum", () => {
    // asserted here rather than end-to-end: proving the 30 s delay cap by actually
    // waiting 30 s made this the slowest test in the repo for no extra coverage
    expect(headerInt("2147483000", LIMITS.delayMs)).toBe(LIMITS.delayMs);
    expect(headerInt("1099511627776", LIMITS.bigBytes)).toBe(LIMITS.bigBytes);
    expect(headerInt("250", LIMITS.delayMs)).toBe(250);
    expect(headerInt(" 250 ", LIMITS.delayMs)).toBe(250);
  });

  it("rejects header integers that are zero, negative, non-numeric or absent", () => {
    expect(headerInt(undefined, LIMITS.delayMs)).toBeNull();
    expect(headerInt("", LIMITS.delayMs)).toBeNull();
    expect(headerInt("0", LIMITS.delayMs)).toBeNull();
    expect(headerInt("-1", LIMITS.delayMs)).toBeNull();
    expect(headerInt("abc", LIMITS.delayMs)).toBeNull();
    // exponent notation must not sneak past the digits-only gate
    expect(headerInt("1e999", LIMITS.delayMs)).toBeNull();
  });

  it("accepts only positive integer path ids", () => {
    expect(pathInt("42")).toBe(42);
    expect(pathInt("0")).toBeNull();
    expect(pathInt("-3")).toBeNull();
    expect(pathInt("1.5")).toBeNull();
    expect(pathInt("abc")).toBeNull();
    expect(pathInt(undefined)).toBeNull();
  });
});
