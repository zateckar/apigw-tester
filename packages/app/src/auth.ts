import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

// Single-file auth gate: `APP_BASIC_AUTH="name:password"` protects everything.
// Unset = no browser/users can log in; service administrators must set it.

interface Creds { user: string; pass: string }

let cached: Creds | null = null;
let cachedRaw: string | undefined;
/** The exact Authorization header we accept, kept as a Buffer alongside the
 *  creds. The driver's requests are hot enough that decoding base64 twice per
 *  request just to re-derive a constant showed up in profiles; the whole
 *  header ("Basic …") is one string, so the check is one fixed-time compare. */
let expectedAuth: Buffer | null = null;

function credentials(): Creds | null {
  const raw = process.env["APP_BASIC_AUTH"];
  if (raw === cachedRaw) return cached;
  cachedRaw = raw;
  cached = null;
  if (raw) {
    const [user, ...rest] = raw.split(":");
    const pass = rest.join(":");
    if (user && pass) cached = { user, pass };
  }
  expectedAuth = cached
    ? Buffer.from(`Basic ${Buffer.from(`${cached.user}:${cached.pass}`).toString("base64")}`, "utf-8")
    : null;
  return cached;
}

export function isConfigured(): boolean {
  return credentials() !== null;
}

/** The exact value of an accepted `Authorization: Basic …` header, or null
 *  when auth is not configured. Guaranteed consistent with credentials(). */
export function expectedAuthHeader(): Buffer | null {
  credentials();
  return expectedAuth;
}

function unauthorized(res: Response, realm: string): void {
  res.setHeader("WWW-Authenticate", `Basic realm="${realm}", charset="UTF-8"`);
  res.status(401).send("Unauthorized");
}

/** Middleware: 401 unless Basic Authorization matches APP_BASIC_AUTH. */
export function requireAuth(realm = "apigw-tester") {
  return (req: Request, res: Response, next: NextFunction) => {
    const want = expectedAuthHeader();
    if (!want) {
      // auth not configured → fail closed; no credential route leaks
      res.status(503).json({ error: "server not configured: set APP_BASIC_AUTH=name:password" });
      return;
    }
    const hdr = req.headers["authorization"];
    if (typeof hdr !== "string") {
      unauthorized(res, realm);
      return;
    }
    // compare the whole header against the precomputed one. The length guard
    // comes first: timingSafeEqual throws on unequal lengths, and the attacker
    // already knows everything the guard "leaks" (they sent the length).
    const got = Buffer.from(hdr, "utf-8");
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      unauthorized(res, realm);
      return;
    }
    next();
  };
}

export { credentials as readBasicAuthCreds };
