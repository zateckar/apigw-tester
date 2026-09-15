import { timingSafeEqual } from "node:crypto";

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
/** same value as a plain string: the happy path is a single allocation-free
 *  === rather than a per-request Buffer.from */
let expectedAuthStr: string | null = null;

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
  expectedAuthStr = cached
    ? `Basic ${Buffer.from(`${cached.user}:${cached.pass}`).toString("base64")}`
    : null;
  expectedAuth = expectedAuthStr ? Buffer.from(expectedAuthStr, "utf-8") : null;
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

function unauthorized(realm: string): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": `Basic realm="${realm}", charset="UTF-8"` }
  });
}

/** 401 unless Basic Authorization matches APP_BASIC_AUTH; a null return means
 *  the request may proceed. Middleware-shaped so the dispatcher can apply it
 *  to everything below /health without a per-route wrap. */
export function requireAuth(req: Request, realm = "apigw-tester"): Response | null {
  const want = expectedAuthHeader();
  if (!want) {
    // auth not configured → fail closed; no credential route leaks
    return Response.json({ error: "server not configured: set APP_BASIC_AUTH=name:password" }, { status: 503 });
  }
  const hdr = req.headers.get("authorization");
  if (hdr === null) return unauthorized(realm);
  // allocation-free happy path; the timing-safe compare below stays the
  // reject path so wrong guesses keep costing constant time
  if (hdr === expectedAuthStr) return null;
  // compare the whole header against the precomputed one. The length guard
  // comes first: timingSafeEqual throws on unequal lengths, and the attacker
  // already knows everything the guard "leaks" (they sent the length).
  const got = Buffer.from(hdr, "utf-8");
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    return unauthorized(realm);
  }
  return null;
}

export { credentials as readBasicAuthCreds };
