import { defineConfig } from "vitest/config";
import { builtinModules } from "node:module";

const builtins = new Set([
  "node:sqlite", "node:module", "sqlite",
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`)
]);

export default defineConfig({
  resolve: {
    alias: [
      // vitest resolves against the real FS, which on CI doesn't have
      // app/node_modules/@apigw/shared/dist built yet — aim it at source instead
      { find: "@apigw/shared", replacement: `${__dirname}/../shared/src/index.ts` }
    ]
  },
  test: {
    server: {
      deps: {
        external: [...builtins]
      }
    }
  }
});
