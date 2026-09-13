import { LIMITS, PET_STATUSES } from "@apigw/shared";

/**
 * OpenAPI 3.0.3 description of the bundled Petstore SUT.
 *
 * This is the contract the load driver generates against: every request in the
 * `small-rest` / `big-*` / `slow-upstream` / `concurrency` classes is built to
 * satisfy it, so an API gateway with request/response validation switched on
 * should pass 100% of that traffic. The `invalid` class deliberately violates
 * it (see loadgen/scenarios.ts) so you can watch the gateway reject exactly
 * that slice and nothing else.
 *
 * Kept hand-written rather than generated so it stays readable in a gateway's
 * import UI, and asserted against the live routes in openapi.test.ts.
 */

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** Responses are optionally padded with a filler property to hit a target size.
 *  Declared explicitly so strict response validation does not trip on it. */
const PAD_PROP: Record<string, Json> = {
  _pad: { type: "string", description: "Synthetic filler used to reach a requested response size. Ignore." }
};

const PET: Json = {
  type: "object",
  required: ["id", "name", "status", "category", "tags", "photoUrls"],
  properties: {
    id: { type: "integer", format: "int64", minimum: 1 },
    name: { type: "string", minLength: 1, maxLength: 200 },
    status: { type: "string", enum: [...PET_STATUSES] },
    category: {
      type: "object",
      required: ["id", "name"],
      properties: {
        id: { type: "integer", format: "int32", minimum: 0 },
        name: { type: "string", maxLength: 100 }
      }
    },
    tags: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        required: ["id", "name"],
        properties: {
          id: { type: "integer", format: "int32", minimum: 0 },
          name: { type: "string", maxLength: 100 }
        }
      }
    },
    photoUrls: { type: "array", maxItems: 10, items: { type: "string" } },
    description: { type: "string", maxLength: 4000 },
    ...PAD_PROP
  }
};

const NEW_PET: Json = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    status: { type: "string", enum: [...PET_STATUSES] },
    category: {
      type: "object",
      required: ["id", "name"],
      properties: {
        id: { type: "integer", format: "int32", minimum: 0 },
        name: { type: "string", maxLength: 100 }
      }
    },
    tags: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        required: ["id", "name"],
        properties: {
          id: { type: "integer", format: "int32", minimum: 0 },
          name: { type: "string", maxLength: 100 }
        }
      }
    },
    photoUrls: { type: "array", maxItems: 10, items: { type: "string" } },
    description: { type: "string", maxLength: 4000 }
  }
};

const UPDATE_PET: Json = {
  type: "object",
  minProperties: 1,
  properties: {
    name: { type: "string", minLength: 1, maxLength: 200 },
    status: { type: "string", enum: [...PET_STATUSES] },
    description: { type: "string", maxLength: 4000 }
  }
};

const ORDER: Json = {
  type: "object",
  required: ["id", "petId", "quantity", "shipDate", "status", "complete"],
  properties: {
    id: { type: "integer", format: "int64", minimum: 1 },
    petId: { type: "integer", format: "int64", minimum: 1 },
    quantity: { type: "integer", format: "int32", minimum: 1, maximum: 100 },
    shipDate: { type: "string", format: "date-time" },
    status: { type: "string", enum: ["placed", "approved", "delivered"] },
    complete: { type: "boolean" },
    ...PAD_PROP
  }
};

const ERROR: Json = {
  type: "object",
  required: ["error"],
  properties: { error: { type: "string" }, ...PAD_PROP }
};

const TEST_HEADERS: Json[] = [
  {
    name: "X-Test-Delay-Ms",
    in: "header",
    required: false,
    description: `Force this call to take roughly N ms (clamped to ${LIMITS.delayMs}).`,
    schema: { type: "integer", minimum: 0, maximum: LIMITS.delayMs }
  },
  {
    name: "X-Test-Size-B",
    in: "header",
    required: false,
    description: `Pad the response to roughly N bytes (clamped to ${LIMITS.padBytes}).`,
    schema: { type: "integer", minimum: 0, maximum: LIMITS.padBytes }
  }
];

const jsonBody = (schema: Json, required = true): Json => ({
  required,
  content: { "application/json": { schema } }
});

const jsonResp = (description: string, schema: Json): Json => ({
  description,
  content: { "application/json": { schema } }
});

const ERR = (description: string): Json => jsonResp(description, { $ref: "#/components/schemas/Error" });

const PET_ID_PARAM: Json = {
  name: "petId",
  in: "path",
  required: true,
  schema: { type: "integer", format: "int64", minimum: 1 }
};

export interface OpenApiOptions {
  /** Server URL the spec should advertise — normally your gateway's base URL. */
  serverUrl?: string;
  /** Extra description shown at the top of the document. */
  note?: string;
}

export function buildOpenApiDocument(opts: OpenApiOptions = {}): Json {
  const serverUrl = opts.serverUrl ?? "http://127.0.0.1:8080";
  return {
    openapi: "3.0.3",
    info: {
      title: "apigw-tester Petstore SUT",
      version: "1.0.0",
      description:
        "Petstore system-under-test bundled with apigw-tester. Import this into your API gateway to enable request and response validation. All traffic the load driver generates conforms to this document, except the deliberately-invalid slice controlled by invalidRatioPct."
    },
    servers: [{ url: serverUrl, description: "Target base URL (point this at your gateway)" }],
    security: [{ basicAuth: [] }],
    tags: [
      { name: "pets", description: "Petstore CRUD" },
      { name: "store", description: "Orders" },
      { name: "stress", description: "Synthetic endpoints for gateway stress testing" },
      { name: "ops", description: "Liveness" }
    ],
    paths: {
      "/api/pets": {
        get: {
          tags: ["pets"],
          operationId: "listPets",
          summary: "List pets",
          parameters: [
            {
              name: "status",
              in: "query",
              required: false,
              schema: { type: "string", enum: [...PET_STATUSES] }
            },
            { name: "page", in: "query", required: false, schema: { type: "integer", minimum: 0, maximum: 1000000 } },
            { name: "size", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100 } },
            ...TEST_HEADERS
          ],
          responses: {
            "200": jsonResp("A page of pets", {
              type: "object",
              required: ["items", "total", "page", "size"],
              properties: {
                items: { type: "array", items: { $ref: "#/components/schemas/Pet" } },
                total: { type: "integer", minimum: 0 },
                page: { type: "integer", minimum: 0 },
                size: { type: "integer", minimum: 1, maximum: 100 },
                ...PAD_PROP
              }
            }),
            "400": ERR("Invalid query parameter"),
            "401": ERR("Missing or bad credentials")
          }
        },
        post: {
          tags: ["pets"],
          operationId: "createPet",
          summary: "Create a pet",
          parameters: TEST_HEADERS,
          requestBody: jsonBody({ $ref: "#/components/schemas/NewPet" }),
          responses: {
            "201": jsonResp("Created", { $ref: "#/components/schemas/Pet" }),
            "400": ERR("Invalid body"),
            "401": ERR("Missing or bad credentials")
          }
        }
      },
      "/api/pets/{petId}": {
        parameters: [PET_ID_PARAM],
        get: {
          tags: ["pets"],
          operationId: "getPetById",
          summary: "Fetch one pet",
          parameters: TEST_HEADERS,
          responses: {
            "200": jsonResp("The pet", { $ref: "#/components/schemas/Pet" }),
            "400": ERR("Invalid petId"),
            "404": ERR("Not found")
          }
        },
        put: {
          tags: ["pets"],
          operationId: "updatePet",
          summary: "Update a pet",
          parameters: TEST_HEADERS,
          requestBody: jsonBody({ $ref: "#/components/schemas/UpdatePet" }),
          responses: {
            "200": jsonResp("Updated", { $ref: "#/components/schemas/Pet" }),
            "400": ERR("Invalid body or petId"),
            "404": ERR("Not found")
          }
        },
        delete: {
          tags: ["pets"],
          operationId: "deletePet",
          summary: "Delete a pet",
          parameters: TEST_HEADERS,
          responses: {
            "200": jsonResp("Deleted", {
              type: "object",
              required: ["deleted", "id"],
              properties: {
                deleted: { type: "boolean" },
                id: { type: "integer", format: "int64", minimum: 1 },
                ...PAD_PROP
              }
            }),
            "400": ERR("Invalid petId"),
            "404": ERR("Not found")
          }
        }
      },
      "/api/pets/{petId}/photo": {
        parameters: [PET_ID_PARAM],
        get: {
          tags: ["pets"],
          operationId: "getPetPhoto",
          summary: "Fetch a pet photo blob",
          parameters: TEST_HEADERS,
          responses: {
            "200": {
              description: "Opaque binary payload",
              content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } }
            },
            "400": ERR("Invalid petId"),
            "404": ERR("Not found")
          }
        }
      },
      "/api/store/order": {
        post: {
          tags: ["store"],
          operationId: "placeOrder",
          summary: "Place an order",
          parameters: TEST_HEADERS,
          requestBody: jsonBody({
            type: "object",
            required: ["petId"],
            properties: {
              petId: { type: "integer", format: "int64", minimum: 1 },
              quantity: { type: "integer", format: "int32", minimum: 1, maximum: 100 }
            }
          }),
          responses: {
            "201": jsonResp("Created", { $ref: "#/components/schemas/Order" }),
            "400": ERR("Invalid body")
          }
        }
      },
      "/api/store/order/{orderId}": {
        parameters: [
          { name: "orderId", in: "path", required: true, schema: { type: "integer", format: "int64", minimum: 1 } }
        ],
        get: {
          tags: ["store"],
          operationId: "getOrder",
          summary: "Fetch an order",
          parameters: TEST_HEADERS,
          responses: {
            "200": jsonResp("The order", { $ref: "#/components/schemas/Order" }),
            "400": ERR("Invalid orderId"),
            "404": ERR("Not found")
          }
        }
      },
      "/api/big/{size}": {
        get: {
          tags: ["stress"],
          operationId: "bigResponse",
          summary: "Return a body of exactly N bytes (gateway buffering stress)",
          parameters: [
            {
              name: "size",
              in: "path",
              required: true,
              schema: { type: "integer", minimum: 0, maximum: LIMITS.bigBytes }
            }
          ],
          responses: {
            "200": {
              description: "N bytes of filler",
              content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } }
            },
            "400": ERR("Invalid size")
          }
        }
      },
      "/api/slow/{ms}": {
        get: {
          tags: ["stress"],
          operationId: "slowUpstream",
          summary: "Sleep N ms before responding (gateway timeout stress)",
          parameters: [
            { name: "ms", in: "path", required: true, schema: { type: "integer", minimum: 0, maximum: LIMITS.slowMs } }
          ],
          responses: {
            "200": jsonResp("Responded after sleeping", {
              type: "object",
              required: ["sleptMs", "ts"],
              properties: {
                sleptMs: { type: "integer", minimum: 0 },
                ts: { type: "integer", format: "int64" },
                ...PAD_PROP
              }
            }),
            "400": ERR("Invalid ms")
          }
        }
      },
      "/api/echo": {
        post: {
          tags: ["stress"],
          operationId: "echo",
          summary: "Report the received body size (gateway large-request stress)",
          requestBody: jsonBody({
            type: "object",
            required: ["_pad"],
            properties: { _pad: { type: "string" } }
          }),
          responses: {
            "200": jsonResp("Byte count of the received body", {
              type: "object",
              required: ["receivedBytes", "ts"],
              properties: {
                receivedBytes: { type: "integer", minimum: 0 },
                ts: { type: "integer", format: "int64" }
              }
            }),
            "400": ERR("Invalid body")
          }
        }
      },
      "/health": {
        get: {
          tags: ["ops"],
          operationId: "health",
          summary: "Liveness probe (no authentication)",
          security: [],
          responses: {
            // version/uptimeSec are declared explicitly so a gateway running strict
            // response validation does not flag them as undocumented properties
            "200": jsonResp("Alive", {
              type: "object",
              required: ["status"],
              properties: {
                status: { type: "string", enum: ["ok"] },
                version: { type: "string" },
                uptimeSec: { type: "integer", format: "int64", minimum: 0 }
              }
            })
          }
        }
      }
    },
    components: {
      securitySchemes: {
        basicAuth: { type: "http", scheme: "basic" }
      },
      schemas: {
        Pet: PET,
        NewPet: NEW_PET,
        UpdatePet: UPDATE_PET,
        Order: ORDER,
        Error: ERROR
      }
    }
  };
}

// ---------- YAML emitter ----------
// Small, deterministic serializer for the JSON subset above. Every scalar is
// emitted quoted or as a bare number/bool, so no value can be misread as a YAML
// tag, and no description is allowed to contain a newline.

function yamlScalar(v: string | number | boolean | null): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  // single-quoted YAML: the only escape is a doubled quote
  return `'${v.replace(/'/g, "''")}'`;
}

function isScalar(v: Json): v is string | number | boolean | null {
  return v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function emit(v: Json, indent: number): string[] {
  const pad = "  ".repeat(indent);
  if (isScalar(v)) return [pad + yamlScalar(v)];

  if (Array.isArray(v)) {
    if (v.length === 0) return [pad + "[]"];
    const out: string[] = [];
    for (const item of v) {
      if (isScalar(item)) {
        out.push(`${pad}- ${yamlScalar(item)}`);
      } else {
        const lines = emit(item, indent + 1);
        // hoist the first line onto the dash
        out.push(`${pad}- ${lines[0]!.trimStart()}`);
        out.push(...lines.slice(1));
      }
    }
    return out;
  }

  const keys = Object.keys(v);
  if (keys.length === 0) return [pad + "{}"];
  const out: string[] = [];
  for (const k of keys) {
    const val = v[k] as Json;
    const key = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(k) ? k : `'${k.replace(/'/g, "''")}'`;
    if (isScalar(val)) {
      out.push(`${pad}${key}: ${yamlScalar(val)}`);
    } else if (Array.isArray(val) && val.length === 0) {
      out.push(`${pad}${key}: []`);
    } else if (!Array.isArray(val) && Object.keys(val).length === 0) {
      out.push(`${pad}${key}: {}`);
    } else {
      out.push(`${pad}${key}:`);
      out.push(...emit(val, indent + 1));
    }
  }
  return out;
}

export function toYaml(doc: Json): string {
  return emit(doc, 0).join("\n") + "\n";
}
