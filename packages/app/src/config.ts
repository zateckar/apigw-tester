import type { GwConfig, LoadProfile } from "@apigw/shared";

// Shared port + url resolution for the in-process modules.
export const PORT = Number(process.env["PORT"] ?? 8080);

export interface AppConfig {
  port: number;
  dbPath: string;
  publicDir: string;
  defaultGateway: GwConfig;
  defaultProfile: LoadProfile;
}

export function readConfig(): AppConfig {
  return {
    port: PORT,
    dbPath: process.env["DB_PATH"] ?? "data/metrics.db",
    publicDir: process.env["PUBLIC_DIR"] ?? "dist/public",
    defaultGateway: {
      baseUrl: process.env["PETSTORE_SELF_URL"] ?? "http://127.0.0.1:8080",
      apiKey: "",
      apiKeyHeader: "X-API-Key",
      pathPrefix: ""
    },
    defaultProfile: {
      mode: "constant",
      rps: 10,
      maxConcurrency: 25,
      soapRatioPct: 25,
      scenarioWeights: {
        listPets: 50, getPet: 20, createPet: 10, updatePet: 5, deletePet: 5, placeOrder: 10
      }
    }
  };
}
