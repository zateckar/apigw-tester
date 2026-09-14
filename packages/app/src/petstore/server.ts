import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
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
 *  gateway's own 401/404), and the driver falls back to its baseline there. */
export const SERVER_MS_HEADER = "X-Server-Ms";

/** Express middleware stamping SERVER_MS_HEADER at response time. */
function serverMsStamp(): (req: Request, res: Response, next: NextFunction) => void {
  return (_req, res, next) => {
    const enteredAt = Date.now();
    // patch writeHead so the header survives every response path (json, send,
    // chunked writes) without touching any handler — 'finish' fires after the
    // response is written and setHeader is illegal there
    const writeHead = res.writeHead.bind(res);
    res.writeHead = function (this: Response, ...args: Parameters<Response["writeHead"]>) {
      if (!res.headersSent) res.setHeader(SERVER_MS_HEADER, String(Math.max(0, Date.now() - enteredAt)));
      return writeHead(...args);
    } as Response["writeHead"];
    next();
  };
}

/** Parse a path parameter that must be a positive integer. */
export function pathInt(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** Parse a header that must be a non-negative integer, clamped to `max`. */
export function headerInt(raw: string | undefined, max: number): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(n, max);
}

export function createApp() {
  const app = Router(); // mounted inside the host app; parsing is done upstream
  const store = new PetStore(120);
  const latencyProfile: EndpointLatencyProfile = { ...DEFAULT_LATENCY_PROFILE };
  let chaos: ChaosConfig = { ...DEFAULT_CHAOS };

  // Per-request simulated latency + size + chaos. Runs on /api/* and /soap/* only.
  const variability = (
    endpointKey: string
  ): ((req: Request, res: Response, next: NextFunction) => void) =>
    (req, res, next) => {
      // stamp X-Server-Ms first, so the entry time counts the simulated delay too
      serverMsStamp()(req, res, () => undefined);
      // explicit overrides take precedence, both hard-clamped
      const delayHdr = headerInt(req.header("X-Test-Delay-Ms"), LIMITS.delayMs);
      let delayMs =
        delayHdr ??
        sampleLatency(
          latencyProfile[endpointKey] ?? DEFAULT_LATENCY_PROFILE["unmapped"] ?? { kind: "fixed", ms: 50 },
          Math.random
        );

      const sizeHdr = headerInt(req.header("X-Test-Size-B"), LIMITS.padBytes);
      if (sizeHdr !== null) {
        res.locals["padBytes"] = sizeHdr;
      } else if (DEFAULT_SIZES[endpointKey]) {
        res.locals["padBytes"] = (DEFAULT_SIZES[endpointKey] as number) * (0.8 + Math.random() * 0.4);
      }

      switch (decideChaos(chaos, Math.random)) {
        case "error":
          return res.status(500).json({ error: "chaos monkey says 500" });
        case "timeout":
          delayMs = CHAOS_TIMEOUT_MS;
      }
      const timer = setTimeout(next, delayMs);
      // if the client walks away, stop holding the timer
      res.once("close", () => clearTimeout(timer));
    };

  const send = (res: Response, status: number, body: Record<string, unknown>) => {
    const pad = res.locals["padBytes"] as number | undefined;
    const payload = pad ? padPayload(body, Math.round(pad)) : body;
    res.status(status).json(payload);
  };

  const bad = (res: Response, message: string) => send(res, 400, { error: message });

  // ---------- REST: pets ----------
  app.get("/api/pets", variability("list-pets"), (req, res) => {
    const status = req.query["status"];
    if (status !== undefined) {
      if (!isPetStatus(status)) return bad(res, `status must be one of ${PET_STATUSES.join("|")}`);
    }
    const pageRaw = req.query["page"] ?? "0";
    const sizeRaw = req.query["size"] ?? "20";
    const page = Number(pageRaw);
    const size = Number(sizeRaw);
    if (!Number.isInteger(page) || page < 0) return bad(res, "page must be a non-negative integer");
    if (!Number.isInteger(size) || size < 1 || size > 100) return bad(res, "size must be an integer between 1 and 100");

    const { items, total } = store.list(status as PetStatus | undefined, page, size);
    send(res, 200, { items, total, page, size } as unknown as Record<string, unknown>);
  });

  app.get("/api/pets/:petId", variability("get-pet"), (req, res) => {
    const id = pathInt(req.params["petId"]);
    if (id === null) return bad(res, "petId must be a positive integer");
    const pet = store.get(id);
    if (!pet) return send(res, 404, { error: "Pet not found" });
    send(res, 200, pet as unknown as Record<string, unknown>);
  });

  app.post("/api/pets", variability("create-pet"), (req, res) => {
    const parsed = validateNewPet(req.body);
    if (!parsed.ok) return bad(res, parsed.error);
    const pet = store.create(parsed.value);
    send(res, 201, pet as unknown as Record<string, unknown>);
  });

  app.put("/api/pets/:petId", variability("update-pet"), (req, res) => {
    const id = pathInt(req.params["petId"]);
    if (id === null) return bad(res, "petId must be a positive integer");
    const parsed = validateUpdatePet(req.body);
    if (!parsed.ok) return bad(res, parsed.error);
    const pet = store.update(id, parsed.value);
    if (!pet) return send(res, 404, { error: "Pet not found" });
    send(res, 200, pet as unknown as Record<string, unknown>);
  });

  app.delete("/api/pets/:petId", variability("delete-pet"), (req, res) => {
    const id = pathInt(req.params["petId"]);
    if (id === null) return bad(res, "petId must be a positive integer");
    if (!store.delete(id)) return send(res, 404, { error: "Pet not found" });
    send(res, 200, { deleted: true, id });
  });

  app.get("/api/pets/:petId/photo", variability("pet-photo"), (req, res) => {
    const id = pathInt(req.params["petId"]);
    if (id === null) return bad(res, "petId must be a positive integer");
    const pet = store.get(id);
    if (!pet) return send(res, 404, { error: "Pet not found" });
    const pad = res.locals["padBytes"] as number | undefined;
    const padded = padPayload({ petId: pet.id, photo: pet.photoUrls, contentType: "image/jpeg" }, Math.round(pad ?? 50000));
    const buf = Buffer.from(JSON.stringify(padded), "utf-8");
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", buf.length);
    res.send(buf);
  });

  // ---------- REST: store ----------
  app.post("/api/store/order", variability("place-order"), (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const petId = body["petId"];
    if (typeof petId !== "number" || !Number.isSafeInteger(petId) || petId < 1) {
      return bad(res, "petId is required and must be a positive integer");
    }
    let quantity = 1;
    if (body["quantity"] !== undefined) {
      const q = body["quantity"];
      if (typeof q !== "number" || !Number.isInteger(q) || q < 1 || q > 100) {
        return bad(res, "quantity must be an integer between 1 and 100");
      }
      quantity = q;
    }
    if (!store.get(petId)) return bad(res, `Pet ${petId} not found`);
    const order = store.placeOrder({ petId, quantity });
    send(res, 201, order as unknown as Record<string, unknown>);
  });

  app.get("/api/store/order/:orderId", variability("get-order"), (req, res) => {
    const id = pathInt(req.params["orderId"]);
    if (id === null) return bad(res, "orderId must be a positive integer");
    const order = store.getOrder(id);
    if (!order) return send(res, 404, { error: "Order not found" });
    send(res, 200, order as unknown as Record<string, unknown>);
  });

  // ---------- Synthetic stress endpoints (used by the load driver's classes) ----------
  // No variability on top: these are raw paths, so what you measure is the GW.
  app.get("/api/slow/:ms", serverMsStamp(), (req, res) => {
    const raw = req.params["ms"];
    if (raw === undefined || !/^\d+$/.test(raw)) return bad(res, "ms must be a non-negative integer");
    const ms = Number(raw);
    if (!Number.isFinite(ms) || ms > LIMITS.slowMs) return bad(res, `ms must be between 0 and ${LIMITS.slowMs}`);
    res.setHeader("X-Direct", "1");
    const timer = setTimeout(() => { send(res, 200, { sleptMs: ms, ts: Date.now() }); }, ms);
    res.once("close", () => clearTimeout(timer));
  });

  app.get("/api/big/:size", serverMsStamp(), (req, res) => {
    const raw = req.params["size"];
    if (raw === undefined || !/^\d+$/.test(raw)) return bad(res, "size must be a non-negative integer");
    const size = Number(raw);
    if (!Number.isFinite(size) || size > LIMITS.bigBytes) {
      return bad(res, `size must be between 0 and ${LIMITS.bigBytes}`);
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", size);
    res.setHeader("X-Direct", "1");
    // build in chunks so the loop doesn't hold the event loop
    const CHUNK = 64 * 1024;
    const buf = Buffer.alloc(Math.min(size, CHUNK), "Z".charCodeAt(0));
    let written = 0;
    let aborted = false;
    res.once("close", () => { aborted = true; });
    const write = () => {
      if (aborted) return;
      while (written < size) {
        const n = Math.min(buf.length, size - written);
        if (!res.write(buf.subarray(0, n))) { written += n; res.once("drain", write); return; }
        written += n;
      }
      res.end();
    };
    write();
  });

  app.post("/api/echo", serverMsStamp(), (req, res) => {
    const raw = req.body as unknown;
    const bytes = Buffer.isBuffer(raw) ? raw.byteLength
      : typeof raw === "string" ? Buffer.byteLength(raw)
      : Buffer.byteLength(JSON.stringify(raw ?? {}));
    res.setHeader("X-Direct", "1");
    res.json({ receivedBytes: bytes, ts: Date.now() });
  });

  // ---------- SOAP ----------
  app.get("/soap/petservice", (req, res) => {
    const asksWsdl = (req.query["wsdl"] as string | undefined) !== undefined
      || (req.headers["accept"] ?? "").includes("wsdl");
    if (asksWsdl) {
      const base = `${req.protocol}://${req.get("host")}/soap/petservice`;
      res.type("text/xml").send(WSDL.replace("__SERVICE_LOCATION__", base));
      return;
    }
    res.status(405).json({ error: "Use POST with a SOAP envelope. /soap/petservice?wsdl returns the WSDL." });
  });

  app.post("/soap/petservice", variability("soap-ops"), (req, res) => {
    const body = typeof req.body === "string" && req.body.length > 0 ? req.body : "";
    if (body.length === 0) {
      res.type("text/xml").status(400).send(soapFault("Empty body (missing text/xml parser?)"));
      return;
    }
    if (!body.includes("Envelope") || !isWellFormedXml(body)) {
      res.type("text/xml").status(400).send(soapFault("Malformed SOAP envelope"));
      return;
    }
    const op = detectOperation(req.header("SOAPAction"), body);
    if (!op) {
      res.type("text/xml").status(400).send(soapFault("Unknown operation; set SOAPAction header"));
      return;
    }
    let result: { ok: boolean; xml: string };
    try {
      result = executeOperation(op, body, store);
    } catch (e) {
      // never let an internal throw escape as an HTML stack trace
      res.type("text/xml").status(500).send(soapFault(`Internal error handling ${op}`));
      console.error(`[petstore] SOAP ${op} failed:`, e);
      return;
    }
    const pad = res.locals["padBytes"] as number | undefined;
    const out = pad ? padEnvelope(result.xml, Math.round(pad)) : result.xml;
    res.type("text/xml").status(result.ok ? 200 : 400).send(out);
  });

  // ---------- Admin: latency profile & chaos ----------
  app.get("/admin/latency-profile", (_req, res) => res.json(latencyProfile));
  app.patch("/admin/latency-profile", (req, res) => {
    const parsed = validateLatencyPatch(req.body ?? {});
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    Object.assign(latencyProfile, parsed.value);
    res.json(latencyProfile);
  });

  app.get("/admin/chaos", (_req, res) => res.json(chaos));
  app.put("/admin/chaos", (req, res) => {
    const b = (req.body ?? {}) as Partial<ChaosConfig>;
    const pct = (v: unknown): number => {
      const n = Number(v ?? 0);
      return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
    };
    chaos = { errorRatePct: pct(b.errorRatePct), timeoutRatePct: pct(b.timeoutRatePct) };
    res.json(chaos);
  });

  /** Petstore-internal stats — the public /health in app.ts stays minimal. */
  app.get("/admin/petstore", (_req, res) =>
    res.json({ pets: store.count(), orders: store.orderCount(), chaos, capacity: LIMITS.petStoreSize })
  );

  return { app, store, latencyProfile };
}
