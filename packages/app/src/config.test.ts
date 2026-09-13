import { afterEach, describe, expect, it } from "vitest";
import { readConfig } from "./config.js";

const KEYS = [
  "PORT", "DB_PATH", "PUBLIC_DIR", "PETSTORE_SELF_URL",
  "GW_BASE_URL", "GW_API_KEY", "GW_API_KEY_HEADER", "GW_PATH_PREFIX"
] as const;

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe("readConfig", () => {
  it("defaults the gateway to this process so the rig works out of the box", () => {
    const cfg = readConfig();
    expect(cfg.port).toBe(8080);
    expect(cfg.defaultGateway.baseUrl).toBe(cfg.selfUrl);
    expect(cfg.defaultGateway.apiKeyHeader).toBe("X-API-Key");
  });

  it("treats a blank env var as unset", () => {
    // regression: compose renders an unset `${GW_BASE_URL:-}` as "", which `??`
    // does not catch — the gateway target silently became the empty string
    for (const k of KEYS) process.env[k] = "";
    const cfg = readConfig();
    expect(cfg.port).toBe(8080);
    expect(cfg.dbPath).toBe("data/metrics.db");
    expect(cfg.publicDir).toBe("dist/public");
    expect(cfg.defaultGateway.baseUrl).toBe(cfg.selfUrl);
    expect(cfg.defaultGateway.baseUrl).not.toBe("");
    expect(cfg.defaultGateway.apiKeyHeader).toBe("X-API-Key");
  });

  it("treats a whitespace-only env var as unset, and trims a real one", () => {
    process.env["GW_BASE_URL"] = "   ";
    expect(readConfig().defaultGateway.baseUrl).toBe(readConfig().selfUrl);

    process.env["GW_BASE_URL"] = "  https://gw.example.com  ";
    expect(readConfig().defaultGateway.baseUrl).toBe("https://gw.example.com");
  });

  it("honours values that are actually set", () => {
    process.env["PORT"] = "9999";
    process.env["GW_BASE_URL"] = "https://gw.example.com";
    process.env["GW_API_KEY"] = "secret";
    process.env["GW_PATH_PREFIX"] = "/v2";
    const cfg = readConfig();
    expect(cfg.selfUrl).toBe("http://127.0.0.1:9999");
    expect(cfg.defaultGateway).toMatchObject({
      baseUrl: "https://gw.example.com",
      apiKey: "secret",
      pathPrefix: "/v2"
    });
  });

  it("falls back to 8080 for a nonsense PORT rather than binding to NaN", () => {
    process.env["PORT"] = "not-a-port";
    expect(readConfig().port).toBe(8080);
    process.env["PORT"] = "-1";
    expect(readConfig().port).toBe(8080);
  });
});
