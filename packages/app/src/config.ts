import type { GwConfig, LoadProfile } from "@apigw/shared";
import { DEFAULT_LOAD_PROFILE } from "@apigw/shared";

/**
 * Read an environment variable, treating blank as unset.
 *
 * Compose and most orchestrators materialize an unset `${FOO:-}` as the empty
 * string rather than omitting it, and `?? default` does not catch "". Without
 * this, declaring GW_BASE_URL in compose without a value silently blanked the
 * gateway target instead of falling back to the built-in petstore.
 */
function env(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

const DEFAULT_PORT = 8080;

export interface AppConfig {
  port: number;
  dbPath: string;
  publicDir: string;
  /** This process's own base URL — used for direct-to-SUT baseline probes. */
  selfUrl: string;
  defaultGateway: GwConfig;
  defaultProfile: LoadProfile;
}

export function readConfig(): AppConfig {
  // read fresh rather than freezing at import time, so a config read after the
  // environment is set up (tests, embedders) sees the real value
  const raw = Number(env("PORT") ?? DEFAULT_PORT);
  const port = Number.isInteger(raw) && raw > 0 && raw <= 65535 ? raw : DEFAULT_PORT;
  const selfUrl = (env("PETSTORE_SELF_URL") ?? `http://127.0.0.1:${port}`).replace(/\/+$/, "");
  return {
    port,
    dbPath: env("DB_PATH") ?? "data/metrics.db",
    publicDir: env("PUBLIC_DIR") ?? "dist/public",
    selfUrl,
    defaultGateway: {
      // out of the box the "gateway" is this same process, so everything works
      // before you point it at a real one
      baseUrl: env("GW_BASE_URL") ?? selfUrl,
      apiKey: env("GW_API_KEY") ?? "",
      apiKeyHeader: env("GW_API_KEY_HEADER") ?? "X-API-Key",
      pathPrefix: env("GW_PATH_PREFIX") ?? ""
    },
    defaultProfile: { ...DEFAULT_LOAD_PROFILE }
  };
}
