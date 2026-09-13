import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // compile the shared package from source so the UI build does not depend
      // on packages/shared having been built first
      "@apigw/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url))
    }
  },
  server: {
    port: 5173,
    proxy: {
      // the app serves API, petstore and dashboard from one port
      "/api": { target: process.env["APP_URL"] ?? "http://localhost:8080", changeOrigin: true },
      "/soap": { target: process.env["APP_URL"] ?? "http://localhost:8080", changeOrigin: true }
    }
  },
  build: {
    outDir: "dist",
    sourcemap: true
  }
});
