import { describe, expect, it } from "vitest";
import { DEFAULT_LOAD_PROFILE, type LoadProfile } from "@apigw/shared";
import {
  buildSpec,
  buildRestSpec,
  buildSoapSpec,
  buildBigResponseSpec,
  buildBigRequestSpec,
  buildSlowSpec,
  buildConcurrencySpec,
  buildBaselineProbe,
  DEFAULT_CLASS_WEIGHTS
} from "./scenarios.js";

const p: LoadProfile = { ...DEFAULT_LOAD_PROFILE, maxConcurrency: 10, soapRatioPct: 25 };

describe("buildRestSpec", () => {
  it("produces plausible REST requests", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const s = buildRestSpec(p, 120, "small-rest");
      expect(s.protocol).toBe("rest");
      expect(s.class).toBe("small-rest");
      expect(s.path.startsWith("/api")).toBe(true);
      expect(s.endpoint).toBeTruthy();
      seen.add(s.endpoint);
    }
    expect(seen.size).toBeGreaterThan(2);
  });
});

describe("buildSoapSpec", () => {
  it("produces valid envelopes tagged soap", () => {
    for (let i = 0; i < 20; i++) {
      const s = buildSoapSpec(p, 120);
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
    for (let i = 0; i < 200; i++) ops.add(buildSoapSpec(p, 120).endpoint);
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
    const s = buildConcurrencySpec(120);
    expect(s.class).toBe("concurrency");
    expect(s.method).toBe("GET");
  });
});

describe("buildSpec class mix", () => {
  it("covers every class over repeated draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(buildSpec(p, 120).class);
    for (const cls of Object.keys(DEFAULT_CLASS_WEIGHTS)) expect(seen.has(cls)).toBe(true);
  });

  it("respects the default weights roughly", () => {
    const counts: Record<string, number> = {};
    for (let i = 0; i < 2000; i++) {
      const c = buildSpec(p, 120).class;
      counts[c] = (counts[c] ?? 0) + 1;
    }
    // small-rest (55) dominates; big-request (2) stays rare
    expect(counts["small-rest"]!).toBeGreaterThan(2000 * 0.5);
    expect(counts["big-request"]!).toBeLessThan(2000 * 0.08);
  });
});

describe("baseline probes", () => {
  it("returns a probe per class", () => {
    const probes = buildBaselineProbe(120);
    const classes = new Set(probes.map((p) => p.class));
    expect(classes.has("small-rest")).toBe(true);
    expect(classes.has("soap")).toBe(true);
    expect(classes.has("big-response")).toBe(true);
    expect(classes.has("big-request")).toBe(true);
    expect(classes.has("slow-upstream")).toBe(true);
    expect(classes.has("concurrency")).toBe(true);
  });
});
