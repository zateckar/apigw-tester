import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import type { ChaosConfig, EndpointLatencyProfile, PetStatus } from "@apigw/shared";
import {
  DEFAULT_CHAOS,
  DEFAULT_LATENCY_PROFILE,
  decideChaos,
  sampleLatency
} from "./latency.js";
import { PetStore, padPayload } from "./store.js";
import { WSDL, detectOperation, executeOperation, soapFault, padEnvelope } from "./soap.js";

const DEFAULT_SIZES: Record<string, number> = {
  "list-pets": 8000,
  "get-pet": 1200,
  "pet-photo": 50000,
  "soap-ops": 3000
};

export function createApp() {
  const app = Router(); // mounted inside the host app; parsing is done upstream
  const store = new PetStore(120);
  const latencyProfile: EndpointLatencyProfile = { ...DEFAULT_LATENCY_PROFILE };
  let chaos: ChaosConfig = { ...DEFAULT_CHAOS };

  // Per-request simulated latency + size + chaos. Runs on /api/* and /soap/* only.
  const variability = (
    endpointKey?: string
  ): ((req: Request, res: Response, next: NextFunction) => void) =>
    (req, res, next) => {
      const key =
        endpointKey ??
        ({
          "GET /api/pets": "list-pets",
          "POST /api/pets": "create-pet",
          "PUT /api/pets/:petId": "update-pet",
          "DELETE /api/pets/:petId": "delete-pet"
        }[req.method + " " + req.path] ?? "unmapped");

      // explicit overrides take precedence
      const delayHdr = Number(req.header("X-Test-Delay-Ms"));
      let delayMs = Number.isFinite(delayHdr) && delayHdr > 0
        ? delayHdr
        : sampleLatency(
            latencyProfile[key] ?? DEFAULT_LATENCY_PROFILE["unmapped"] ?? { kind: "fixed", ms: 50 },
            Math.random
          );

      const sizeHdr = Number(req.header("X-Test-Size-B"));
      if (Number.isFinite(sizeHdr) && sizeHdr > 0) {
        res.locals["padBytes"] = sizeHdr;
      } else if (DEFAULT_SIZES[key]) {
        res.locals["padBytes"] = DEFAULT_SIZES[key] * (0.8 + Math.random() * 0.4);
      }

      switch (decideChaos(chaos, Math.random)) {
        case "error":
          return res.status(500).json({ error: "chaos monkey says 500" });
        case "timeout":
          // abuse hard-timeout: exceed any sane client timeout
          delayMs = 60_000;
      }
      setTimeout(next, delayMs);
    };

  const send = (res: Response, status: number, body: Record<string, unknown>) => {
    const pad = res.locals["padBytes"] as number | undefined;
    const payload = pad ? padPayload(body as Record<string, unknown>, Math.round(pad)) : body;
    res.status(status).json(payload);
  };

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", pets: store.count(), chaos });
  });

  // ---------- REST: pets ----------
  app.get("/api/pets", variability("list-pets"), (req, res) => {
    const status = req.query["status"] as string | undefined;
    if (status && !["available", "pending", "sold"].includes(status)) {
      return send(res, 400, { error: "status must be available|pending|sold" });
    }
    const page = Number(req.query["page"] ?? 0);
    const size = Number(req.query["size"] ?? 20);
    const { items, total } = store.list(status as PetStatus | undefined, page, size);
    send(res, 200, { items, total, page, size } as unknown as Record<string, unknown>);
  });

  app.get("/api/pets/:petId", variability("get-pet"), (req, res) => {
    const pet = store.get(Number(req.params["petId"]));
    if (!pet) return send(res, 404, { error: "Pet not found" });
    send(res, 200, pet as unknown as Record<string, unknown>);
  });

  app.post("/api/pets", variability("create-pet"), (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body["name"] !== "string" || body["name"].length === 0) {
      return send(res, 400, { error: "name is required" });
    }
    const pet = store.create(body);
    send(res, 201, pet as unknown as Record<string, unknown>);
  });

  app.put("/api/pets/:petId", variability("update-pet"), (req, res) => {
    const pet = store.update(Number(req.params["petId"]), (req.body ?? {}) as Record<string, unknown>);
    if (!pet) return send(res, 404, { error: "Pet not found" });
    send(res, 200, pet as unknown as Record<string, unknown>);
  });

  app.delete("/api/pets/:petId", variability("delete-pet"), (req, res) => {
    const ok = store.delete(Number(req.params["petId"]));
    if (!ok) return send(res, 404, { error: "Pet not found" });
    send(res, 200, { deleted: true, id: Number(req.params["petId"]) });
  });

  app.get("/api/pets/:petId/photo", variability("pet-photo"), (req, res) => {
    const pet = store.get(Number(req.params["petId"]));
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
    const petId = Number(body["petId"]);
    if (!Number.isInteger(petId) || !store.get(petId)) {
      return send(res, 400, { error: "valid petId is required" });
    }
    const order = store.placeOrder({ petId, quantity: Number(body["quantity"] ?? 1) });
    send(res, 201, order as unknown as Record<string, unknown>);
  });

  app.get("/api/store/order/:orderId", variability("get-order"), (req, res) => {
    const order = store.getOrder(Number(req.params["orderId"]));
    if (!order) return send(res, 404, { error: "Order not found" });
    send(res, 200, order as unknown as Record<string, unknown>);
  });

  // ---------- Synthetic stress endpoints (used by the load driver's classes) ----------
  // /api/slow/:ms — sleep before responding; stress GW's slow-response handling.
  // No additional variability put on top: this is a raw path — measured.
  app.get("/api/slow/:ms", (req, res) => {
    const ms = Math.max(0, Math.min(10_000, Number(req.params["ms"] ?? 500)));
    res.setHeader("X-Direct", "1");
    setTimeout(() => { send(res, 200, { sleptMs: ms, ts: Date.now() }); }, ms);
  });

  // /api/big/:size — return a body of exactly that many bytes, streamed without
  // extra application-side latency, so the overhead is the GW's proxy buffer.
  app.get("/api/big/:size", (req, res) => {
    const size = Math.max(0, Math.min(10 * 1024 * 1024, Number(req.params["size"] ?? 100_000)));
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", size);
    res.setHeader("X-Direct", "1");
    // build in chunks so the loop doesn't hold the event loop
    const CHUNK = 64 * 1024;
    const buf = Buffer.alloc(Math.min(size, CHUNK), "Z".charCodeAt(0));
    let written = 0;
    const write = () => {
      while (written < size) {
        const n = Math.min(buf.length, size - written);
        if (!res.write(buf.subarray(0, n))) { written += n; res.once("drain", write); return; }
        written += n;
      }
      res.end();
    };
    write();
  });

  // /api/echo — echo the request body back; stress GW's big-request handling.
  app.post("/api/echo", (req, res) => {
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
    if (!body.includes("soap:Envelope") && !body.includes("Envelope")) {
      res.type("text/xml").status(400).send(soapFault("Malformed SOAP envelope"));
      return;
    }
    const op = detectOperation(req.header("SOAPAction"), body);
    if (!op) {
      res.type("text/xml").status(400).send(soapFault("Unknown operation; set SOAPAction header"));
      return;
    }
    const { ok, xml } = executeOperation(op, body, store);
    const pad = res.locals["padBytes"] as number | undefined;
    const out = pad ? padEnvelope(xml, Math.round(pad)) : xml;
    res.type("text/xml").status(ok ? 200 : 400).send(out);
  });

  // ---------- Admin: latency profile & chaos ----------
  app.get("/admin/latency-profile", (_req, res) => res.json(latencyProfile));
  app.patch("/admin/latency-profile", (req, res) => {
    const patch = (req.body ?? {}) as EndpointLatencyProfile;
    Object.assign(latencyProfile, patch);
    res.json(latencyProfile);
  });

  app.get("/admin/chaos", (_req, res) => res.json(chaos));
  app.put("/admin/chaos", (req, res) => {
    const b = (req.body ?? {}) as Partial<ChaosConfig>;
    chaos = {
      errorRatePct: Math.max(0, Math.min(100, Number(b.errorRatePct ?? 0))),
      timeoutRatePct: Math.max(0, Math.min(100, Number(b.timeoutRatePct ?? 0)))
    };
    res.json(chaos);
  });

  return { app, store, latencyProfile };
}
