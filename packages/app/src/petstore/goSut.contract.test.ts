import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pet } from "@apigw/shared";
import { DEFAULT_LOAD_PROFILE, type LoadProfile, type ScenarioWeights } from "@apigw/shared";
import {
  buildBigRequestSpec, buildBigResponseSpec, buildConcurrencySpec, buildRestSpec,
  buildSlowSpec, buildSoapSpec, INVALID_VARIANTS, type ReqSpec, type SpecContext
} from "../loadgen/scenarios.js";
import { GoSutProcess, sutBinaryPath } from "../sut/goSut.js";
import { PetStore } from "./store.js";

/**
 * The Go petstore, exercised over HTTP by the same generators that drive a real
 * run, and compared against the TS petstore's own store.
 *
 * Two implementations of a backend are only worth having if they are
 * interchangeable. Everything here is the "interchangeable" part: the same
 * generated traffic has to be accepted, the same deliberately invalid traffic
 * has to be refused, and the bytes have to match — otherwise switching backends
 * silently changes what a run measured.
 *
 * Skips when the binary is absent, like the Go loadgen integration test.
 */

process.env["APP_BASIC_AUTH"] ??= "test:pw-123";
const AUTH = `Basic ${Buffer.from(process.env["APP_BASIC_AUTH"]).toString("base64")}`;

const HAVE_BINARY = sutBinaryPath() !== null;
const describeIf = HAVE_BINARY ? describe : describe.skip;

let sut: GoSutProcess;
let base: string;

/** The in-process store, as the reference for what the bytes should say. */
const reference = new PetStore(120);

const ctx = (): SpecContext => ({ seedId: 120, createdIds: [] });

const only = (key: keyof ScenarioWeights): LoadProfile => ({
  ...DEFAULT_LOAD_PROFILE,
  scenarioWeights: {
    listPets: 0, getPet: 0, createPet: 0, updatePet: 0, deletePet: 0, placeOrder: 0,
    [key]: 100
  } as ScenarioWeights
});

async function fire(spec: ReqSpec): Promise<{ status: number; body: string; headers: Headers }> {
  const res = await fetch(`${base}${spec.path}`, {
    method: spec.method,
    headers: { ...spec.headers, authorization: AUTH },
    ...(spec.body !== null ? { body: spec.body } : {})
  });
  return { status: res.status, body: await res.text(), headers: res.headers };
}

const get = (path: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}${path}`, { headers: { authorization: AUTH, ...headers } });

/** Strip the synthetic size padding so the payload can be compared. */
function unpad<T extends Record<string, unknown>>(body: string): T {
  const v = JSON.parse(body) as T & { _pad?: string };
  delete v._pad;
  return v;
}

beforeAll(async () => {
  if (!HAVE_BINARY) return;
  sut = new GoSutProcess();
  const port = await sut.start(0);
  base = `http://127.0.0.1:${port}`;
  // Flatten the simulated backend latency. The real profile sleeps 20–900ms per
  // request by design; the distributions have their own coverage in Go, and
  // leaving them on would make this the slowest suite in the repo.
  const flat: Record<string, unknown> = {};
  for (const key of [
    "list-pets", "get-pet", "create-pet", "update-pet", "delete-pet",
    "place-order", "get-order", "pet-photo", "soap-ops", "unmapped"
  ]) flat[key] = { kind: "fixed", ms: 0 };
  const res = await fetch(`${base}/admin/latency-profile`, {
    method: "PATCH",
    headers: { authorization: AUTH, "Content-Type": "application/json" },
    body: JSON.stringify(flat)
  });
  expect(res.status).toBe(200);
}, 30_000);

afterAll(async () => {
  if (sut) await sut.stop();
});

describeIf("the Go SUT answers the generated load", () => {
  const scenarios: (keyof ScenarioWeights)[] = [
    "listPets", "getPet", "createPet", "updatePet", "deletePet", "placeOrder"
  ];

  for (const key of scenarios) {
    it(`${key} requests are accepted`, async () => {
      for (let i = 0; i < 8; i++) {
        const spec = buildRestSpec(only(key), ctx());
        const { status, body } = await fire(spec);
        // 404 is documented for a delete of an id that is already gone
        const acceptable = status < 400 || (status === 404 && key === "deletePet");
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
    const big = await fire({ ...buildBigResponseSpec(), path: "/api/big/65536" });
    expect(big.status).toBe(200);
    expect(big.body.length).toBe(65536);
  }, 20_000);
});

describeIf("the Go SUT refuses the deliberately invalid slice", () => {
  for (const [i, make] of INVALID_VARIANTS.entries()) {
    it(`variant ${i} (${make(ctx()).endpoint}) is refused with a 4xx`, async () => {
      // a 2xx here is reported as the gateway leaking a contract violation to
      // a backend that in fact never validated it
      const spec = make(ctx());
      const { status, body } = await fire(spec);
      expect(status, `expected 4xx, got ${status}: ${body.slice(0, 200)}`).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
    });
  }
});

describeIf("the Go SUT emits the same bytes as the in-process one", () => {
  // Its own process, because the suites above create, update and delete pets.
  // `reference` is a freshly seeded store, and comparing it against a mutated
  // catalogue would report an implementation difference that is really just
  // test order.
  let pristine: GoSutProcess;
  let at: string;

  const fetchPristine = (path: string): Promise<Response> =>
    fetch(`${at}${path}`, { headers: { authorization: AUTH } });

  beforeAll(async () => {
    pristine = new GoSutProcess();
    at = `http://127.0.0.1:${await pristine.start(0)}`;
  }, 30_000);

  afterAll(async () => {
    if (pristine) await pristine.stop();
  });

  it("serves a seed pet identical to the TS store's", async () => {
    for (const id of [1, 2, 60, 120]) {
      const res = await fetchPristine(`/api/pets/${id}`);
      expect(res.status, `pet ${id}`).toBe(200);
      const got = unpad<Pet>(await res.text());
      expect(got, `pet ${id}`).toEqual(reference.get(id) as unknown as Pet);
    }
  });

  it("pages a listing identically, including the total", async () => {
    for (const [status, page, size] of [["", 0, 20], ["available", 1, 10], ["sold", 0, 5]] as const) {
      const q = status === "" ? `page=${page}&size=${size}` : `status=${status}&page=${page}&size=${size}`;
      const res = await fetchPristine(`/api/pets?${q}`);
      expect(res.status, q).toBe(200);
      const got = unpad<{ items: Pet[]; total: number; page: number; size: number }>(await res.text());
      const want = reference.list(status === "" ? undefined : status, page, size);
      expect(got.total, q).toBe(want.total);
      expect(got.page, q).toBe(page);
      expect(got.size, q).toBe(size);
      expect(got.items, q).toEqual(want.items as unknown as Pet[]);
    }
  });

  it("uses the same error wording, so a report reads the same either way", async () => {
    const cases: [string, string][] = [
      ["/api/pets?status=teleported", "status must be one of available|pending|sold"],
      ["/api/pets?size=9999", "size must be an integer between 1 and 100"],
      ["/api/pets/not-a-number", "petId must be a positive integer"],
      ["/api/pets/999999", "Pet not found"]
    ];
    for (const [path, want] of cases) {
      const got = unpad<{ error: string }>(await (await fetchPristine(path)).text());
      expect(got.error, path).toBe(want);
    }
  });

  it("serves a WSDL with the same service definition", async () => {
    const wsdl = await (await fetchPristine("/soap/petservice?wsdl")).text();
    const { WSDL } = await import("./soap.js");
    // the only intended difference is the substituted service location
    const normalise = (s: string): string =>
      s.replace(/location="[^"]*"/, 'location="X"').replace(/\s+/g, " ").trim();
    expect(normalise(wsdl)).toBe(normalise(WSDL));
  });
});

describeIf("the Go SUT carries the headers the measurement depends on", () => {
  it("stamps X-Server-Ms on its own responses", async () => {
    // the driver subtracts this per request; without it, overhead attribution
    // is simply unavailable and every run reports a Δ of null
    for (const path of ["/api/pets?size=5", "/api/pets/1", "/api/slow/0", "/admin/chaos"]) {
      const res = await get(path);
      const raw = res.headers.get("x-server-ms");
      expect(raw, path).not.toBeNull();
      expect(Number.isFinite(Number(raw)), `${path} -> ${raw}`).toBe(true);
      expect(Number(raw)).toBeGreaterThanOrEqual(0);
    }
    // /health is not SUT work and must not be stamped
    expect((await fetch(`${base}/health`)).headers.get("x-server-ms")).toBeNull();
  });

  it("applies the same security headers as the control plane", async () => {
    const res = await get("/api/pets/1");
    for (const h of ["content-security-policy", "x-content-type-options", "x-frame-options", "referrer-policy"]) {
      expect(res.headers.get(h), h).not.toBeNull();
    }
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  it("requires the same credential, and fails closed on /health alone", async () => {
    expect((await fetch(`${base}/api/pets`)).status).toBe(401);
    expect((await fetch(`${base}/health`)).status).toBe(200);
    const wrong = await fetch(`${base}/api/pets`, { headers: { authorization: "Basic bm9wZTpub3Bl" } });
    expect(wrong.status).toBe(401);
  });

  it("sizes responses the way the class expects", async () => {
    // response size is what decides whether a gateway buffers, streams or
    // compresses — the most expensive things it does
    const list = (await (await get("/api/pets?size=20")).text()).length;
    expect(list).toBeGreaterThan(6000);
    expect(list).toBeLessThan(10000);
    const photo = (await (await get("/api/pets/1/photo")).text()).length;
    expect(photo).toBeGreaterThan(38000);
    expect(photo).toBeLessThan(62000);
    const exact = await (await get("/api/pets/1", { "X-Test-Size-B": "4096" })).text();
    expect(exact.length).toBe(4096);
  });
});

describeIf("the Go SUT survives its supervisor", () => {
  it("reports the port it actually bound", () => {
    expect(sut.port).toBeGreaterThan(0);
    expect(base).toBe(`http://127.0.0.1:${sut.port}`);
    expect(sut.pid).not.toBeNull();
  });

  it("keeps connections alive, so the rig is not measuring handshakes", async () => {
    // the run report carries connection reuse as a headline number; an idle
    // timeout shorter than the reference stream's gap would manufacture
    // handshakes and charge them to the gateway
    const first = await get("/api/pets/1");
    expect(first.headers.get("connection")?.toLowerCase()).not.toBe("close");
    for (let i = 0; i < 20; i++) expect((await get("/api/pets/1")).status).toBe(200);
  });
});
