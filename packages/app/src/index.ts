import { startServer } from "./app.js";

const server = startServer();

process.on("uncaughtException", (e) => {
  console.error("[apigw-tester] uncaught", e);
});
process.on("unhandledRejection", (e) => {
  console.error("[apigw-tester] unhandled rejection", e);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[apigw-tester] ${sig} received, draining`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 8_000).unref();
  });
}
