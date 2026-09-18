import { describe, expect, it } from "bun:test";
import { DEFAULT_LOAD_PROFILE, PET_STATUSES, type LoadProfile } from "@apigw/shared";
import {
  buildSpec,
  buildRestSpec,
  buildSoapSpec,
  buildBigResponseSpec,
  buildBigRequestSpec,
  buildSlowSpec,
  buildConcurrencySpec,
  buildInvalidSpec,
  pickClass,
  weightedPick,
  DEFAULT_STRESS_MIX,
  type SpecContext
} from "./scenarios.js";

const p: LoadProfile = { ...DEFAULT_LOAD_PROFILE, maxConcurrency: 10, soapRatioPct: 25, invalidRatioPct: 5 };
const ctx = (): SpecContext => ({ seedId: 120, createdIds: [] });

describe("buildRestSpec", () => {
  it("produces plausible REST requests", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const s = buildRestSpec(p, ctx());
      expect(s.protocol).toBe("rest");
      expect(s.class).toBe("small-rest");
      expect(s.path.startsWith("/api")).toBe(true);
      expect(s.endpoint).toBeTruthy();
      expect(s.expectInvalid).toBeFalsy();
      seen.add(s.endpoint);
    }
    expect(seen.size).toBeGreaterThan(2);
  });

  it("honours scenarioWeights — the knob used to be ignored entirely", () => {
    const onlyList: LoadProfile = {
      ...p,
      scenarioWeights: { listPets: 100, getPet: 0, createPet: 0, updatePet: 0, deletePet: 0, placeOrder: 0 }
    };
    for (let i = 0; i < 200; i++) {
      expect(buildRestSpec(onlyList, ctx()).endpoint).toBe("GET /api/pets");
    }

    const onlyDelete: LoadProfile = {
      ...p,
      scenarioWeights: { listPets: 0, getPet: 0, createPet: 0, updatePet: 0, deletePet: 100, placeOrder: 0 }
    };
    for (let i = 0; i < 50; i++) {
      const s = buildRestSpec(onlyDelete, ctx());
      expect(s.method).toBe("DELETE");
      expect(s.endpoint).toBe("DELETE /api/pets/{id}");
    }
  });

  it("deletes pets it created, in preference to guessing ids", () => {
    const onlyDelete: LoadProfile = {
      ...p,
      scenarioWeights: { listPets: 0, getPet: 0, createPet: 0, updatePet: 0, deletePet: 100, placeOrder: 0 }
    };
    const c: SpecContext = { seedId: 120, createdIds: [5001, 5002] };
    const first = buildRestSpec(onlyDelete, c);
    expect(["/api/pets/5001", "/api/pets/5002"]).toContain(first.path);
    // consumed, so it is not deleted twice
    expect(c.createdIds.length).toBe(1);
  });

  it("createPet asks the driver to remember the new id", () => {
    const onlyCreate: LoadProfile = {
      ...p,
      scenarioWeights: { listPets: 0, getPet: 0, createPet: 100, updatePet: 0, deletePet: 0, placeOrder: 0 }
    };
    const s = buildRestSpec(onlyCreate, ctx());
    expect(s.captureId).toBe(true);
    const body = JSON.parse(s.body ?? "{}") as { name?: unknown; status?: unknown };
    expect(typeof body.name).toBe("string");
    expect(PET_STATUSES).toContain(body.status as never);
  });
});

describe("contract conformance of generated traffic", () => {
  it("valid REST requests stay inside the documented parameter ranges", () => {
    for (let i = 0; i < 500; i++) {
      const s = buildRestSpec(p, ctx());
      const url = new URL(s.path, "http://x");
      const size = url.searchParams.get("size");
      if (size !== null) {
        const n = Number(size);
        expect(Number.isInteger(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(100);
      }
      const status = url.searchParams.get("status");
      if (status !== null) expect(PET_STATUSES).toContain(status as never);

      // path ids are always positive integers
      const m = url.pathname.match(/^\/api\/pets\/([^/]+)/);
      if (m) expect(/^\d+$/.test(m[1] as string)).toBe(true);

      if (s.body !== null && s.headers["Content-Type"] === "application/json") {
        expect(() => JSON.parse(s.body as string)).not.toThrow();
      }
    }
  });

  it("stress-class requests stay inside their documented bounds", () => {
    for (let i = 0; i < 100; i++) {
      const big = Number(buildBigResponseSpec().path.split("/").pop());
      expect(big).toBeGreaterThanOrEqual(0);
      expect(big).toBeLessThanOrEqual(10 * 1024 * 1024);

      const slow = Number(buildSlowSpec().path.split("/").pop());
      expect(slow).toBeGreaterThanOrEqual(0);
      expect(slow).toBeLessThanOrEqual(10_000);
    }
  });

  it("invalid requests are all flagged and are genuinely malformed", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const s = buildInvalidSpec(ctx());
      expect(s.class).toBe("invalid");
      expect(s.expectInvalid).toBe(true);
      expect(s.endpoint).toContain("[invalid:");
      seen.add(s.endpoint);
    }
    // every declared variant should show up across 500 draws
    expect(seen.size).toBeGreaterThanOrEqual(9);
  });
});

describe("buildSoapSpec", () => {
  it("produces valid envelopes tagged soap", () => {
    for (let i = 0; i < 20; i++) {
      const s = buildSoapSpec(p, ctx());
      expect(s.protocol).toBe("soap");
      expect(s.class).toBe("soap");
      expect(s.method).toBe("POST");
      expect(s.path).toBe("/soap/petservice");
      expect(s.headers["Content-Type"]).toContain("text/xml");
      expect(s.headers["SOAPAction"]).toBeTruthy();
      expect(s.body).toContain("soap:Envelope");
      expect(s.body).toContain("</soap:Body>");
    }
  });

  it("covers all three operations over many draws", () => {
    const ops = new Set<string>();
    for (let i = 0; i < 200; i++) ops.add(buildSoapSpec(p, ctx()).endpoint);
    expect(ops.has("SOAP getPetById")).toBe(true);
    expect(ops.has("SOAP findPetsByStatus")).toBe(true);
    expect(ops.has("SOAP placeOrder")).toBe(true);
  });
});

describe("stress-class builders", () => {
  it("big-response uses /api/big with a large size", () => {
    const s = buildBigResponseSpec();
    expect(s.class).toBe("big-response");
    expect(s.path).toMatch(/^\/api\/big\/\d+$/);
    expect(s.expectBytes).toBeGreaterThan(64 * 1024);
  });

  it("big-request encloses a padded body", () => {
    const s = buildBigRequestSpec();
    expect(s.class).toBe("big-request");
    expect(s.body && s.body.length).toBeGreaterThan(32 * 1024);
  });

  it("slow-upstream hits /api/slow/:ms with 500+ms", () => {
    const s = buildSlowSpec();
    expect(s.class).toBe("slow-upstream");
    const ms = Number(s.path.split("/").pop());
    expect(ms).toBeGreaterThanOrEqual(500);
  });

  it("concurrency uses basic hot endpoints", () => {
    const s = buildConcurrencySpec(ctx());
    expect(s.class).toBe("concurrency");
    expect(s.method).toBe("GET");
  });
});

describe("weightedPick edge cases", () => {
  it("survives an all-zero weight map", () => {
    expect(weightedPick({ a: 0, b: 0 })).toBe("a");
  });

  it("never returns a zero-weighted key", () => {
    for (let i = 0; i < 200; i++) expect(weightedPick({ a: 0, b: 1, c: 0 })).toBe("b");
  });

  it("buildSpec always yields a usable spec", () => {
    const r = buildSpec({ ...p }, ctx());
    expect(r.endpoint).toBeTruthy();
    expect(r.class).toBeTruthy();
    expect(r.protocol).toBeTruthy();
  });
});

// A "mode safety" case lived here, asserting that an unrecognised mode paced
// like `constant`. It read targetRpsAt() out of the retired in-process
// scheduler. Pacing is the worker's now, so the guarantee moved to where it is
// implemented: TestUnknownModePacesLikeConstant in packages/go/internal/schedule.

describe("pickClass honours the profile knobs", () => {
  it("soapRatioPct=0 produces no SOAP; =100 produces only SOAP", () => {
    const none: LoadProfile = { ...p, soapRatioPct: 0, invalidRatioPct: 0 };
    const all: LoadProfile = { ...p, soapRatioPct: 100, invalidRatioPct: 0 };
    for (let i = 0; i < 500; i++) {
      expect(pickClass(none)).not.toBe("soap");
      expect(pickClass(all)).toBe("soap");
    }
  });

  it("invalidRatioPct=0 produces no invalid traffic; =100 produces only invalid", () => {
    const none: LoadProfile = { ...p, invalidRatioPct: 0 };
    const all: LoadProfile = { ...p, invalidRatioPct: 100 };
    for (let i = 0; i < 500; i++) {
      expect(pickClass(none)).not.toBe("invalid");
      expect(pickClass(all)).toBe("invalid");
    }
  });

  it("soapRatioPct lands near the requested share", () => {
    const profile: LoadProfile = { ...p, soapRatioPct: 40, invalidRatioPct: 0 };
    let soap = 0;
    const N = 20_000;
    for (let i = 0; i < N; i++) if (pickClass(profile) === "soap") soap++;
    expect(soap / N).toBeGreaterThan(0.36);
    expect(soap / N).toBeLessThan(0.44);
  });

  it("invalidRatioPct lands near the requested share", () => {
    const profile: LoadProfile = { ...p, invalidRatioPct: 5 };
    let invalid = 0;
    const N = 20_000;
    for (let i = 0; i < N; i++) if (pickClass(profile) === "invalid") invalid++;
    expect(invalid / N).toBeGreaterThan(0.035);
    expect(invalid / N).toBeLessThan(0.07);
  });
});

describe("buildSpec class mix", () => {
  it("covers every class over repeated draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(buildSpec(p, ctx()).class);
    for (const cls of Object.keys(DEFAULT_STRESS_MIX)) expect(seen.has(cls)).toBe(true);
    expect(seen.has("soap")).toBe(true);
    expect(seen.has("invalid")).toBe(true);
  });

  it("keeps invalid traffic a small minority at the default profile", () => {
    const counts: Record<string, number> = {};
    const N = 5000;
    for (let i = 0; i < N; i++) {
      const c = buildSpec({ ...DEFAULT_LOAD_PROFILE }, ctx()).class;
      counts[c] = (counts[c] ?? 0) + 1;
    }
    // default invalidRatioPct is 2 — the overwhelming majority must be valid
    expect((counts["invalid"] ?? 0) / N).toBeLessThan(0.05);
    expect((counts["invalid"] ?? 0)).toBeGreaterThan(0);
    const valid = N - (counts["invalid"] ?? 0);
    expect(valid / N).toBeGreaterThan(0.95);
  });
});

