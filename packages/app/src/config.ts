import type { ForwardBasicAuth, GwConfig, GwTargets, LoadProfile } from "@apigw/shared";
import { DEFAULT_LOAD_PROFILE, FORWARD_BASIC_AUTH_MODES } from "@apigw/shared";

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
  defaultGateway: GwTargets;
  defaultProfile: LoadProfile;
}

export function readConfig(): AppConfig {
  // read fresh rather than freezing at import time, so a config read after the
  // environment is set up (tests, embedders) sees the real value
  const raw = Number(env("PORT") ?? DEFAULT_PORT);
  const port = Number.isInteger(raw) && raw > 0 && raw <= 65535 ? raw : DEFAULT_PORT;
  const selfUrl = (env("PETSTORE_SELF_URL") ?? `http://127.0.0.1:${port}`).replace(/\/+$/, "");

  // REST and SOAP are fronted separately on a real gateway, each with its own
  // URL and API key. The legacy GW_* variables still apply to both sides; the
  // protocol-specific variables win when set.
  const legacy = {
    baseUrl: env("GW_BASE_URL"),
    apiKey: env("GW_API_KEY"),
    apiKeyHeader: env("GW_API_KEY_HEADER"),
    pathPrefix: env("GW_PATH_PREFIX"),
    forwardBasicAuth: env("GW_FORWARD_BASIC_AUTH")
  };
  const forward = (raw: string | undefined): ForwardBasicAuth =>
    FORWARD_BASIC_AUTH_MODES.includes(raw as ForwardBasicAuth) ? (raw as ForwardBasicAuth) : "auto";

  const side = (p: "REST" | "SOAP"): GwConfig => ({
    baseUrl: env(`GW_${p}_BASE_URL`) ?? legacy.baseUrl ?? selfUrl,
    apiKey: env(`GW_${p}_API_KEY`) ?? legacy.apiKey ?? "",
    apiKeyHeader: env(`GW_${p}_API_KEY_HEADER`) ?? legacy.apiKeyHeader ?? "X-API-Key",
    pathPrefix: env(`GW_${p}_PATH_PREFIX`) ?? legacy.pathPrefix ?? "",
    // "auto" — forward this rig's Basic credential only to our own origin.
    // Anything else must be opted into explicitly; see ForwardBasicAuth.
    forwardBasicAuth: forward(env(`GW_${p}_FORWARD_BASIC_AUTH`) ?? legacy.forwardBasicAuth)
  });

  return {
    port,
    dbPath: env("DB_PATH") ?? "data/metrics.db",
    publicDir: env("PUBLIC_DIR") ?? "dist/public",
    selfUrl,
    defaultGateway: {
      rest: side("REST"),
      soap: side("SOAP")
    },
    defaultProfile: { ...DEFAULT_LOAD_PROFILE }
  };
}
