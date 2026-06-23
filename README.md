# StateReplay

> Durable checkpointing for multi-step workflows. Crash on step three, restart, and carry on from step three.

[![npm version](https://img.shields.io/npm/v/statereplay.svg)](https://www.npmjs.com/package/statereplay)
[![CI](https://github.com/frammawiliansyah/statereplay/actions/workflows/ci.yml/badge.svg)](https://github.com/frammawiliansyah/statereplay/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/statereplay.svg)](./LICENSE)
[![provenance](https://img.shields.io/badge/npm-provenance-blue)](https://docs.npmjs.com/generating-provenance-statements)

StateReplay writes every state transition of a workflow to an append-only log, flushes it to disk, and reads it back on startup. So when a process dies partway through a job, the next run already knows what was done and picks up from there instead of starting over.

## Why it exists

Say you have a job that runs a few steps in order: withdraw from an exchange, wait for confirmations, deposit somewhere else. The process crashes between step two and step three. It restarts with no memory of what it already did, runs from the top, and withdraws a second time. When money is involved, that's the difference between a quiet retry and an incident report.

The obvious fix is "write your progress to a file as you go," and that mostly works until you hit the detail that trips everyone up: writing to a file doesn't mean it's on disk. A normal write lands in the OS page cache, and if the machine loses power before the kernel gets around to flushing it, the write is simply gone. Flushing your own buffer isn't the same as durability.

That's the gap StateReplay fills. Each transition is appended as a single line of JSON and `fsync`'d before `setState` resolves, so by the time your code moves on to the dangerous part, the record is genuinely on disk. On the next boot it replays the log into an in-memory map, and your workflow knows precisely where it stopped.

A few things worth knowing up front:

- **Durable by default.** `setState` resolves only after the bytes are flushed with `fsync` (`fdatasync`). You can dial this down when you don't need it.
- **One writer at a time.** An advisory lock stops two processes from scribbling over the same log and double-running your steps.
- **No runtime dependencies.** Just Node's standard library. Ships ESM and CommonJS, needs Node 18 or newer.

## Install

```bash
npm install statereplay
```

## Getting started

```ts
import { createStateReplay } from "statereplay";

const replay = await createStateReplay({ storagePath: "./.statereplay" });

const id = "transfer-001";

// If last run crashed, its state is already back in memory at this point.
if (replay.getState(id)?.status === "SUCCESS") {
  console.log("Already done, nothing to do.");
} else {
  // Record the intent *before* doing the risky thing.
  await replay.setState(id, { step: "CEX_WITHDRAWAL", status: "PROCESSING" });
  const txHash = await withdraw();
  await replay.setState(id, { step: "CEX_WITHDRAWAL", status: "SUCCESS", data: { txHash } });
}

await replay.close();
```

The one habit that makes all of this work: write `PROCESSING` before a risky side effect and `SUCCESS` (or `FAILED`) after it. Do that and a crash always leaves a durable record of what was attempted. On restart you'll see the lingering `PROCESSING` and re-run that step, which is why the step itself needs to be idempotent or guarded. The whole point is that nothing gets silently skipped.

## Durability and locking

Both are on out of the box. You can tune them per workload:

```ts
await createStateReplay({
  storagePath: "./.statereplay",
  durability: "fsync", // "fsync" (default) | "flush" | "none"
  lock: true,          // advisory single-writer lock
  lockStaleMs: 10_000, // how long before an unreadable leftover lock is considered abandoned
});
```

The three durability levels trade safety for speed:

- `"fsync"` waits for `fdatasync` before resolving. If several `setState` calls happen in the same tick, they get batched into one write and one sync (group commit), so you keep the per-call guarantee without paying for a separate flush every time.
- `"flush"` resolves once the write reaches the OS page cache. Quicker, but a power cut can still lose it.
- `"none"` resolves immediately. Fastest, and makes no promises. Fine for state you can afford to lose.

The lock is a small `.lock` file sitting next to your log. If another live process on the same host already holds it, `init` throws `StateReplayLockError` instead of letting two writers corrupt one log. If the previous holder crashed and left the lock behind, StateReplay checks whether that PID is still alive and, if it isn't, quietly takes over.

## When to reach for it (and when not to)

It's a good fit for durable, single-host checkpointing at low-to-moderate throughput: payment and withdrawal pipelines, multi-step jobs, migrations, basically anywhere running a step twice is worse than running it once.

It's the wrong tool as a general-purpose database, for coordinating work across multiple machines (the lock is single-host, see [Limitations](#limitations)), or for firehose-rate event streams where an unbounded append log would just grow without end.

## API

| Method | Returns | Notes |
|--------|---------|-------|
| `createStateReplay(options)` | `Promise<StateReplay<TData>>` | How you'll normally start. Constructs and runs `init()` for you. |
| `setState(id, payload)` | `Promise<void>` | Resolves once the write meets your durability level. |
| `getState(id)` | `Readonly<StatePayload> \| undefined` | A frozen deep clone, so reading it can't mutate the cache. |
| `getAllStates()` | `ReadonlyMap<string, Readonly<StatePayload>>` | A snapshot of clones. |
| `listIds()` | `string[]` | The ids currently held in memory. |
| `getStats()` | `StateReplayStats` | `eventCount`, `idCount`, `logSizeBytes`, and friends. |
| `close()` | `Promise<void>` | Drains pending writes, closes the file handle, releases the lock. |

It's an `EventEmitter` too. You can listen for `ready`, `change` (`{ id, previous, current }`), `replayWarning` (`{ lineNumber, message, fatal }`), and `error`, all typed through the `StateReplay<TData>` generic.

A `StatePayload<TData>` is `{ step, status, data?, error?, timestamp? }`, where `status` is one of `"PENDING" | "PROCESSING" | "SUCCESS" | "FAILED" | "COMPLETED"`. The `data` field is yours, typed via `TData`; `timestamp` is filled in for you if you leave it out.

## Encryption

If the log is going to live somewhere you'd rather not keep plaintext, turn on per-line encryption:

```ts
const replay = await createStateReplay({
  storagePath: "./.statereplay",
  encrypt: true,
  secretKey: process.env.STATE_SECRET, // 32-byte Buffer, or a passphrase
});
```

Each line's payload is encrypted with AES-256-GCM. You can pass a raw 32-byte key or a passphrase; a passphrase is stretched with scrypt using a random salt that's generated once and stored in `meta.json`. The salt doesn't need to be secret, so the only thing you actually have to protect is `secretKey`. Switch encryption on without a key and `init` throws `StateReplayConfigError`; point it at an existing log with the wrong key and you get `StateReplayDecryptError`.

## Express dashboard

There's a small Express integration under `statereplay/express` for looking at live state. `express` is an optional peer dependency, imported for its types only, so this entry point adds nothing to your runtime if you skip it.

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
| GET | `/_statereplay/health` | `getStats()` plus `{ ok, ready }` |
| GET | `/_statereplay/states` | every id and its current state |
| GET | `/_statereplay/states/:id` | one state, or `404` |
| GET | `/_statereplay/dashboard` | a self-contained HTML page (auto-refreshes every 5s, filter by status) |

One caution: these endpoints hand out your workflow state, so keep them on dev/staging or put them behind auth. They never expose `secretKey`, the raw log, or the lock file, and the dashboard escapes every value before rendering it, but the state itself is yours to guard.

## A fuller example: cross-exchange transfer

```ts
const replay = await createStateReplay<{ txHash?: string }>({ storagePath: "./.statereplay" });

async function transfer(id: string) {
  const prior = replay.getState(id);
  if (prior?.status === "SUCCESS") return; // already withdrawn, don't do it twice

  await replay.setState(id, { step: "CEX_WITHDRAWAL", status: "PROCESSING" });
  const txHash = await cex.withdraw();                       // the dangerous part
  await replay.setState(id, { step: "CEX_WITHDRAWAL", status: "SUCCESS", data: { txHash } });

  await replay.setState(id, { step: "DEX_DEPOSIT", status: "PROCESSING" });
  await dex.deposit(txHash);
  await replay.setState(id, { step: "DEX_DEPOSIT", status: "COMPLETED" });
}
```

If the process dies after the withdrawal's `SUCCESS` line has been flushed, the next run replays that line, sees it succeeded, and resumes at the deposit. The withdrawal never happens twice.

## Limitations

No library is free, so here's what you're signing up for:

- **Single host.** The lock is built on an `O_EXCL` lockfile, which isn't reliable on NFS and similar network filesystems. This is not a distributed lock.
- **The log only grows.** It's append-only and replay is O(n) in the number of transitions. Compaction isn't built yet.
- **Recovery plays it safe.** If a crash truncates a `SUCCESS` line, replay falls back to the prior `PROCESSING`, so a guarded step runs again rather than getting skipped. That's intentional, but it does mean your steps need to be idempotent.
- **Windows hardening is thinner.** The POSIX permission bits StateReplay sets are a no-op on Windows, so file access falls back to filesystem ACLs.

## Contributing

```bash
npm ci
npm run typecheck && npm run lint && npm run test
```

If you want the reasoning behind the append-only log and the locking design, it's written up in [`docs/adr/`](./docs/adr).

## License

MIT. See [LICENSE](./LICENSE). © 2026 Framma Wiliansyah Akbar.
