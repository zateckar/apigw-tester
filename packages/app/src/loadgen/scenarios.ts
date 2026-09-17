import type { LoadProfile, Protocol, ScenarioClass, ScenarioWeights } from "@apigw/shared";
import { PET_STATUSES } from "@apigw/shared";

/**
 * Request builder: produces concrete HTTP requests, tagged by ScenarioClass.
 *
 * Everything here except the `invalid` class is built to satisfy the published
 * OpenAPI document (petstore/openapi.ts) and WSDL, so a gateway with content
 * validation switched on should pass all of it. The `invalid` class exists
 * precisely to prove the validation is on: it emits contract violations that a
 * validating gateway is expected to reject with a 4xx.
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
  /** true when this request deliberately violates the contract */
  expectInvalid?: boolean;
  /** true when the driver should learn the created pet id from the response */
  captureId?: boolean;
}

/** Share of non-SOAP, non-invalid traffic given to each stress class. */
export const DEFAULT_STRESS_MIX: Record<Exclude<ScenarioClass, "soap" | "invalid">, number> = {
  "small-rest": 55,
  "big-response": 8,
  "big-request": 2,
  "slow-upstream": 6,
  "concurrency": 9
};

export interface SpecContext {
  /** highest id guaranteed to exist in the SUT (never evicted) */
  seedId: number;
  /** ids the driver has created and not yet deleted */
  createdIds: number[];
}

function pick<T>(arr: readonly T[], rand: () => number = Math.random): T {
  return arr[Math.floor(rand() * arr.length)] as T;
}

export function weightedPick<K extends string>(weights: Record<K, number>, rand: () => number = Math.random): K {
  const entries = Object.entries(weights) as [K, number][];
  const sum = entries.reduce((a, [, w]) => a + (w > 0 ? w : 0), 0);
  if (sum <= 0) return entries[0]![0];
  let r = rand() * sum;
  for (const [k, w] of entries) {
    if (w <= 0) continue;
    r -= w;
    if (r <= 0) return k;
  }
  return entries[entries.length - 1]![0];
}

/**
 * Class selection, honouring the operator's knobs:
 *   invalidRatioPct  — slice that violates the contract
 *   soapRatioPct     — share of the remainder sent as SOAP
 *   the rest splits across the REST stress classes by DEFAULT_STRESS_MIX.
 */
export function pickClass(profile: LoadProfile, rand: () => number = Math.random): ScenarioClass {
  if (rand() * 100 < (profile.invalidRatioPct ?? 0)) return "invalid";
  if (rand() * 100 < (profile.soapRatioPct ?? 0)) return "soap";
  return weightedPick(DEFAULT_STRESS_MIX, rand) as ScenarioClass;
}

function existingPetId(ctx: SpecContext, rand: () => number = Math.random): number {
  return 1 + Math.floor(rand() * Math.max(1, ctx.seedId));
}

/** Prefer a pet we created (safe to delete); fall back to a high id that will 404. */
function deletablePetId(ctx: SpecContext, rand: () => number = Math.random): number {
  if (ctx.createdIds.length > 0) {
    const idx = Math.floor(rand() * ctx.createdIds.length);
    // swap-with-last-pop: the array is only sampled randomly, so order is
    // irrelevant and O(1) removal beats splice's O(n) at 100+ rps of deletes
    const id = ctx.createdIds[idx] as number;
    ctx.createdIds[idx] = ctx.createdIds[ctx.createdIds.length - 1] as number;
    ctx.createdIds.pop();
    return id;
  }
  return ctx.seedId + 1 + Math.floor(rand() * 10_000);
}

function envelope(inner: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="http://petstore.apigw.test/soap">` +
    `<soap:Body>${inner}</soap:Body></soap:Envelope>`;
}

const PET_NAMES = ["Buddy", "Luna", "Milo", "Cookie", "Rocky", "Sadie", "Ziggy"];

// ---------- Contract-valid REST scenarios ----------

export function buildRestSpec(profile: LoadProfile, ctx: SpecContext, rand: () => number = Math.random): ReqSpec {
  const cls: ScenarioClass = "small-rest";
  const scenario = weightedPick<keyof ScenarioWeights>(profile.scenarioWeights, rand);

  switch (scenario) {
    case "listPets": {
      const status = pick(PET_STATUSES, rand);
      const size = 10 + Math.floor(rand() * 30); // 10..39, within the documented 1..100
      return {
        protocol: "rest", endpoint: "GET /api/pets", class: cls,
        method: "GET", path: `/api/pets?status=${status}&size=${size}`,
        headers: {}, body: null, expectBytes: 2000
      };
    }
    case "getPet": {
      const id = existingPetId(ctx, rand);
      if (rand() < 0.2) {
        return {
          protocol: "rest", endpoint: "GET /api/pets/{id}/photo", class: cls,
          method: "GET", path: `/api/pets/${id}/photo`,
          headers: {}, body: null, expectBytes: 50_000
        };
      }
      return {
        protocol: "rest", endpoint: "GET /api/pets/{id}", class: cls,
        method: "GET", path: `/api/pets/${id}`,
        headers: {}, body: null, expectBytes: 1200
      };
    }
    case "createPet": {
      const body = JSON.stringify({
        name: `${pick(PET_NAMES, rand)} ${Math.floor(rand() * 999)}`,
        status: pick(PET_STATUSES, rand),
        category: { id: 1 + Math.floor(rand() * 8), name: "Dog" },
        tags: [{ id: 1, name: "synthetic" }],
        photoUrls: ["https://cdn.example.test/pets/synthetic.jpg"]
      });
      return {
        protocol: "rest", endpoint: "POST /api/pets", class: cls,
        method: "POST", path: "/api/pets",
        headers: { "Content-Type": "application/json" }, body, expectBytes: 400,
        captureId: true
      };
    }
    case "updatePet": {
      const body = JSON.stringify({ status: pick(PET_STATUSES, rand) });
      return {
        protocol: "rest", endpoint: "PUT /api/pets/{id}", class: cls,
        method: "PUT", path: `/api/pets/${existingPetId(ctx, rand)}`,
        headers: { "Content-Type": "application/json" }, body, expectBytes: 400
      };
    }
    case "deletePet": {
      return {
        protocol: "rest", endpoint: "DELETE /api/pets/{id}", class: cls,
        method: "DELETE", path: `/api/pets/${deletablePetId(ctx, rand)}`,
        headers: {}, body: null, expectBytes: 200
      };
    }
    case "placeOrder":
    default: {
      const body = JSON.stringify({
        petId: existingPetId(ctx, rand),
        quantity: 1 + Math.floor(rand() * 3)
      });
      return {
        protocol: "rest", endpoint: "POST /api/store/order", class: cls,
        method: "POST", path: "/api/store/order",
        headers: { "Content-Type": "application/json" }, body, expectBytes: 400
      };
    }
  }
}

// ---------- Contract-valid SOAP ----------

export function buildSoapSpec(profile: LoadProfile, ctx: SpecContext, rand: () => number = Math.random): ReqSpec {
  const r = rand();
  let op: string;
  let inner: string;
  if (r < 0.5) {
    op = "getPetById";
    inner = `<tns:getPetByIdRequest><petId>${existingPetId(ctx, rand)}</petId></tns:getPetByIdRequest>`;
  } else if (r < 0.8) {
    op = "findPetsByStatus";
    inner = `<tns:findPetsByStatusRequest><status>${pick(PET_STATUSES, rand)}</status></tns:findPetsByStatusRequest>`;
  } else {
    op = "placeOrder";
    inner = `<tns:placeOrderRequest><petId>${existingPetId(ctx, rand)}</petId><quantity>${1 + Math.floor(rand() * 3)}</quantity></tns:placeOrderRequest>`;
  }
  return {
    protocol: "soap", endpoint: `SOAP ${op}`, class: "soap",
    method: "POST", path: "/soap/petservice",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${op}"` },
    body: envelope(inner), expectBytes: 800
  };
}

// ---------- Stress classes (all contract-valid) ----------

export function buildBigResponseSpec(rand: () => number = Math.random): ReqSpec {
  // within the documented 0..10MB bound
  const size = pick([256 * 1024, 1024 * 1024, 4 * 1024 * 1024], rand);
  return {
    protocol: "rest", endpoint: "GET /api/big/{size}", class: "big-response",
    method: "GET", path: `/api/big/${size}`,
    headers: {}, body: null, expectBytes: size
  };
}

export function buildBigRequestSpec(rand: () => number = Math.random): ReqSpec {
  const size = pick([64 * 1024, 256 * 1024, 1024 * 1024], rand);
  const body = bigRequestBody(size);
  return {
    protocol: "rest", endpoint: "POST /api/echo", class: "big-request",
    method: "POST", path: "/api/echo",
    headers: { "Content-Type": "application/json" }, body, expectBytes: 200
  };
}

// The padded bodies repeat verbatim across thousands of requests — building
// "x".repeat(1MB) per request at high rps is pure allocation churn, so the
// three sizes are built once and shared. They are only ever passed to fetch();
// nothing mutates them.
const bigRequestBodies = new Map<number, string>();

function bigRequestBody(size: number): string {
  let body = bigRequestBodies.get(size);
  if (body === undefined) {
    body = JSON.stringify({ _pad: "x".repeat(size - 20) });
    bigRequestBodies.set(size, body);
  }
  return body;
}

const SMALL_BYTES = 1024;

/**
 * Cheap byte length of a spec body. `Buffer.byteLength` walks and encodes the
 * whole string — at high rps it spends real time on buffered 1MB pads. The
 * pad bodies are pure ASCII, so char length IS byte length; and a small body
 * (name/status JSON, SOAP envelope) is cheap to walk, so it's measured anew.
 */
export function bigRequestBytes(body: string | null): number {
  if (body === null) return 0;
  if (body.length > SMALL_BYTES) return body.length; // big-request pads are ASCII
  return Buffer.byteLength(body);
}

export function buildSlowSpec(rand: () => number = Math.random): ReqSpec {
  const ms = pick([500, 1000, 2000], rand); // within the documented 0..10000
  return {
    protocol: "rest", endpoint: "GET /api/slow/{ms}", class: "slow-upstream",
    method: "GET", path: `/api/slow/${ms}`,
    headers: {}, body: null, expectBytes: 200
  };
}

/** Short burst issued during background 'spike' phases; just very hot small calls. */
export function buildConcurrencySpec(ctx: SpecContext, rand: () => number = Math.random): ReqSpec {
  if (rand() < 0.5) {
    return {
      protocol: "rest", endpoint: "GET /api/pets", class: "concurrency",
      method: "GET", path: "/api/pets?size=5", headers: {}, body: null, expectBytes: 1000
    };
  }
  return {
    protocol: "rest", endpoint: "GET /api/pets/{id}", class: "concurrency",
    method: "GET", path: `/api/pets/${existingPetId(ctx, rand)}`, headers: {}, body: null, expectBytes: 1000
  };
}

// ---------- Deliberate contract violations ----------

/** Each entry breaks the published contract in exactly one way. A gateway with
 *  request validation enabled should answer 4xx without ever reaching the SUT. */
export const INVALID_VARIANTS: readonly ((ctx: SpecContext) => ReqSpec)[] = [
  // body: required property missing
  () => ({
    protocol: "rest", endpoint: "POST /api/pets [invalid:missing-required]", class: "invalid",
    method: "POST", path: "/api/pets",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "available" }),
    expectBytes: 200, expectInvalid: true
  }),
  // body: wrong type for a declared property
  () => ({
    protocol: "rest", endpoint: "POST /api/pets [invalid:wrong-type]", class: "invalid",
    method: "POST", path: "/api/pets",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: 12345 }),
    expectBytes: 200, expectInvalid: true
  }),
  // body: value outside the declared enum
  () => ({
    protocol: "rest", endpoint: "POST /api/pets [invalid:bad-enum]", class: "invalid",
    method: "POST", path: "/api/pets",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Contract Breaker", status: "liquidated" }),
    expectBytes: 200, expectInvalid: true
  }),
  // query: value outside the declared enum
  () => ({
    protocol: "rest", endpoint: "GET /api/pets [invalid:bad-enum-query]", class: "invalid",
    method: "GET", path: "/api/pets?status=teleported",
    headers: {}, body: null, expectBytes: 200, expectInvalid: true
  }),
  // query: number outside the declared range
  () => ({
    protocol: "rest", endpoint: "GET /api/pets [invalid:range]", class: "invalid",
    method: "GET", path: "/api/pets?size=9999",
    headers: {}, body: null, expectBytes: 200, expectInvalid: true
  }),
  // path: wrong primitive type
  () => ({
    protocol: "rest", endpoint: "GET /api/pets/{id} [invalid:path-type]", class: "invalid",
    method: "GET", path: "/api/pets/not-a-number",
    headers: {}, body: null, expectBytes: 200, expectInvalid: true
  }),
  // body: wrong type on a nested required property
  (ctx) => ({
    protocol: "rest", endpoint: "POST /api/store/order [invalid:wrong-type]", class: "invalid",
    method: "POST", path: "/api/store/order",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ petId: `${existingPetId(ctx)}`, quantity: 0 }),
    expectBytes: 200, expectInvalid: true
  }),
  // SOAP: element that violates the declared enumeration
  () => ({
    protocol: "soap", endpoint: "SOAP findPetsByStatus [invalid:bad-enum]", class: "invalid",
    method: "POST", path: "/soap/petservice",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '"findPetsByStatus"' },
    body: envelope("<tns:findPetsByStatusRequest><status>zombified</status></tns:findPetsByStatusRequest>"),
    expectBytes: 400, expectInvalid: true
  }),
  // SOAP: mandatory element missing
  () => ({
    protocol: "soap", endpoint: "SOAP getPetById [invalid:missing-element]", class: "invalid",
    method: "POST", path: "/soap/petservice",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '"getPetById"' },
    body: envelope("<tns:getPetByIdRequest></tns:getPetByIdRequest>"),
    expectBytes: 400, expectInvalid: true
  }),
  // SOAP: not a well-formed envelope at all
  () => ({
    protocol: "soap", endpoint: "SOAP [invalid:malformed-xml]", class: "invalid",
    method: "POST", path: "/soap/petservice",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '"getPetById"' },
    body: '<?xml version="1.0"?><soap:Envelope><soap:Body><tns:getPetByIdRequest><petId>1</petId>',
    expectBytes: 400, expectInvalid: true
  })
];

export function buildInvalidSpec(ctx: SpecContext, rand: () => number = Math.random): ReqSpec {
  const make = INVALID_VARIANTS[Math.floor(rand() * INVALID_VARIANTS.length)] ?? INVALID_VARIANTS[0]!;
  return make(ctx);
}

/** Build a concrete request for the chosen class. */
export function buildSpec(profile: LoadProfile, ctx: SpecContext, rand: () => number = Math.random): ReqSpec {
  switch (pickClass(profile, rand)) {
    case "soap": return buildSoapSpec(profile, ctx, rand);
    case "big-response": return buildBigResponseSpec(rand);
    case "big-request": return buildBigRequestSpec(rand);
    case "slow-upstream": return buildSlowSpec(rand);
    case "concurrency": return buildConcurrencySpec(ctx, rand);
    case "invalid": return buildInvalidSpec(ctx, rand);
    case "small-rest":
    default: return buildRestSpec(profile, ctx, rand);
  }
}

// There was a buildBaselineProbe() here: seven fixed specs, one per class, run
// as a cycle every two minutes to calibrate direct transport. The reference
// stream that replaced it calls buildSpec directly, because the two arms of the
// overhead comparison are only poolable across classes if they are drawn from
// the same mix — and a fixed one-of-each set is not the mix the load generates.
