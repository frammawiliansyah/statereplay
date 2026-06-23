# StateReplay

> Persist workflow state to a durable, append-only log and replay from the last step after a crash or restart.

[![npm version](https://img.shields.io/npm/v/statereplay.svg)](https://www.npmjs.com/package/statereplay)
[![CI](https://github.com/frammawiliansyah/statereplay/actions/workflows/ci.yml/badge.svg)](https://github.com/frammawiliansyah/statereplay/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/statereplay.svg)](./LICENSE)
[![provenance](https://img.shields.io/badge/npm-provenance-blue)](https://docs.npmjs.com/generating-provenance-statements)

## The problem

A multi-step process crashes halfway through. On restart it has no memory of what it already did, so it starts from zero — and re-runs steps that must never run twice (the headline case: a **double crypto withdrawal**).

Worse, "I wrote it to a file" is not the same as "it's on disk." A normal write lands in the OS page cache; a crash before the kernel flushes loses it. **Flushed ≠ durable.**

## The solution

StateReplay writes every state transition to a **durable, append-only JSONL log** and **replays** it on startup to rebuild in-memory state — so a crashed process resumes exactly where it left off.

```
setState(id, PROCESSING) ──► fsync ──► [events.jsonl]  ◄── replay on restart ──► in-memory Map
        │                                    │
   (durable before the side-effect)     append-only, one line per transition
```

- **Durable by default** — `fsync` (fdatasync) per write; `setState` resolves only once the bytes are on disk.
- **Single-writer safe** — an advisory lock prevents two processes from corrupting one log (and double-executing).
- **Zero runtime dependencies** — just Node's standard library. Dual ESM + CJS, Node ≥ 18.

## Install

```bash
npm install statereplay
```

## Quick start

```ts
import { createStateReplay } from "statereplay";

const replay = await createStateReplay({ storagePath: "./.statereplay" });

const id = "transfer-001";

// If we crashed last run, the prior state is already replayed into memory.
if (replay.getState(id)?.status === "SUCCESS") {
  console.log("Already done — skip.");
} else {
  await replay.setState(id, { step: "CEX_WITHDRAWAL", status: "PROCESSING" }); // durable BEFORE the side-effect
  const txHash = await withdraw();
  await replay.setState(id, { step: "CEX_WITHDRAWAL", status: "SUCCESS", data: { txHash } });
}

await replay.close();
```

> **Golden rule:** write `PROCESSING` **before** a dangerous side-effect and `SUCCESS`/`FAILED` **after** it. A crash then always leaves a durable record of what was attempted, and your (idempotent/guarded) step is re-tried — never silently skipped.

## Durability & locking

Both are on by default; tune them per workload:

```ts
await createStateReplay({
  storagePath: "./.statereplay",
  durability: "fsync", // "fsync" (default, durable) | "flush" (OS cache) | "none" (fastest, weakest)
  lock: true,          // advisory single-writer lock (default)
  lockStaleMs: 10_000, // a dead-PID same-host lock is stolen; an unreadable one only once this old
});
```

- `durability: "fsync"` — `setState` resolves after `fdatasync`. Concurrent writes are **group-committed** (one `write` + one `fsync` per batch) to recover throughput without weakening the per-call guarantee.
- `durability: "flush"` — resolves once the write reaches the OS page cache (not crash-proof).
- `durability: "none"` — resolves immediately (fastest; for non-critical state).
- The lock is a `meta`-adjacent `*.lock` file. A second live process throws `StateReplayLockError`; a stale same-host lock (dead PID) is stolen automatically.

## When to use it / when not to

**Use it** for durable, single-host, low-to-moderate-throughput workflow checkpointing: payment/withdrawal pipelines, multi-step jobs, migrations, anything where re-running a step is dangerous.

**Don't use it** as a general-purpose database, for multi-host/distributed coordination (the lock is single-host — see Limitations), or for very high-frequency event streams where an unbounded append log is impractical.

## API

| Method | Returns | Notes |
|--------|---------|-------|
| `createStateReplay(options)` | `Promise<StateReplay<TData>>` | **Primary entry point** — constructs + `init()` |
| `setState(id, payload)` | `Promise<void>` | Resolves after the durability level is met |
| `getState(id)` | `Readonly<StatePayload> \| undefined` | A **frozen deep clone** — safe to read |
| `getAllStates()` | `ReadonlyMap<string, Readonly<StatePayload>>` | Snapshot of clones |
| `listIds()` | `string[]` | Ids currently in the cache |
| `getStats()` | `StateReplayStats` | `eventCount`, `idCount`, `logSizeBytes`, … |
| `close()` | `Promise<void>` | Flush, close handle, release lock |

Events: `ready`, `change` (`{ id, previous, current }`), `replayWarning` (`{ lineNumber, message, fatal }`), `error`. All typed via the generic `StateReplay<TData>`.

A `StatePayload<TData>` is `{ step: string; status: StateStatus; data?: TData; error?: string; timestamp?: number }`, where `StateStatus` is `"PENDING" | "PROCESSING" | "SUCCESS" | "FAILED" | "COMPLETED"`.

## Encryption

Encrypt each line's payload at rest with AES-256-GCM:

```ts
const replay = await createStateReplay({
  storagePath: "./.statereplay",
  encrypt: true,
  secretKey: process.env.STATE_SECRET, // 32-byte Buffer, or a passphrase (scrypt-derived)
});
```

The key is derived with scrypt using a random per-deployment salt stored in `meta.json` (the salt is not secret; secrecy lives entirely in `secretKey`). `encrypt: true` without a `secretKey` throws `StateReplayConfigError` at init. A wrong key surfaces as `StateReplayDecryptError`.

## Express middleware

A `statereplay/express` integration exposes read-only observability endpoints and an inlined dashboard. `express` is an **optional peer dependency** (imported for types only — zero runtime cost if you don't use it).

```ts
import express from "express";
import { createStateReplay } from "statereplay";
import { createStateReplayMiddleware } from "statereplay/express";

const replay = await createStateReplay({ storagePath: "./.statereplay" });
const app = express();
app.use(createStateReplayMiddleware(replay, { basePath: "/_statereplay", enableDashboard: true }));
```

| Method | Path | Response |
|--------|------|----------|
| GET | `/_statereplay/health` | `getStats()` + `{ ok, ready }` |
| GET | `/_statereplay/states` | `{ states: Record<id, StatePayload> }` |
| GET | `/_statereplay/states/:id` | `{ id, state }` or `404` |
| GET | `/_statereplay/dashboard` | inlined HTML (5s auto-refresh, status filter) |

> ⚠️ **Development/staging only**, or place it behind authentication — these endpoints expose your workflow state. They never expose the `secretKey`, the raw log file, or the lock file, and the dashboard HTML-escapes every value it renders.

## Real-world example: cross-exchange transfer

```ts
const replay = await createStateReplay<{ txHash?: string }>({ storagePath: "./.statereplay" });

async function transfer(id: string) {
  const prior = replay.getState(id);
  if (prior?.status === "SUCCESS") return; // already withdrawn — never do it twice

  await replay.setState(id, { step: "CEX_WITHDRAWAL", status: "PROCESSING" });
  const txHash = await cex.withdraw();                       // the dangerous side-effect
  await replay.setState(id, { step: "CEX_WITHDRAWAL", status: "SUCCESS", data: { txHash } });

  await replay.setState(id, { step: "DEX_DEPOSIT", status: "PROCESSING" });
  await dex.deposit(txHash);
  await replay.setState(id, { step: "DEX_DEPOSIT", status: "COMPLETED" });
}
```

If the process dies after the CEX withdrawal's `SUCCESS` line is fsync'd, the restart replays that line, sees `SUCCESS`, and resumes at the DEX deposit — the withdrawal is never repeated.

## Limitations

- **Single host.** The advisory lock uses an `O_EXCL` lockfile, which is unreliable on **NFS / network filesystems**. StateReplay is not a distributed lock.
- **The log grows.** It is append-only; replay is O(n) in the number of transitions. Compaction is a future concern.
- **Conservative recovery.** A crash that truncates a `SUCCESS` line replays to the prior `PROCESSING`, so a guarded step is re-run rather than skipped — by design. Make your steps idempotent.
- **Windows hardening degrades.** POSIX `chmod` mode bits are a no-op on Windows; file permissions fall back to filesystem ACLs.

## Contributing

```bash
npm ci
npm run typecheck && npm run lint && npm run test
```

See [`docs/adr/`](./docs/adr) for architecture decisions.

## License

[MIT](./LICENSE) © AppSuite Labs
