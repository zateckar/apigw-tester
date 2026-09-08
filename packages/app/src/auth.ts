import type { NextFunction, Request, Response } from "express";

// Single-file auth gate: `APP_BASIC_AUTH="name:password"` protects everything.
// Unset = no browser/users can log in; service administrators must set it.

interface Creds { user: string; pass: string }

let cached: Creds | null = null;
let cachedRaw: string | undefined;

function credentials(): Creds | null {
  const raw = process.env["APP_BASIC_AUTH"];
  if (raw === cachedRaw) return cached;
  cachedRaw = raw;
  if (!raw) { cached = null; return null; }
  const [user, ...rest] = raw.split(":");
  const pass = rest.join(":");
  cached = user && pass ? { user, pass } : null;
  return cached;
}

export function isConfigured(): boolean {
  return credentials() !== null;
}

function unauthorized(res: Response, realm: string): void {
  res.setHeader("WWW-Authenticate", `Basic realm="${realm}", charset="UTF-8"`);
  res.status(401).send("Unauthorized");
}

/** Middleware: 401 unless Basic Authorization matches APP_BASIC_AUTH. */
export function requireAuth(realm = "apigw-tester") {
  return (req: Request, res: Response, next: NextFunction) => {
    const want = credentials();
    if (!want) {
      // auth not configured → fail closed; no credential route leaks
      res.status(503).json({ error: "server not configured: set APP_BASIC_AUTH=name:password" });
      return;
    }
    const hdr = req.headers["authorization"];
    if (typeof hdr !== "string" || !hdr.startsWith("Basic ")) {
      unauthorized(res, realm);
      return;
    }
    let decoded: string;
    try {
      decoded = Buffer.from(hdr.slice(6), "base64").toString("utf-8");
    } catch {
      unauthorized(res, realm);
      return;
    }
    const i = decoded.indexOf(":");
    if (i < 0 || decoded.slice(0, i) !== want.user || decoded.slice(i + 1) !== want.pass) {
      unauthorized(res, realm);
      return;
    }
    next();
  };
}

export { credentials as readBasicAuthCreds };
