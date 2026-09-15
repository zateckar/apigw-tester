import type { ChaosConfig, EndpointLatencyProfile, PetStatus } from "@apigw/shared";
import { LIMITS, PET_STATUSES, isPetStatus } from "@apigw/shared";
import {
  DEFAULT_CHAOS,
  DEFAULT_LATENCY_PROFILE,
  decideChaos,
  sampleLatency,
  validateLatencyPatch
} from "./latency.js";
import { PetStore, padPayload, validateNewPet, validateUpdatePet } from "./store.js";
import { WSDL, detectOperation, executeOperation, soapFault, padEnvelope, isWellFormedXml } from "./soap.js";

const DEFAULT_SIZES: Record<string, number> = {
  "list-pets": 8000,
  "get-pet": 1200,
  "pet-photo": 50000,
  "soap-ops": 3000
};

/** Chaos "timeout": long enough to blow past any sane client budget, but still
 *  bounded so the socket and its timer are always released. */
const CHAOS_TIMEOUT_MS = LIMITS.delayMs;

/** Response header carrying the SUT's own server-side time for the request,
 *  entry-to-first-byte. The load driver subtracts it per request, so "GW
 *  overhead" excludes backend latency — including per-request jitter, chaos
 *  injection and per-class sleep/size randomness — without guessing from a
 *  class-median baseline. Absent on responses not issued by the SUT (e.g. a
 *  gateway's own 401/404). Without it, overhead attribution is unavailable. */
export const SERVER_MS_HEADER = "X-Server-Ms";

/** setTimeout that resolves early if the signal fires — Bun.sleep's signal
 *  option doesn't abort at 1.4, so the chaos-timeout and simulated-latency
 *  timers use this instead of holding the full delay after the client walks. */
function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); resolve(); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** A Bun-native route handler. Receives the request, a request-scoped context
 *  and pre-parsed path params (":name" segments), and resolves to a Response. */
export interface RouteCtx {
  req: Request;
  /** entry timestamp — the basis of SERVER_MS_HEADER stamping */
  enteredAt: number;
  params: Record<string, string>;
  query: URLSearchParams;
  /** per-request overrides set by variability (pad target size) */
  padBytes?: number;
  /** validated+parsed JSON body where the route declared one */
  jsonBody?: unknown;
  /** text body where the route declared one (SOAP) */
  textBody?: string;
  /** echo's raw body byte length, read via arrayBuffer so a 12MB big-request
   *  is counted, never JSON-parsed and re-stringified */
  echoBytes?: number;
}

export type Handler = (ctx: RouteCtx) => Response | Promise<Response>;

/** Route key pattern: "METHOD /path/:param". Registered in a table and
 *  resolved by the Bun.serve dispatcher in app.ts. */
export interface RouteDef {
  handler: Handler;
  /** how the dispatcher should materialise the body before calling the
   *  handler: none (default), json, text, or arrayBuffer (echo). */
  body?: "json" | "text" | "arrayBuffer";
}

/** Parse a path parameter that must be a positive integer. */
export function pathInt(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** Parse a header that must be a non-negative integer, clamped to `max`. */
export function headerInt(raw: string | null | undefined, max: number): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, max);
}

const json = (status: number, body: unknown, extra?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra }
  });

export function createPetstoreRoutes(): { routes: Record<string, RouteDef>; store: PetStore; latencyProfile: EndpointLatencyProfile } {
  const store = new PetStore(120);
  const latencyProfile: EndpointLatencyProfile = { ...DEFAULT_LATENCY_PROFILE };
  let chaos: ChaosConfig = { ...DEFAULT_CHAOS };

  const routes: Record<string, RouteDef> = {};
  /** register shorthand: body default "none" */
  const on = (key: string, handler: Handler, body?: RouteDef["body"]) => {
    routes[key] = body ? { handler, body } : { handler };
  };

  // ---- cached serialization for the seed population ----------------------
  // Seed pets are created once at boot and never change or get evicted, so
  // their JSON is invariant. listPets (~50% of traffic, ~8KB) and getPet used
  // to re-stringify that on every request; a hot request is now two slices
  // and a concat off bounded Maps. Any response touching a runtime-created
  // pet bypasses the cache and takes the regular padPayload path.
  const seedCount = store.seedPetCount;
  const seedTotalByStatus = new Map<string, number>();
  {
    for (const s of PET_STATUSES) seedTotalByStatus.set(s, 0);
    for (let page = 0; page * 100 < seedCount; page++) {
      for (const p of store.list(undefined, page, 100).items) {
        if (p.id <= seedCount) seedTotalByStatus.set(p.status, (seedTotalByStatus.get(p.status) ?? 0) + 1);
      }
    }
    seedTotalByStatus.set("", seedCount);
  }

  /** ',"_pad":"<filler>"}' fragment closing a base JSON object, cached per
   *  rounded target size (padFiller buckets the 0.8–1.2x jitter). */
  const padTailByTarget = new Map<number, string>();
  const padTailFor = (baseLen: number, targetBytes: number): string => {
    let tail = padTailByTarget.get(targetBytes);
    if (tail === undefined) {
      tail = "";
      if (targetBytes > baseLen + 13) {
        // padPayload's own output with its opening '{' swapped for the field
        // separator — immune to exactly how its key+overhead bytes add up
        const padded = JSON.stringify(padPayload({ _pad: "" }, targetBytes - (baseLen - 1)));
        tail = "," + padded.slice(1);
      }
      padTailByTarget.set(targetBytes, tail);
    }
    return tail;
  };

  const sendCached = (status: number, base: string, pad: number | undefined): Response => {
    const target = Math.round(pad ?? 0);
    const body = target > base.length + 13
      ? base.slice(0, -1) + padTailFor(base.length, target)
      : base;
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  };

  const listBaseByKey = new Map<string, { base: string; petCount: number }>();
  const listBaseFor = (status: PetStatus | undefined, page: number, size: number): string | null => {
    const key = `${status ?? ""}|${page}|${size}`;
    const hit = listBaseByKey.get(key);
    if (hit && hit.petCount === store.count()) return hit.base;
    const { items, total } = store.list(status, page, size);
    // a listing that includes (or could total) runtime pets is not cacheable
    if (total !== seedTotalByStatus.get(status ?? "") || items.some((p) => p.id > seedCount)) return null;
    const entry = { base: JSON.stringify({ items, total, page, size }), petCount: store.count() };
    listBaseByKey.set(key, entry);
    return entry.base;
  };

  const petBaseById = new Map<number, string>();
  const petBaseFor = (id: number): string | null => {
    if (id > seedCount) return null;
    let base = petBaseById.get(id);
    if (base === undefined) {
      const pet = store.get(id);
      if (!pet) return null;
      base = JSON.stringify(pet);
      petBaseById.set(id, base);
    }
    return base;
  };

  // Per-request simulated latency + size + chaos.
  const variability = async (ctx: RouteCtx, endpointKey: string): Promise<Response | null> => {
    const delayHdr = headerInt(ctx.req.headers.get("X-Test-Delay-Ms"), LIMITS.delayMs);
    let delayMs =
      delayHdr ??
      sampleLatency(
        latencyProfile[endpointKey] ?? DEFAULT_LATENCY_PROFILE["unmapped"] ?? { kind: "fixed", ms: 50 },
        Math.random
      );

    const sizeHdr = headerInt(ctx.req.headers.get("X-Test-Size-B"), LIMITS.padBytes);
    if (sizeHdr !== null) ctx.padBytes = sizeHdr;
    else if (DEFAULT_SIZES[endpointKey]) ctx.padBytes = (DEFAULT_SIZES[endpointKey] as number) * (0.8 + Math.random() * 0.4);

    switch (decideChaos(chaos, Math.random)) {
      case "error":
        return json(500, { error: "chaos monkey says 500" });
      case "timeout":
        delayMs = CHAOS_TIMEOUT_MS;
    }
    // signal-aware: a dropped client cancels the timer instead of holding it
    // for the full simulated delay
    await sleepMs(delayMs, ctx.req.signal);
    return null;
  };

  /** JSON response with the request's pad target applied, uncached path. */
  const send = (ctx: RouteCtx, status: number, body: Record<string, unknown>): Response => {
    const payload = ctx.padBytes ? padPayload(body, Math.round(ctx.padBytes)) : body;
    return json(status, payload);
  };

  const bad = (ctx: RouteCtx, message: string): Response => send(ctx, 400, { error: message });

  /** Wrap a handler in variability without losing the awaited-body work the
   *  dispatcher already did. */
  const v = (endpointKey: string, handler: Handler): Handler =>
    async (ctx) => (await variability(ctx, endpointKey)) ?? handler(ctx);

  // ---------- REST: pets ----------
  on("GET /api/pets", v("list-pets", (ctx) => {
    const status = ctx.query.get("status") ?? undefined;
    if (status !== undefined && !isPetStatus(status)) {
      return bad(ctx, `status must be one of ${PET_STATUSES.join("|")}`);
    }
    const page = Number(ctx.query.get("page") ?? "0");
    const size = Number(ctx.query.get("size") ?? "20");
    if (!Number.isInteger(page) || page < 0) return bad(ctx, "page must be a non-negative integer");
    if (!Number.isInteger(size) || size < 1 || size > 100) return bad(ctx, "size must be an integer between 1 and 100");

    const base = listBaseFor(status as PetStatus | undefined, page, size);
    if (base) return sendCached(200, base, ctx.padBytes);
    const { items, total } = store.list(status as PetStatus | undefined, page, size);
    return send(ctx, 200, { items, total, page, size } as unknown as Record<string, unknown>);
  }))

  on("GET /api/pets/:petId", v("get-pet", (ctx) => {
    const id = pathInt(ctx.params["petId"]);
    if (id === null) return bad(ctx, "petId must be a positive integer");
    const base = petBaseFor(id);
    if (base) return sendCached(200, base, ctx.padBytes);
    const pet = store.get(id);
    if (!pet) return send(ctx, 404, { error: "Pet not found" });
    return send(ctx, 200, pet as unknown as Record<string, unknown>);
  }))

  on("POST /api/pets", v("create-pet", (ctx) => {
    const parsed = validateNewPet(ctx.jsonBody);
    if (!parsed.ok) return bad(ctx, parsed.error);
    const pet = store.create(parsed.value);
    return send(ctx, 201, pet as unknown as Record<string, unknown>);
  }), "json");

  on("PUT /api/pets/:petId", v("update-pet", (ctx) => {
    const id = pathInt(ctx.params["petId"]);
    if (id === null) return bad(ctx, "petId must be a positive integer");
    const parsed = validateUpdatePet(ctx.jsonBody);
    if (!parsed.ok) return bad(ctx, parsed.error);
    const pet = store.update(id, parsed.value);
    if (!pet) return send(ctx, 404, { error: "Pet not found" });
    return send(ctx, 200, pet as unknown as Record<string, unknown>);
  }))

  on("DELETE /api/pets/:petId", v("delete-pet", (ctx) => {
    const id = pathInt(ctx.params["petId"]);
    if (id === null) return bad(ctx, "petId must be a positive integer");
    if (!store.delete(id)) return send(ctx, 404, { error: "Pet not found" });
    return send(ctx, 200, { deleted: true, id });
  }))

  // ---------- REST: photo ----------
  // ~50KB of JSON per call with a single id-specific head; base and
  // target-sized pads are cached, so per-request work is two slices and a
  // concat. (This route's caching pattern is what the list/get caches above
  // were modelled on.)
  const PHOTO_HEAD = '{"petId":';
  const photoBaseById = new Map<number, string>();
  const photoBaseFor = (id: number): string => {
    let base = photoBaseById.get(id);
    if (base === undefined) {
      base = PHOTO_HEAD + String(id) + ',"photo":["https://cdn.example.test/pets/' + id + '.jpg"],"contentType":"image/jpeg"}';
      photoBaseById.set(id, base);
    }
    return base;
  };
  const photoTailByTarget = new Map<number, string>();
  const photoTailFor = (baseLen: number, targetBytes: number): string => {
    let tail = photoTailByTarget.get(targetBytes);
    if (tail === undefined) {
      tail = "";
      if (targetBytes > baseLen + 12) {
        const padded = JSON.stringify(padPayload({ pad: "" }, targetBytes - (baseLen - 1)));
        tail = "," + padded.slice(1);
      }
      photoTailByTarget.set(targetBytes, tail);
    }
    return tail;
  };

  on("GET /api/pets/:petId/photo", v("pet-photo", (ctx) => {
    const id = pathInt(ctx.params["petId"]);
    if (id === null) return bad(ctx, "petId must be a positive integer");
    const pet = store.get(id);
    if (!pet) return send(ctx, 404, { error: "Pet not found" });
    const base = photoBaseFor(id);
    const body = base.slice(0, -1) + photoTailFor(base.length, Math.round(ctx.padBytes ?? 50000));
    return new Response(body, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
  }))

  // ---------- REST: store ----------
  on("POST /api/store/order", v("place-order", (ctx) => {
    const body = (ctx.jsonBody ?? {}) as Record<string, unknown>;
    const petId = body["petId"];
    if (typeof petId !== "number" || !Number.isSafeInteger(petId) || petId < 1) {
      return bad(ctx, "petId is required and must be a positive integer");
    }
    let quantity = 1;
    if (body["quantity"] !== undefined) {
      const q = body["quantity"];
      if (typeof q !== "number" || !Number.isInteger(q) || q < 1 || q > 100) {
        return bad(ctx, "quantity must be an integer between 1 and 100");
      }
      quantity = q;
    }
    if (!store.get(petId)) return bad(ctx, `Pet ${petId} not found`);
    const order = store.placeOrder({ petId, quantity });
    return send(ctx, 201, order as unknown as Record<string, unknown>);
  }))

  on("GET /api/store/order/:orderId", v("get-order", (ctx) => {
    const id = pathInt(ctx.params["orderId"]);
    if (id === null) return bad(ctx, "orderId must be a positive integer");
    const order = store.getOrder(id);
    if (!order) return send(ctx, 404, { error: "Order not found" });
    return send(ctx, 200, order as unknown as Record<string, unknown>);
  }))

  // ---------- Synthetic stress endpoints ----------
  // No variability: raw paths, so what you measure is the gateway.
  on("GET /api/slow/:ms", async (ctx) => {
    const raw = ctx.params["ms"];
    if (raw === undefined || !/^\d+$/.test(raw)) return bad(ctx, "ms must be a non-negative integer");
    const ms = Number(raw);
    if (!Number.isFinite(ms) || ms > LIMITS.slowMs) return bad(ctx, `ms must be between 0 and ${LIMITS.slowMs}`);
    await sleepMs(ms, ctx.req.signal);
    return json(200, { sleptMs: ms, ts: Date.now() }, { "X-Direct": "1" });
  });

  on("GET /api/big/:size", (ctx) => {
    const raw = ctx.params["size"];
    if (raw === undefined || !/^\d+$/.test(raw)) return bad(ctx, "size must be a non-negative integer");
    const size = Number(raw);
    if (!Number.isFinite(size) || size > LIMITS.bigBytes) {
      return bad(ctx, `size must be between 0 and ${LIMITS.bigBytes}`);
    }
    // stream zero-filled chunks so a 4MB response doesn't materialise on the
    // loop, and the client abort (req.signal) stops the generator
    const CHUNK = 64 * 1024;
    const buf = new Uint8Array(Math.min(size, CHUNK)).fill("Z".charCodeAt(0));
    const signal = ctx.req.signal;
    let streamWritten = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (signal.aborted || streamWritten >= size) { controller.close(); return; }
        const n = Math.min(buf.length, size - streamWritten);
        controller.enqueue(buf.subarray(0, n));
        streamWritten += n;
      }
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(size), "X-Direct": "1" }
    });
  });

  on("POST /api/echo", (ctx) =>
    json(200, { receivedBytes: ctx.echoBytes ?? 0, ts: Date.now() }, { "X-Direct": "1" }), "arrayBuffer");

  // ---------- SOAP ----------
  on("GET /soap/petservice", (ctx) => {
    const asksWsdl = ctx.query.has("wsdl") || (ctx.req.headers.get("accept") ?? "").includes("wsdl");
    if (asksWsdl) {
      const base = `${soapBase(ctx.req)}/soap/petservice`;
      return new Response(WSDL.replace("__SERVICE_LOCATION__", base), {
        status: 200,
        headers: { "Content-Type": "text/xml" }
      });
    }
    return json(405, { error: "Use POST with a SOAP envelope. /soap/petservice?wsdl returns the WSDL." });
  });

  on("POST /soap/petservice", v("soap-ops", (ctx) => {
    const body = ctx.textBody ?? "";
    if (body.length === 0) {
      return new Response(soapFault("Empty body (missing text/xml parser?)"), { status: 400, headers: { "Content-Type": "text/xml" } });
    }
    if (!body.includes("Envelope") || !isWellFormedXml(body)) {
      return new Response(soapFault("Malformed SOAP envelope"), { status: 400, headers: { "Content-Type": "text/xml" } });
    }
    const op = detectOperation(ctx.req.headers.get("SOAPAction") ?? undefined, body);
    if (!op) {
      return new Response(soapFault("Unknown operation; set SOAPAction header"), { status: 400, headers: { "Content-Type": "text/xml" } });
    }
    let result: { ok: boolean; xml: string };
    try {
      result = executeOperation(op, body, store);
    } catch (e) {
      console.error(`[petstore] SOAP ${op} failed:`, e);
      return new Response(soapFault(`Internal error handling ${op}`), { status: 500, headers: { "Content-Type": "text/xml" } });
    }
    const out = ctx.padBytes ? padEnvelope(result.xml, Math.round(ctx.padBytes)) : result.xml;
    return new Response(out, { status: result.ok ? 200 : 400, headers: { "Content-Type": "text/xml" } });
  }));

  // ---------- Admin ----------
  on("GET /admin/latency-profile", () => json(200, latencyProfile));
  on("PATCH /admin/latency-profile", (ctx) => {
    const parsed = validateLatencyPatch(ctx.jsonBody ?? {});
    if (!parsed.ok) return json(400, { error: parsed.error });
    Object.assign(latencyProfile, parsed.value);
    return json(200, latencyProfile);
  });

  on("GET /admin/chaos", () => json(200, chaos));
  on("PUT /admin/chaos", (ctx) => {
    const b = (ctx.jsonBody ?? {}) as Partial<ChaosConfig>;
    const pct = (v: unknown): number => {
      const n = Number(v ?? 0);
      return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
    };
    chaos = { errorRatePct: pct(b.errorRatePct), timeoutRatePct: pct(b.timeoutRatePct) };
    return json(200, chaos);
  });

  on("GET /admin/petstore", () =>
    json(200, { pets: store.count(), orders: store.orderCount(), chaos, capacity: LIMITS.petStoreSize }));

  // body materialisation for routes that read one
  for (const key of ["PUT /api/pets/:petId", "POST /api/store/order", "PATCH /admin/latency-profile", "PUT /admin/chaos"]) {
    routes[key] = { ...routes[key]!, body: "json" };
  }
  routes["POST /soap/petservice"] = { ...routes["POST /soap/petservice"]!, body: "text" };

  return { routes, store, latencyProfile };
}

/** `protocol://host` for the WSDL service location, honouring a proxy's
 *  forwarded headers exactly as Express's `trust proxy` + `req.protocol` did. */
function soapBase(req: Request): string {
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  return `${proto}://${host}`;
}
