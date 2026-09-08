import type { Order, Pet, PetStatus } from "@apigw/shared";

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

function pick<T>(arr: readonly T[], i: number): T {
  return arr[i % arr.length] as T;
}

export class PetStore {
  private pets = new Map<number, Pet>();
  private orders = new Map<number, Order>();
  private nextPetId: number;
  private nextOrderId = 1;

  constructor(seedCount = 120) {
    for (let i = 0; i < seedCount; i++) {
      const id = i + 1;
      this.pets.set(id, {
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

  list(status?: PetStatus, page = 0, size = 20): { items: Pet[]; total: number } {
    let all = [...this.pets.values()];
    if (status) all = all.filter((p) => p.status === status);
    const safeSize = Math.min(Math.max(size, 1), 100);
    const start = Math.max(0, page) * safeSize;
    return { items: all.slice(start, start + safeSize), total: all.length };
  }

  get(id: number): Pet | undefined {
    return this.pets.get(id);
  }

  create(input: Partial<Pet>): Pet {
    const pet: Pet = {
      id: this.nextPetId++,
      name: input.name ?? "Unnamed",
      status: (input.status as PetStatus) ?? "available",
      category: input.category ?? { id: 0, name: "Misc" },
      tags: input.tags ?? [],
      photoUrls: input.photoUrls ?? [],
      ...(input.description !== undefined ? { description: input.description } : {})
    };
    this.pets.set(pet.id, pet);
    return pet;
  }

  update(id: number, input: Partial<Pet>): Pet | undefined {
    const existing = this.pets.get(id);
    if (!existing) return undefined;
    const merged = { ...existing, ...input, id };
    this.pets.set(id, merged);
    return merged;
  }

  delete(id: number): boolean {
    return this.pets.delete(id);
  }

  randomId(rand: () => number): number {
    const keys = [...this.pets.keys()];
    if (keys.length === 0) return 1;
    return keys[Math.floor(rand() * keys.length)] as number;
  }

  placeOrder(input: Partial<Order>): Order {
    const order: Order = {
      id: this.nextOrderId++,
      petId: input.petId ?? this.randomId(Math.random),
      quantity: input.quantity ?? 1,
      shipDate: new Date(Date.now() + 86400_000).toISOString(),
      status: "placed",
      complete: false
    };
    this.orders.set(order.id, order);
    return order;
  }

  getOrder(id: number): Order | undefined {
    return this.orders.get(id);
  }

  count(): number {
    return this.pets.size;
  }
}

/** Pad a JSON-serializable payload with filler so the serialized size reaches targetBytes. */
export function padPayload<T extends Record<string, unknown>>(payload: T, targetBytes: number): T & { _pad?: string } {
  const base = JSON.stringify(payload).length;
  if (targetBytes <= base + 12) return payload;
  const needed = targetBytes - base - 12;
  let pad = "";
  while (pad.length < needed) pad += LOREM;
  return { ...payload, _pad: pad.slice(0, needed) };
}
