import { describe, expect, it, spyOn } from "bun:test";
import { DEFAULT_GW_TARGETS, DEFAULT_POLICY_CONFIG, type PolicyId, type PolicyResult } from "@apigw/shared";
import { PROBES, probeContext, runPolicyProbes } from "./policy.js";

const ctx = probeContext(
  {
    rest: { ...DEFAULT_GW_TARGETS.rest, baseUrl: "http://gw.test:9000" },
    soap: { ...DEFAULT_GW_TARGETS.soap, baseUrl: "http://gw.test:9000" }
  },
  () => null
);

/** Run one probe against a canned responder. */
async function probe(
  id: PolicyId,
  respond: (url: string, init: RequestInit) => Response
): Promise<Omit<PolicyResult, "id" | "label" | "probe" | "expectation" | "checkedAt">> {
  const def = PROBES.find((p) => p.id === id);
  if (!def) throw new Error(`no probe ${id}`);
  const spy = spyOn(globalThis as { fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> }, "fetch").mockImplementation(async (input, init) =>
    respond(String(input), init ?? {})
  );
  try {
    return await def.run(ctx);
  } finally {
    spy.mockRestore();
  }
}

// 204/304 must be constructed with a null body or Response throws — which is
// exactly what a real gateway returns for a preflight, so it has to be modelled
const body = (status: number): string | null => (status === 204 || status === 304 ? null : "{}");
const backend = (status: number, headers: Record<string, string> = {}) =>
  new Response(body(status), { status, headers: { "x-server-ms": "7", ...headers } });
const gateway = (status: number, headers: Record<string, string> = {}) =>
  new Response(body(status), { status, headers });

describe("auth policy probes", () => {
  it("passes when the gateway rejects a bogus key without consulting the backend", async () => {
    const r = await probe("auth-bad-key", () => gateway(401));
    expect(r.state).toBe("pass");
    expect(r.reachedBackend).toBe(false);
  });

  it("reports a gateway that proxies a bogus key as not enforcing auth", async () => {
    // the silent failure this whole panel exists for: a 200 looks healthy
    // everywhere else in the dashboard
    const r = await probe("auth-bad-key", () => backend(200));
    expect(r.state).toBe("not-enforced");
    expect(r.detail).toMatch(/not authenticating/);
  });

  it("fails a 401 that the backend produced", async () => {
    // the gateway forwarded a request it should have stopped; the right status
    // arrived for the wrong reason, and only X-Server-Ms can tell
    const r = await probe("auth-bad-key", () => backend(401));
    expect(r.state).toBe("fail");
    expect(r.detail).toMatch(/came from the backend/);
  });

  it("sends the bogus key under the target's own header name", async () => {
    let seen: string | undefined;
    await probe("auth-bad-key", (_url, init) => {
      seen = (init.headers as Record<string, string>)["X-API-Key"];
      return gateway(401);
    });
    expect(seen).toBe("definitely-not-a-valid-key");
  });
});

describe("probe credentials", () => {
  // found by running the probes against a gateway that actually checks the key:
  // every non-auth probe came back "expected 413, got 401" and so on, which is
  // the auth policy being measured six more times instead of the one it names
  const keyed = probeContext(
    {
      rest: { ...DEFAULT_GW_TARGETS.rest, baseUrl: "http://gw.test:9000", apiKey: "the-good-key", apiKeyHeader: "X-Gw-Key" },
      soap: { ...DEFAULT_GW_TARGETS.soap, baseUrl: "http://gw.test:9000", apiKey: "the-good-key", apiKeyHeader: "X-Gw-Key" }
    },
    () => null
  );

  async function keyOn(id: PolicyId): Promise<string | undefined> {
    const def = PROBES.find((p) => p.id === id);
    if (!def) throw new Error(`no probe ${id}`);
    let seen: string | undefined;
    const spy = spyOn(globalThis as { fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> }, "fetch").mockImplementation(async (_input, init) => {
      const h = (init?.headers ?? {}) as Record<string, string>;
      seen ??= h["X-Gw-Key"];
      return backend(200);
    });
    try {
      await def.run(keyed);
    } finally {
      spy.mockRestore();
    }
    return seen;
  }

  it("sends the configured key on every probe that is not about auth", async () => {
    for (const id of ["rate-limit", "payload-limit", "upstream-timeout", "cache", "unknown-route", "cors-preflight"] as PolicyId[]) {
      expect(await keyOn(id), id).toBe("the-good-key");
    }
  }, 30_000);

  it("keeps the valid key off the two auth probes", async () => {
    expect(await keyOn("auth-no-key")).toBeUndefined();
    // the bad-key probe replaces it rather than adding to it
    expect(await keyOn("auth-bad-key")).toBe("definitely-not-a-valid-key");
  });
});

describe("rate-limit probe", () => {
  it("passes when part of the burst is throttled, and reports Retry-After", async () => {
    let n = 0;
    const r = await probe("rate-limit", () => (++n > 5 ? gateway(429, { "retry-after": "30" }) : backend(200)));
    expect(r.state).toBe("pass");
    expect(r.detail).toMatch(/Retry-After: 30/);
  });

  it("notes the absence of a Retry-After header rather than silently passing", async () => {
    const r = await probe("rate-limit", () => gateway(429));
    expect(r.state).toBe("pass");
    expect(r.detail).toMatch(/no Retry-After/);
  });

  it("reports no quota as not-enforced, not as a failure", async () => {
    const r = await probe("rate-limit", () => backend(200));
    expect(r.state).toBe("not-enforced");
  });
});

describe("quota interference", () => {
  // the burst probe exhausts the quota on purpose, and load is usually running
  // alongside; "expected 413, got 429" would be a failure this rig invented
  it("reports a throttled probe as an error rather than a policy failure", async () => {
    for (const id of ["auth-bad-key", "auth-no-key", "payload-limit", "upstream-timeout", "cache", "unknown-route", "cors-preflight"] as PolicyId[]) {
      const r = await probe(id, () => gateway(429, { "retry-after": "1" }));
      expect(r.state, id).toBe("error");
      expect(r.detail, id).toMatch(/throttled/);
    }
  });

  it("runs the burst probe last so it cannot poison the others", () => {
    expect(PROBES[PROBES.length - 1]?.id).toBe("rate-limit");
  });
});

describe("payload, timeout and route probes", () => {
  it("treats a 413 as the gateway capping the body", async () => {
    const r = await probe("payload-limit", () => gateway(413));
    expect(r.state).toBe("pass");
  });

  it("counts a connection cut mid-upload as a limit being applied", async () => {
    // rude, but it IS enforcement — calling it a broken probe would hide a
    // gateway that does cap bodies
    const r = await probe("payload-limit", () => { throw new Error("socket hang up"); });
    expect(r.state).toBe("pass");
    expect(r.detail).toMatch(/without a clean 413/);
  });

  it("reports an oversized body reaching the backend as no payload cap", async () => {
    const r = await probe("payload-limit", () => backend(200));
    expect(r.state).toBe("not-enforced");
  });

  it("passes a clean 504 and fails a dropped connection", async () => {
    expect((await probe("upstream-timeout", () => gateway(504))).state).toBe("pass");
    const dropped = await probe("upstream-timeout", () => { throw new Error("ECONNRESET"); });
    expect(dropped.state).toBe("fail");
    expect(dropped.detail).toMatch(/dropped the connection/);
  });

  it("treats waiting out a slow upstream as a longer timeout, not a defect", async () => {
    const r = await probe("upstream-timeout", () => backend(200));
    expect(r.state).toBe("not-enforced");
    expect(r.detail).toMatch(/read timeout is longer/);
  });

  it("passes an undeclared route refused by the gateway", async () => {
    expect((await probe("unknown-route", () => gateway(404))).state).toBe("pass");
    // the same 404 from the backend means the gateway is not route-restricting
    expect((await probe("unknown-route", () => backend(404))).state).toBe("not-enforced");
  });
});

describe("cache probe", () => {
  it("passes when the second identical GET never reaches the backend", async () => {
    let n = 0;
    const r = await probe("cache", () => (++n === 1 ? backend(200) : gateway(200, { "x-cache": "HIT" })));
    expect(r.state).toBe("pass");
    expect(r.detail).toMatch(/answered by the gateway/);
  });

  it("reports both hits reaching the backend as no caching", async () => {
    const r = await probe("cache", () => backend(200));
    expect(r.state).toBe("not-enforced");
  });
});

describe("cors probe", () => {
  it("passes only when the preflight carries an allow-origin header", async () => {
    const ok = await probe("cors-preflight", () => gateway(204, { "access-control-allow-origin": "*" }));
    expect(ok.state).toBe("pass");
    const none = await probe("cors-preflight", () => gateway(204));
    expect(none.state).toBe("not-enforced");
  });
});

describe("required policies", () => {
  it("promotes not-enforced to a failure only for policies the operator requires", async () => {
    const spy = spyOn(globalThis as { fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> }, "fetch").mockImplementation(async () => backend(200));
    try {
      const results = await runPolicyProbes(ctx, { ...DEFAULT_POLICY_CONFIG, required: ["rate-limit"] });
      const byId = new Map(results.map((r) => [r.id, r]));
      expect(byId.get("rate-limit")?.state).toBe("fail");
      expect(byId.get("rate-limit")?.detail).toMatch(/listed as required/);
      // the same observation on a policy nobody asked for stays informational
      expect(byId.get("cache")?.state).toBe("not-enforced");
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  it("measures nothing, and says so, when the target is the rig's own petstore", async () => {
    // express answers an undeclared route 404 with no X-Server-Ms, which is
    // indistinguishable from a gateway refusing it — so the unknown-route probe
    // would otherwise report a pass for a gateway that isn't there
    const spy = spyOn(globalThis as { fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> }, "fetch").mockImplementation(async () => backend(200));
    try {
      const selfCtx = probeContext(DEFAULT_GW_TARGETS, () => null, true);
      const results = await runPolicyProbes(selfCtx, { ...DEFAULT_POLICY_CONFIG, required: ["unknown-route"] });
      expect(results.length).toBe(PROBES.length);
      expect(results.every((r) => r.state === "error")).toBe(true);
      expect(results[0]?.detail).toMatch(/no gateway in front/);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("returns one result per probe even when every call throws", async () => {
    const spy = spyOn(globalThis as { fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response> }, "fetch").mockImplementation(async () => { throw new Error("unreachable"); });
    try {
      const results = await runPolicyProbes(ctx, DEFAULT_POLICY_CONFIG);
      expect(results.length).toBe(PROBES.length);
      // payload-limit reads a cut connection as enforcement, upstream-timeout
      // as a dropped connection; the rest are honest probe errors
      expect(results.filter((r) => r.state === "error").length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  }, 30_000);
});
