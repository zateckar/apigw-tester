import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Pet } from "@apigw/shared";
import { buildApp } from "../app.js";
import { readConfig } from "../config.js";
import { PetStore } from "./store.js";

/**
 * The in-process petstore caches serialized responses for the seed pets, which
 * are ~70% of generated traffic. This suite is about the one thing that cache
 * may never do: outlive its subject.
 *
 * It matters more here than in an ordinary service. This process is the
 * reference origin the gateway under test is compared against; a stale body
 * here is not a wrong answer to a user, it is a wrong answer to the
 * measurement, and it would read as the gateway corrupting responses.
 *
 * Its own app instance, because every case mutates seed pets and the contract
 * suite asserts on their unmutated form.
 */

process.env["APP_BASIC_AUTH"] = "test:pw-123";
const AUTH = `Basic ${Buffer.from("test:pw-123").toString("base64")}`;

let base: string;
let built: ReturnType<typeof buildApp>;
let server: ReturnType<ReturnType<typeof buildApp>["listen"]>;

/**
 * No simulated latency, and an explicit response size.
 *
 * The default pad target carries ±20% jitter per request, so two reads of the
 * same cached page differ in length by design. Asking for an exact size is what
 * lets these cases compare bodies at all — zero would not do it, since the
 * contract reads a non-positive size as "unspecified" and falls back to the
 * jittered default.
 */
const HEADERS = {
  authorization: AUTH,
  "X-Test-Delay-Ms": "0",
  "X-Test-Size-B": "20000",
  "Content-Type": "application/json"
};

async function get(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, { headers: HEADERS });
  const text = await res.text();
  return { status: res.status, json: text === "" ? {} : JSON.parse(text) as Record<string, unknown> };
}

async function send(method: string, path: string, body?: unknown): Promise<number> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: HEADERS,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  await res.text();
  return res.status;
}

beforeAll(() => {
  built = buildApp({ ...readConfig(), sutBackend: "ts", dbPath: ":memory:", publicDir: "nope" });
  server = built.listen(0);
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await built.shutdown();
  server.stop(true);
}, 30_000);

describe("cached seed-pet responses follow the store", () => {
  it("serves the updated body after a pet is changed", async () => {
    const before = await get("/api/pets/5");
    expect(before.status).toBe(200);
    expect(before.json["name"]).not.toBe("Renamed");

    expect(await send("PUT", "/api/pets/5", { name: "Renamed" })).toBe(200);

    const after = await get("/api/pets/5");
    expect(after.status).toBe(200);
    expect(after.json["name"]).toBe("Renamed");
  });

  it("serves the updated body inside a cached listing page", async () => {
    // the listing cache is the harder half: an update leaves the pet count
    // identical, so counting rows could never have noticed this
    const page = "/api/pets?page=0&size=20";
    const before = await get(page);
    const namesBefore = (before.json["items"] as Pet[]).map((p) => p.name);
    expect(namesBefore).not.toContain("Listed");

    expect(await send("PUT", "/api/pets/3", { name: "Listed" })).toBe(200);

    const after = await get(page);
    const named = (after.json["items"] as Pet[]).find((p) => p.id === 3);
    expect(named?.name).toBe("Listed");
  });

  it("stops serving a pet that has been deleted", async () => {
    // the worst shape of the defect: a cached 200 body for a pet the store has
    // no record of, which no amount of gateway correctness could reconcile
    expect((await get("/api/pets/7")).status).toBe(200);
    expect(await send("DELETE", "/api/pets/7")).toBe(200);
    expect((await get("/api/pets/7")).status).toBe(404);
  });

  it("still caches: repeated reads with no mutation are byte-identical", async () => {
    // the point of the fix is correct invalidation, not the removal of the
    // cache — listPets is ~50% of generated traffic at ~8KB a response
    const one = await fetch(`${base}/api/pets?page=1&size=20`, { headers: HEADERS });
    const two = await fetch(`${base}/api/pets?page=1&size=20`, { headers: HEADERS });
    expect(await one.text()).toBe(await two.text());
  });

  it("re-caches after the mutation rather than giving up on the page", async () => {
    const page = "/api/pets?page=2&size=20";
    await get(page);
    expect(await send("PUT", "/api/pets/45", { name: "Recached" })).toBe(200);
    const first = await fetch(`${base}${page}`, { headers: HEADERS });
    const second = await fetch(`${base}${page}`, { headers: HEADERS });
    const body = await first.text();
    expect(body).toBe(await second.text());
    expect(body).toContain("Recached");
  });
});

describe("PetStore.version", () => {
  it("moves on every change and stands still otherwise", () => {
    const store = new PetStore(10, 100);
    const v0 = store.version;

    store.get(1);
    store.list(undefined, 0, 5);
    expect(store.version).toBe(v0);

    store.update(1, { name: "x" });
    const v1 = store.version;
    expect(v1).toBeGreaterThan(v0);

    const created = store.create({ name: "y", photoUrls: [] });
    const v2 = store.version;
    expect(v2).toBeGreaterThan(v1);

    store.delete(created.id);
    expect(store.version).toBeGreaterThan(v2);
  });

  it("does not move for an update or delete that found nothing", () => {
    const store = new PetStore(10, 100);
    const v0 = store.version;
    expect(store.update(9999, { name: "x" })).toBeUndefined();
    expect(store.delete(9999)).toBe(false);
    expect(store.version).toBe(v0);
  });

  it("changes even when the pet count does not", () => {
    // the property the old cache key lacked
    const store = new PetStore(10, 100);
    const count = store.count();
    const v0 = store.version;
    store.update(2, { status: "sold" });
    expect(store.count()).toBe(count);
    expect(store.version).not.toBe(v0);
  });
});
