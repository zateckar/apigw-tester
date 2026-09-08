import { defineConfig } from "vitest/config";
import { builtinModules } from "node:module";

const builtins = new Set([
  "node:sqlite", "node:module", "sqlite",
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`)
]);

export default defineConfig({
  test: {
    server: {
      deps: {
        external: [...builtins]
      }
    }
  }
});
