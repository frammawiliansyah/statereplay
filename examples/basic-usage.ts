/**
 * StateReplay — basic usage.
 *
 * Run it twice to see crash-resume in action:
 *
 *   npx tsx examples/basic-usage.ts
 *
 * The golden rule: persist PROCESSING *before* a dangerous side-effect and
 * SUCCESS *after* it completes, so a crash always leaves a durable record of
 * what was attempted — and a guarded step is never silently re-run.
 */
import { createStateReplay } from "../src/index.js";

async function main(): Promise<void> {
  const replay = await createStateReplay<{ txHash: string }>({
    storagePath: "./.statereplay-example",
  });

  const id = "transfer-001";

  // On a fresh start the cache is empty; after a crash, the prior state is replayed.
  const existing = replay.getState(id);
  if (existing) {
    console.log(`Resuming ${id}: step=${existing.step} status=${existing.status}`);
    if (existing.status === "SUCCESS") {
      console.log("Already completed on a previous run — nothing to do.");
      await replay.close();
      return;
    }
  }

  // 1. Persist PROCESSING before the side-effect (durably fsync'd to disk by default).
  await replay.setState(id, { step: "CEX_WITHDRAWAL", status: "PROCESSING" });

  // 2. Perform the dangerous, non-idempotent side-effect.
  const txHash = await fakeWithdraw();

  // 3. Persist SUCCESS after it completes.
  await replay.setState(id, { step: "CEX_WITHDRAWAL", status: "SUCCESS", data: { txHash } });

  console.log("Final state:", replay.getState(id));
  console.log("Stats:", replay.getStats());

  await replay.close();
}

async function fakeWithdraw(): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  return "0xabc123";
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
