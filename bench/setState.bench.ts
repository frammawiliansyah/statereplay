/**
 * StateReplay benchmarks — run via `npm run bench`.
 *
 * Suites:
 *   1. setState throughput + p50/p99 across none / flush / fsync / fsync+group-commit
 *   2. replay throughput (lines/s, MB/s)
 *   3. process memory delta per 10k ids (bytes/id estimate)
 *
 * Non-gating: numbers vary by machine and storage. This is a dev tool, so it
 * uses `console` freely (unlike the library, which never writes to stdout).
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bench, group, run } from "mitata";
import { createStateReplay } from "../src/index.js";

const SEED_LINES = 10_000;
const dirs: string[] = [];
const maybeGc = (globalThis as { gc?: () => void }).gc;

async function makeReplay(durability: "none" | "flush" | "fsync") {
  const dir = await mkdtemp(join(tmpdir(), "sr-bench-"));
  dirs.push(dir);
  return createStateReplay({ storagePath: dir, durability, lock: false });
}

let n = 0;
function payload() {
  return { step: "BENCH", status: "PROCESSING" as const, data: { i: n } };
}

const noneReplay = await makeReplay("none");
const flushReplay = await makeReplay("flush");
const fsyncReplay = await makeReplay("fsync");

group("setState throughput", () => {
  bench("none", async () => {
    n += 1;
    await noneReplay.setState(`id-${n}`, payload());
  });
  bench("flush", async () => {
    n += 1;
    await flushReplay.setState(`id-${n}`, payload());
  });
  bench("fsync (serial)", async () => {
    n += 1;
    await fsyncReplay.setState(`id-${n}`, payload());
  });
  bench("fsync + group-commit (x16 concurrent)", async () => {
    n += 16;
    const base = n;
    await Promise.all(
      Array.from({ length: 16 }, (_, k) => fsyncReplay.setState(`g-${base}-${k}`, payload())),
    );
  });
});

// Pre-populate a log, then benchmark a cold replay of it.
const replayDir = await mkdtemp(join(tmpdir(), "sr-bench-replay-"));
dirs.push(replayDir);
const seed = await createStateReplay({ storagePath: replayDir, durability: "none", lock: false });
for (let i = 0; i < SEED_LINES; i += 1) {
  await seed.setState(`seed-${i}`, payload());
}
await seed.close();
const seedBytes = (await stat(join(replayDir, "events.jsonl"))).size;

group(`replay (${SEED_LINES} lines, ${(seedBytes / 1e6).toFixed(1)} MB)`, () => {
  bench("createStateReplay → cold replay", async () => {
    const sr = await createStateReplay({ storagePath: replayDir, lock: false });
    await sr.close();
  });
});

await run();

// Suite 3: one-shot memory delta per 10k ids.
const memDir = await mkdtemp(join(tmpdir(), "sr-bench-mem-"));
dirs.push(memDir);
const memReplay = await createStateReplay({ storagePath: memDir, durability: "none", lock: false });
maybeGc?.();
const before = process.memoryUsage().heapUsed;
for (let i = 0; i < SEED_LINES; i += 1) {
  await memReplay.setState(`mem-${i}`, { step: "MEM", status: "PENDING", data: { i } });
}
maybeGc?.();
const delta = process.memoryUsage().heapUsed - before;
await memReplay.close();

const gcNote = maybeGc ? "" : " — run with `node --expose-gc` for a tighter estimate";
console.log(
  `\nmemory: ~${Math.round(delta / SEED_LINES)} bytes/id over ${SEED_LINES} ids (heapUsed Δ ${(delta / 1e6).toFixed(1)} MB)${gcNote}`,
);

await Promise.all([noneReplay.close(), flushReplay.close(), fsyncReplay.close()]);
await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
