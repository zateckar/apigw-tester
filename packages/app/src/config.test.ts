import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { readConfig } from "./config.js";

const KEYS = [
  "PORT", "DB_PATH", "PUBLIC_DIR", "PETSTORE_SELF_URL", "SUT_BACKEND", "SUT_PORT",
  "GW_BASE_URL", "GW_API_KEY", "GW_API_KEY_HEADER", "GW_PATH_PREFIX",
  "GW_REST_BASE_URL", "GW_REST_API_KEY", "GW_REST_API_KEY_HEADER", "GW_REST_PATH_PREFIX",
  "GW_SOAP_BASE_URL", "GW_SOAP_API_KEY", "GW_SOAP_API_KEY_HEADER", "GW_SOAP_PATH_PREFIX"
] as const;

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
});

describe("readConfig", () => {
  it("defaults both gateway targets to this process so the rig works out of the box", () => {
    const cfg = readConfig();
    expect(cfg.port).toBe(8080);
    expect(cfg.defaultGateway.rest.baseUrl).toBe(cfg.selfUrl);
    expect(cfg.defaultGateway.soap.baseUrl).toBe(cfg.selfUrl);
    expect(cfg.defaultGateway.rest.apiKeyHeader).toBe("X-API-Key");
  });

  it("treats a blank env var as unset", () => {
    // regression: compose renders an unset `${GW_BASE_URL:-}` as "", which `??`
    // does not catch — the gateway target silently became the empty string
    for (const k of KEYS) process.env[k] = "";
    const cfg = readConfig();
    expect(cfg.port).toBe(8080);
    expect(cfg.dbPath).toBe("data/metrics.db");
    expect(cfg.publicDir.endsWith(join("packages", "app", "public"))).toBe(true);
    expect(cfg.defaultGateway.rest.baseUrl).toBe(cfg.selfUrl);
    expect(cfg.defaultGateway.soap.baseUrl).not.toBe("");
    expect(cfg.defaultGateway.rest.apiKeyHeader).toBe("X-API-Key");
  });

  it("treats a whitespace-only env var as unset, and trims a real one", () => {
    process.env["GW_BASE_URL"] = "   ";
    expect(readConfig().defaultGateway.rest.baseUrl).toBe(readConfig().selfUrl);

    process.env["GW_BASE_URL"] = "  https://gw.example.com  ";
    expect(readConfig().defaultGateway.rest.baseUrl).toBe("https://gw.example.com");
    expect(readConfig().defaultGateway.soap.baseUrl).toBe("https://gw.example.com");
  });

  it("honours legacy values that are actually set, on both protocols", () => {
    process.env["PORT"] = "9999";
    process.env["GW_BASE_URL"] = "https://gw.example.com";
    process.env["GW_API_KEY"] = "secret";
    process.env["GW_PATH_PREFIX"] = "/v2";
    const cfg = readConfig();
    // selfUrl follows the backend, not the dashboard: the petstore is its own
    // process on its own port, and the reference arm has to reach *it*
    expect(cfg.selfUrl).toBe("http://127.0.0.1:8081");
    expect(cfg.defaultGateway.rest).toMatchObject({
      baseUrl: "https://gw.example.com",
      apiKey: "secret",
      pathPrefix: "/v2"
    });
    expect(cfg.defaultGateway.soap).toMatchObject({
      baseUrl: "https://gw.example.com",
      apiKey: "secret",
      pathPrefix: "/v2"
    });
  });

  it("defaults the SUT to its own process on its own port", () => {
    const cfg = readConfig();
    expect(cfg.sutBackend).toBe("go");
    expect(cfg.sutPort).toBe(8081);
    // the whole point of the split: the backend the load terminates at is not
    // the process recording the measurements
    expect(cfg.selfUrl).toBe("http://127.0.0.1:8081");
    expect(cfg.selfUrl).not.toBe(`http://127.0.0.1:${cfg.port}`);
  });

  it("puts the petstore back in this process when SUT_BACKEND=ts", () => {
    process.env["SUT_BACKEND"] = "ts";
    process.env["PORT"] = "9100";
    const cfg = readConfig();
    expect(cfg.sutBackend).toBe("ts");
    expect(cfg.selfUrl).toBe("http://127.0.0.1:9100");
  });

  it("only accepts 'ts' as an opt-out, so a typo does not silently disable the split", () => {
    for (const raw of ["typescript", "TS", "go", "", "yes"]) {
      process.env["SUT_BACKEND"] = raw;
      expect(readConfig().sutBackend, raw).toBe("go");
    }
  });

  it("honours SUT_PORT, including 0 for an ephemeral one", () => {
    process.env["SUT_PORT"] = "9200";
    expect(readConfig().sutPort).toBe(9200);
    expect(readConfig().selfUrl).toBe("http://127.0.0.1:9200");

    // 0 means "ask the OS"; buildApp rewrites the URL once the child reports
    process.env["SUT_PORT"] = "0";
    expect(readConfig().sutPort).toBe(0);

    for (const bad of ["-1", "70000", "eight-thousand"]) {
      process.env["SUT_PORT"] = bad;
      expect(readConfig().sutPort, bad).toBe(8081);
    }
  });

  it("lets an explicit PETSTORE_SELF_URL win over the split-out default", () => {
    // this is the hook for pointing the rig at a real backend; if it stopped
    // working, the Δ would compare two different backends and call the
    // difference the gateway's cost
    process.env["PETSTORE_SELF_URL"] = "https://backend.example.com/";
    const cfg = readConfig();
    expect(cfg.selfUrl).toBe("https://backend.example.com");
    expect(cfg.defaultGateway.rest.baseUrl).toBe("https://backend.example.com");
  });

  it("lets protocol-specific variables override the legacy ones independently", () => {
    process.env["GW_BASE_URL"] = "https://gw.example.com";
    process.env["GW_API_KEY"] = "shared";
    process.env["GW_REST_BASE_URL"] = "https://rest.gw.example.com";
    process.env["GW_SOAP_BASE_URL"] = "https://soap.gw.example.com";
    process.env["GW_SOAP_API_KEY"] = "soap-secret";
    const cfg = readConfig();
    expect(cfg.defaultGateway.rest).toMatchObject({ baseUrl: "https://rest.gw.example.com", apiKey: "shared" });
    expect(cfg.defaultGateway.soap).toMatchObject({ baseUrl: "https://soap.gw.example.com", apiKey: "soap-secret" });
  });

  it("falls back to 8080 for a nonsense PORT rather than binding to NaN", () => {
    process.env["PORT"] = "not-a-port";
    expect(readConfig().port).toBe(8080);
    process.env["PORT"] = "-1";
    expect(readConfig().port).toBe(8080);
  });
});
