import type { Order, Pet, PetStatus } from "@apigw/shared";
import { LIMITS, PET_STATUSES, isPetStatus } from "@apigw/shared";

const SPECIES = ["Dog", "Cat", "Bird", "Fish", "Rabbit", "Lizard", "Hamster", "Turtle"];
const NAMES = [
  "Buddy", "Max", "Bella", "Charlie", "Luna", "Rocky", "Milo", "Daisy",
  "Toby", "Lola", "Coco", "Jack", "Ruby", "Duke", "Sadie", "Zeus",
  "Molly", "Bear", "Chloe", "Tucker", "Penny", "Leo", "Sophie", "Oliver",
  "Nala", "Simba", "Lily", "Oscar", "Ginger", "Felix", "Pepper", "Shadow"
];
const TAGS = ["friendly", "trained", "young", "rescue", "senior", "energetic", "calm", "fluffy"];
const STATUSES: PetStatus[] = ["available", "available", "available", "pending", "sold"];

const LOREM =
  "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor " +
  "incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud " +
  "exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute " +
  "irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla " +
  "pariatur excepteur sint occaecat cupidatat non proident sunt in culpa qui officia " +
  "deserunt mollit anim id est laborum";

const MAX_NAME = 200;
const MAX_DESC = 4000;

function pick<T>(arr: readonly T[], i: number): T {
  return arr[i % arr.length] as T;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

/** Shape accepted by POST /api/pets — mirrors components/schemas/NewPet. */
export interface NewPetInput {
  name: string;
  status?: PetStatus;
  category?: { id: number; name: string };
  tags?: { id: number; name: string }[];
  photoUrls?: string[];
  description?: string;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateIdName(v: unknown, label: string): Validated<{ id: number; name: string }> {
  if (!isPlainObject(v)) return { ok: false, error: `${label} must be an object` };
  const id = v["id"];
  const name = v["name"];
  if (typeof id !== "number" || !Number.isInteger(id) || id < 0) {
    return { ok: false, error: `${label}.id must be a non-negative integer` };
  }
  if (typeof name !== "string" || name.length > 100) {
    return { ok: false, error: `${label}.name must be a string of at most 100 characters` };
  }
  return { ok: true, value: { id, name } };
}

/** Validate a POST /api/pets body against the published NewPet schema. */
export function validateNewPet(body: unknown): Validated<NewPetInput> {
  if (!isPlainObject(body)) return { ok: false, error: "body must be a JSON object" };

  const name = body["name"];
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME) {
    return { ok: false, error: `name is required and must be a string of 1-${MAX_NAME} characters` };
  }

  const out: NewPetInput = { name };

  if (body["status"] !== undefined) {
    if (!isPetStatus(body["status"])) {
      return { ok: false, error: `status must be one of ${PET_STATUSES.join("|")}` };
    }
    out.status = body["status"];
  }

  if (body["category"] !== undefined) {
    const c = validateIdName(body["category"], "category");
    if (!c.ok) return c;
    out.category = c.value;
  }

  if (body["tags"] !== undefined) {
    const tags = body["tags"];
    if (!Array.isArray(tags) || tags.length > 20) {
      return { ok: false, error: "tags must be an array of at most 20 entries" };
    }
    const parsed: { id: number; name: string }[] = [];
    for (const t of tags) {
      const r = validateIdName(t, "tags[]");
      if (!r.ok) return r;
      parsed.push(r.value);
    }
    out.tags = parsed;
  }

  if (body["photoUrls"] !== undefined) {
    const urls = body["photoUrls"];
    if (!Array.isArray(urls) || urls.length > 10 || urls.some((u) => typeof u !== "string")) {
      return { ok: false, error: "photoUrls must be an array of at most 10 strings" };
    }
    out.photoUrls = urls as string[];
  }

  if (body["description"] !== undefined) {
    const d = body["description"];
    if (typeof d !== "string" || d.length > MAX_DESC) {
      return { ok: false, error: `description must be a string of at most ${MAX_DESC} characters` };
    }
    out.description = d;
  }

  return { ok: true, value: out };
}

export type UpdatePetInput = Partial<Pick<Pet, "name" | "status" | "description">>;

/** Validate a PUT /api/pets/{petId} body against the published UpdatePet schema. */
export function validateUpdatePet(body: unknown): Validated<UpdatePetInput> {
  if (!isPlainObject(body)) return { ok: false, error: "body must be a JSON object" };
  const out: UpdatePetInput = {};

  if (body["name"] !== undefined) {
    const n = body["name"];
    if (typeof n !== "string" || n.length === 0 || n.length > MAX_NAME) {
      return { ok: false, error: `name must be a string of 1-${MAX_NAME} characters` };
    }
    out.name = n;
  }
  if (body["status"] !== undefined) {
    if (!isPetStatus(body["status"])) {
      return { ok: false, error: `status must be one of ${PET_STATUSES.join("|")}` };
    }
    out.status = body["status"];
  }
  if (body["description"] !== undefined) {
    const d = body["description"];
    if (typeof d !== "string" || d.length > MAX_DESC) {
      return { ok: false, error: `description must be a string of at most ${MAX_DESC} characters` };
    }
    out.description = d;
  }
  if (Object.keys(out).length === 0) {
    return { ok: false, error: "body must set at least one of name, status, description" };
  }
  return { ok: true, value: out };
}

/**
 * In-memory petstore.
 *
 * Bounded on purpose: the driver creates pets continuously and an always-on rig
 * would otherwise grow without limit, and — worse — a full Map copy per list
 * call would make the SUT itself slower over time, silently inflating the
 * GW-overhead number this whole tool exists to measure. So: generated pets are
 * evicted FIFO past `capacity`, and list() walks a per-status index with an
 * early break instead of copying everything.
 */
export class PetStore {
  private pets = new Map<number, Pet>();
  /** insertion-ordered id sets per status — Set iteration order is insertion order */
  private byStatus = new Map<PetStatus, Set<number>>();
  /** FIFO of ids created at runtime (seed pets are never evicted) */
  private generated: number[] = [];
  private nextPetId: number;
  private nextOrderId = 1;
  private readonly seedCount: number;
  private readonly capacity: number;
  private orders = new Map<number, Order>();
  private readonly maxOrders: number;

  constructor(seedCount = 120, capacity = LIMITS.petStoreSize) {
    this.seedCount = seedCount;
    this.capacity = Math.max(seedCount + 1, capacity);
    this.maxOrders = this.capacity;
    for (const s of PET_STATUSES) this.byStatus.set(s, new Set());

    for (let i = 0; i < seedCount; i++) {
      const id = i + 1;
      this.insert({
        id,
        name: `${pick(NAMES, i * 7)} the ${pick(SPECIES, i * 3)}`,
        status: pick(STATUSES, i * 11),
        category: { id: (i % SPECIES.length) + 1, name: pick(SPECIES, i * 3) },
        tags: [
          { id: 1, name: pick(TAGS, i * 5) },
          { id: 2, name: pick(TAGS, i * 5 + 3) }
        ],
        photoUrls: [`https://cdn.example.test/pets/${id}.jpg`],
        description: LOREM.slice(0, 30 + ((i * 37) % 300))
      });
    }
    this.nextPetId = seedCount + 1;
  }

  private insert(pet: Pet): void {
    this.pets.set(pet.id, pet);
    this.byStatus.get(pet.status)?.add(pet.id);
  }

  private remove(id: number): boolean {
    const pet = this.pets.get(id);
    if (!pet) return false;
    this.byStatus.get(pet.status)?.delete(id);
    return this.pets.delete(id);
  }

  /** Drop the oldest runtime-created pets until we are back under capacity. */
  private evictIfNeeded(): void {
    while (this.pets.size > this.capacity && this.generated.length > 0) {
      const victim = this.generated.shift() as number;
      this.remove(victim);
    }
  }

  list(status?: PetStatus, page = 0, size = 20): { items: Pet[]; total: number } {
    const safeSize = Math.min(Math.max(Math.trunc(size) || 20, 1), 100);
    const safePage = Math.max(0, Math.trunc(page) || 0);
    const start = safePage * safeSize;

    const ids = status ? this.byStatus.get(status) : undefined;
    const total = status ? (ids?.size ?? 0) : this.pets.size;

    const items: Pet[] = [];
    if (start < total) {
      let i = 0;
      const source: Iterable<number> = ids ?? this.pets.keys();
      for (const id of source) {
        if (i >= start + safeSize) break;
        if (i >= start) {
          const pet = this.pets.get(id);
          if (pet) items.push(pet);
        }
        i++;
      }
    }
    return { items, total };
  }

  get(id: number): Pet | undefined {
    return this.pets.get(id);
  }

  /** Takes an already-validated NewPetInput (see validateNewPet). */
  create(input: NewPetInput): Pet {
    const pet: Pet = {
      id: this.nextPetId++,
      name: input.name,
      status: input.status ?? "available",
      category: input.category ?? { id: 0, name: "Misc" },
      tags: input.tags ?? [],
      photoUrls: input.photoUrls ?? [],
      ...(input.description !== undefined ? { description: input.description } : {})
    };
    this.insert(pet);
    this.generated.push(pet.id);
    this.evictIfNeeded();
    return pet;
  }

  /** Takes an already-validated UpdatePetInput (see validateUpdatePet). */
  update(id: number, input: UpdatePetInput): Pet | undefined {
    const existing = this.pets.get(id);
    if (!existing) return undefined;
    const merged: Pet = { ...existing, ...input, id };
    if (merged.status !== existing.status) {
      this.byStatus.get(existing.status)?.delete(id);
      this.byStatus.get(merged.status)?.add(id);
    }
    this.pets.set(id, merged);
    return merged;
  }

  delete(id: number): boolean {
    const removed = this.remove(id);
    if (removed) {
      const idx = this.generated.indexOf(id);
      if (idx >= 0) this.generated.splice(idx, 1);
    }
    return removed;
  }

  /** A pet id that currently exists — used to build contract-valid requests. */
  randomId(rand: () => number): number {
    // seed ids are never evicted, so this range is always populated
    return 1 + Math.floor(rand() * Math.max(1, Math.min(this.seedCount, this.pets.size)));
  }

  placeOrder(input: { petId: number; quantity?: number }): Order {
    const order: Order = {
      id: this.nextOrderId++,
      petId: input.petId,
      quantity: input.quantity ?? 1,
      shipDate: new Date(Date.now() + 86400_000).toISOString(),
      status: "placed",
      complete: false
    };
    this.orders.set(order.id, order);
    if (this.orders.size > this.maxOrders) {
      const oldest = this.orders.keys().next();
      if (!oldest.done) this.orders.delete(oldest.value);
    }
    return order;
  }

  getOrder(id: number): Order | undefined {
    return this.orders.get(id);
  }

  count(): number {
    return this.pets.size;
  }

  orderCount(): number {
    return this.orders.size;
  }
}

/** Pad resolution: the exact target is rounded to this before looking up a
 *  shared filler string, so the "0.8 to 1.2 × default" jitter still lands on
 *  hundreds of distinct sizes while the pool stays tiny. */
const PAD_RESOLUTION = 256;
/** filler strings kept per rounded target size */
const PAD_POOL = 4;

const padPools = new Map<number, string[]>();

/** Pad fibre for roughly `targetBytes` total output, from a small pool. The
 *  %-over-fibre count varies from request to request so the emitted size
 *  still jitters within the bucket exactly as before. Buckets are capped: an
 *  X-Test-Size-B sweep could otherwise grow the cache without bound. */
const MAX_PAD_BUCKETS = 64;

function padFiller(targetBytes: number, rand: () => number): string {
  const needed = Math.max(1, targetBytes);
  const bucket = Math.round(needed / PAD_RESOLUTION) * PAD_RESOLUTION;
  let pool = padPools.get(bucket);
  if (!pool) {
    if (padPools.size >= MAX_PAD_BUCKETS) {
      return LOREM.repeat(Math.ceil(needed / LOREM.length)).slice(0, needed);
    }
    padPools.set(bucket, (pool = []));
  }
  for (let tries = 0; tries < pool.length; tries++) {
    const i = Math.floor(rand() * pool.length);
    const pad = pool[i] as string;
    if (pad.length >= needed) return pad.slice(0, needed);
  }
  // nothing long enough in the pool yet: build the exact string and add it
  const pad = LOREM.repeat(Math.ceil(needed / LOREM.length));
  if (pool.length < PAD_POOL) pool.push(pad);
  return pad.slice(0, needed);
}

/** Pad a JSON-serializable payload with filler so the serialized size reaches targetBytes. */
export function padPayload<T extends Record<string, unknown>>(payload: T, targetBytes: number, rand: () => number = Math.random): T & { _pad?: string } {
  const capped = Math.min(Math.max(0, Math.round(targetBytes) || 0), LIMITS.padBytes);
  const base = JSON.stringify(payload).length;
  if (capped <= base + 12) return payload;
  const needed = capped - base - 12;
  return { ...payload, _pad: padFiller(needed, rand) };
}
