/**
 * StateReplay — Express dashboard.
 *
 * Run:  npx tsx examples/express-dashboard.ts
 * Then open  http://localhost:3000/_statereplay/dashboard  (Ctrl+C to stop).
 *
 * Mounts the read-only middleware and seeds some state; a timer cycles a few
 * "live" jobs so you can watch the dashboard's 5s auto-refresh and status filter.
 *
 * ⚠️ Dev/staging only — the endpoints expose workflow state. Put them behind auth
 * in any shared environment.
 */
import express from "express";
import { createStateReplayMiddleware } from "../src/express/index.js";
import { createStateReplay } from "../src/index.js";

const PORT = Number(process.env.PORT ?? 3000);
const LIVE_STATUSES = ["PENDING", "PROCESSING", "SUCCESS", "COMPLETED"] as const;

async function main(): Promise<void> {
  const replay = await createStateReplay({ storagePath: "./.statereplay-dashboard", lock: false });

  // Seed a spread of statuses so the dashboard has something to show immediately.
  await replay.setState("transfer-001", {
    step: "CEX_WITHDRAWAL",
    status: "SUCCESS",
    data: { txHash: "0xabc123" },
  });
  await replay.setState("transfer-002", { step: "NETWORK_CONFIRMATION", status: "PROCESSING" });
  await replay.setState("transfer-003", {
    step: "DEX_EXECUTION",
    status: "FAILED",
    error: "slippage exceeded tolerance",
  });

  const app = express();
  app.use(
    createStateReplayMiddleware(replay, { basePath: "/_statereplay", enableDashboard: true }),
  );

  const server = app.listen(PORT, () => {
    console.log(`StateReplay dashboard → http://localhost:${PORT}/_statereplay/dashboard`);
    console.log(`health JSON           → http://localhost:${PORT}/_statereplay/health`);
    console.log("Press Ctrl+C to stop.");
  });

  // Cycle a handful of jobs so the auto-refresh is visibly live.
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    const status = LIVE_STATUSES[tick % LIVE_STATUSES.length] ?? "PENDING";
    void replay.setState(`live-job-${tick % 5}`, { step: "HEARTBEAT", status, data: { tick } });
  }, 2000);

  const shutdown = (): void => {
    clearInterval(timer);
    server.close(() => {
      void replay.close().then(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
