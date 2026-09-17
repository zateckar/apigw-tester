import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
/** Where the split-out petstore listens. Its own port because it is its own
 *  process — see SutBackend. */
const DEFAULT_SUT_PORT = 8081;

/** packages/app — src/config.ts is always one level under it (no build step). */
const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Which build of the bundled petstore answers the generated load.
 *
 * - `go` — a separate OS process (packages/go/cmd/gwtester-sut) on its own
 *   port. The default, and the only arrangement in which the control plane's
 *   event loop is not a term in every measurement the control plane records.
 *   In-process, at 5k rps, the loop's max delay crossed the 10ms validity limit
 *   often enough to disqualify most health windows.
 * - `ts` — the original in-process route table on the app's own port. Kept as a
 *   fallback for when the binary is missing, and as the executable spec the Go
 *   port is checked against.
 *
 * Mirrors LOADGEN_BACKEND, including falling back to `ts` when the binary is
 * absent rather than refusing to start.
 */
export type SutBackend = "go" | "ts";

export interface AppConfig {
  port: number;
  dbPath: string;
  publicDir: string;
  sutBackend: SutBackend;
  /** Port for the go SUT. 0 asks the OS for a free one (tests). Ignored by `ts`. */
  sutPort: number;
  /**
   * Where the backend answers with no gateway in front of it. The reference
   * stream — the control arm of the added-TTFB measurement — is sent here.
   *
   * Defaults to this process, which is right for the out-of-the-box setup
   * where the gateway fronts the bundled petstore. Point PETSTORE_SELF_URL at
   * the real backend when the gateway fronts something else: the Δ compares
   * this against the gateway path, so if the two do not terminate at the same
   * backend it measures the difference between two backends and calls it the
   * gateway's cost.
   */
  selfUrl: string;
  defaultGateway: GwTargets;
  defaultProfile: LoadProfile;
}

export function readConfig(): AppConfig {
  // read fresh rather than freezing at import time, so a config read after the
  // environment is set up (tests, embedders) sees the real value
  const raw = Number(env("PORT") ?? DEFAULT_PORT);
  const port = Number.isInteger(raw) && raw > 0 && raw <= 65535 ? raw : DEFAULT_PORT;

  const sutBackend: SutBackend = env("SUT_BACKEND") === "ts" ? "ts" : "go";
  const rawSut = Number(env("SUT_PORT") ?? DEFAULT_SUT_PORT);
  const sutPort = Number.isInteger(rawSut) && rawSut >= 0 && rawSut <= 65535 ? rawSut : DEFAULT_SUT_PORT;

  // The backend answers on its own port when it is its own process. A caller
  // that pinned PETSTORE_SELF_URL still wins — that is the hook for pointing
  // the rig at a real backend instead of the bundled one.
  //
  // With SUT_PORT=0 this is a placeholder: the port is not known until the
  // child reports it, and buildApp rewrites selfUrl and the default gateway
  // target once it does.
  const defaultSelf = sutBackend === "go"
    ? `http://127.0.0.1:${sutPort}`
    : `http://127.0.0.1:${port}`;
  const selfUrl = (env("PETSTORE_SELF_URL") ?? defaultSelf).replace(/\/+$/, "");

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
    sutBackend,
    sutPort,
    dbPath: env("DB_PATH") ?? "data/metrics.db",
    // default is anchored at the package dir, not the caller's cwd: the image
    // bakes the UI at packages/app/public and runs from /app, dev runs from
    // the repo root — both resolve to the same absolute path this way
    publicDir: env("PUBLIC_DIR") ?? join(PKG_DIR, "public"),
    selfUrl,
    defaultGateway: {
      rest: side("REST"),
      soap: side("SOAP")
    },
    defaultProfile: { ...DEFAULT_LOAD_PROFILE }
  };
}
