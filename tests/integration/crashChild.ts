// Child process for crash-simulation.test.ts (run via tsx).
// Durably writes one fsync'd state line, then hard-crashes (SIGKILL) with NO clean close()
// — leaving the lock unreleased and the handle open, exactly like a real process kill.
import { createStateReplay } from "../../src/core/StateReplay.js";

const dir = process.argv[2];
if (dir === undefined) {
  throw new Error("crashChild: missing storage directory argument");
}

const sr = await createStateReplay({ storagePath: dir, durability: "fsync", lock: false });
await sr.setState("transfer-001", {
  step: "CEX_WITHDRAWAL",
  status: "PROCESSING",
  data: { amount: 100 },
});
// The line is fsync'd to disk; simulate a crash before the next step runs.
process.kill(process.pid, "SIGKILL");
