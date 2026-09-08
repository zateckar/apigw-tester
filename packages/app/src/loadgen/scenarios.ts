import type { LoadProfile, Protocol, ScenarioClass } from "@apigw/shared";

/**
 * Request builder: produces concrete HTTP requests, tagged by ScenarioClass.
 * Class weight and the class→endpoint/body mapping is what the GW-overhead
 * metric needs — identical calls are periodically re-issued directly against
 * the SUT (bypassing the GW) to establish the baseline latency per class.
 */

export interface ReqSpec {
  protocol: Protocol;
  endpoint: string;
  class: ScenarioClass;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | null;
  expectBytes: number; // rough response size; for logs
}

const STATUSES = ["available", "pending", "sold"] as const;

/** Default mix — how much of the traffic belongs to each stress class. */
export const DEFAULT_CLASS_WEIGHTS: Record<ScenarioClass, number> = {
  "small-rest": 55,
  "soap": 20,
  "big-response": 8,
  "big-request": 2,
  "slow-upstream": 6,
  "concurrency": 9
};

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

function weightedPick<K extends string>(weights: Record<K, number>): K {
  const entries = Object.entries(weights) as [K, number][];
  const sum = entries.reduce((a, [, w]) => a + w, 0);
  if (sum <= 0) return entries[0]![0];
  let r = Math.random() * sum;
  for (const [k, w] of entries) {
    r -= w;
    if (r <= 0) return k;
  }
  return entries[entries.length - 1]![0];
}

export function pickClass(_profile: LoadProfile): ScenarioClass {
  // user-tunable: soapRatioPct and scenarioWeights are upstream; the class mix
  // is the driver-side default until the config drawer exposes them
  return weightedPick(DEFAULT_CLASS_WEIGHTS);
}

function randomPetId(maxKnownId: number): number {
  return 1 + Math.floor(Math.random() * Math.max(1, maxKnownId));
}

function envelope(op: string, inner: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="http://petstore.apigw.test/soap">` +
    `<soap:Body>${inner}</soap:Body></soap:Envelope>`;
}

export function buildRestSpec(profile: LoadProfile, seedId: number, cls: "small-rest"): ReqSpec {
  const status = pick(STATUSES);
  switch (Math.floor(Math.random() * 4)) {
    case 0:
      return {
        protocol: "rest", endpoint: "GET /api/pets", class: cls,
        method: "GET", path: `/api/pets?status=${status}&size=${10 + Math.floor(Math.random() * 30)}`,
        headers: {}, body: null, expectBytes: 2000
      };
    case 1: {
      const payload = JSON.stringify({
        name: pick(["Buddy", "Luna", "Milo", "Cookie", "Rocky"]) + " " + Math.floor(Math.random() * 999),
        status, tags: [{ id: 1, name: "synthetic" }]
      });
      return {
        protocol: "rest", endpoint: "POST /api/pets", class: cls,
        method: "POST", path: "/api/pets",
        headers: { "Content-Type": "application/json" }, body: payload, expectBytes: 400
      };
    }
    case 2: {
      const id = randomPetId(seedId);
      const payload = JSON.stringify({ status });
      return {
        protocol: "rest", endpoint: "PUT /api/pets/{id}", class: cls,
        method: "PUT", path: `/api/pets/${id}`,
        headers: { "Content-Type": "application/json" }, body: payload, expectBytes: 400
      };
    }
    default:
      return {
        protocol: "rest", endpoint: "GET /api/pets/{id}", class: cls,
        method: "GET", path: `/api/pets/${randomPetId(seedId)}`,
        headers: {}, body: null, expectBytes: 1200
      };
  }
}

export function buildSoapSpec(_profile: LoadProfile, seedId: number): ReqSpec {
  const r = Math.random();
  let op: string;
  let inner: string;
  if (r < 0.5) {
    op = "getPetById";
    inner = `<tns:getPetByIdRequest><petId>${randomPetId(seedId)}</petId></tns:getPetByIdRequest>`;
  } else if (r < 0.8) {
    op = "findPetsByStatus";
    inner = `<tns:findPetsByStatusRequest><status>${pick(STATUSES)}</status></tns:findPetsByStatusRequest>`;
  } else {
    op = "placeOrder";
    inner = `<tns:placeOrderRequest><petId>${randomPetId(seedId)}</petId><quantity>${1 + Math.floor(Math.random() * 3)}</quantity></tns:placeOrderRequest>`;
  }
  return {
    protocol: "soap", endpoint: `SOAP ${op}`, class: "soap",
    method: "POST", path: "/soap/petservice",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${op}"` },
    body: envelope(op, inner), expectBytes: 800
  };
}

export function buildBigResponseSpec(): ReqSpec {
  // sizes chosen to stress GW buffering/streaming: 256KB, 1MB, 4MB
  const size = pick([256 * 1024, 1024 * 1024, 4 * 1024 * 1024]);
  return {
    protocol: "rest", endpoint: `GET /api/big/{size}`, class: "big-response",
    method: "GET", path: `/api/big/${size}`,
    headers: {}, body: null, expectBytes: size
  };
}

export function buildBigRequestSpec(): ReqSpec {
  const size = pick([64 * 1024, 256 * 1024, 1024 * 1024]);
  const body = JSON.stringify({ _pad: "x".repeat(size - 20) });
  return {
    protocol: "rest", endpoint: `POST /api/echo`, class: "big-request",
    method: "POST", path: "/api/echo",
    headers: { "Content-Type": "application/json" }, body, expectBytes: 200
  };
}

export function buildSlowSpec(): ReqSpec {
  const ms = pick([500, 1000, 2000]);
  return {
    protocol: "rest", endpoint: `GET /api/slow/{ms}`, class: "slow-upstream",
    method: "GET", path: `/api/slow/${ms}`,
    headers: {}, body: null, expectBytes: 200
  };
}

/** Short burst issued during background 'spike' phases; just very hot small calls. */
export function buildConcurrencySpec(seedId: number): ReqSpec {
  const specs = [
    { method: "GET", path: "/api/pets?size=5", ep: "GET /api/pets" },
    { method: "GET", path: `/api/pets/${randomPetId(seedId)}`, ep: "GET /api/pets/{id}" }
  ];
  const s = pick(specs);
  return { protocol: "rest", endpoint: s.ep, class: "concurrency", method: s.method, path: s.path, headers: {}, body: null, expectBytes: 1000 };
}

/** Build a concrete request for the chosen class. */
export function buildSpec(profile: LoadProfile, seedId: number): ReqSpec {
  switch (pickClass(profile)) {
    case "small-rest": return buildRestSpec(profile, seedId, "small-rest");
    case "soap": return buildSoapSpec(profile, seedId);
    case "big-response": return buildBigResponseSpec();
    case "big-request": return buildBigRequestSpec();
    case "slow-upstream": return buildSlowSpec();
    case "concurrency": return buildConcurrencySpec(seedId);
  }
}

/** Same shape as buildSpec but uses fixed paths — used to probe the SUT (no GW) for baselines. */
export function buildBaselineProbe(seedId: number): ReqSpec[] {
  return [
    { protocol: "rest", endpoint: "GET /api/pets", class: "small-rest", method: "GET", path: "/api/pets?size=10", headers: {}, body: null, expectBytes: 2000 },
    { protocol: "soap", endpoint: "SOAP getPetById", class: "soap", method: "POST", path: "/soap/petservice",
      headers: { "Content-Type": "text/xml", SOAPAction: '"getPetById"' },
      body: envelope("getPetById", `<tns:getPetByIdRequest><petId>${randomPetId(seedId)}</petId></tns:getPetByIdRequest>`),
      expectBytes: 800 },
    buildBigResponseSpec(),
    { protocol: "rest", endpoint: "POST /api/echo", class: "big-request", method: "POST", path: "/api/echo",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ _pad: "x".repeat(65536 - 24) }), expectBytes: 200 },
    { protocol: "rest", endpoint: "GET /api/slow/{ms}", class: "slow-upstream", method: "GET", path: "/api/slow/500", headers: {}, body: null, expectBytes: 200 },
    buildConcurrencySpec(seedId)
  ];
}
