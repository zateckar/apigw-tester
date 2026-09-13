import { startServer } from "./app.js";

const { server, store, driver } = startServer();

process.on("uncaughtException", (e) => {
  console.error("[apigw-tester] uncaught", e);
});
process.on("unhandledRejection", (e) => {
  console.error("[apigw-tester] unhandled rejection", e);
});

let shuttingDown = false;

async function shutdown(sig: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[apigw-tester] ${sig} received, draining`);

  // hard deadline: docker's default stop grace is 10s
  const forceExit = setTimeout(() => {
    console.error("[apigw-tester] drain timed out, exiting");
    process.exit(1);
  }, 8_000);
  forceExit.unref();

  try {
    // stop generating load first, then flush what we already measured, then
    // checkpoint and close the database — otherwise the last few seconds of
    // metrics are lost and the WAL is left un-checkpointed on every restart
    driver.stop();
    await driver.shutdown();
    store.close();
  } catch (e) {
    console.error("[apigw-tester] error while draining:", e);
  }

  server.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void shutdown(sig));
}
