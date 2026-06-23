# statereplay

## 0.2.0

### Minor changes

- **Express integration** (`statereplay/express`) — `createStateReplayMiddleware(replay, { basePath, enableDashboard })` serves read-only `health` / `states` / `states/:id` endpoints plus an inlined, auto-refreshing dashboard. `express` is an optional peer dependency (types-only import; no runtime cost). Dev/staging only — see the README security note.
- **Benchmarks** (`bench/setState.bench.ts`, mitata) — `setState` throughput/p50/p99 across `none`/`flush`/`fsync`/`fsync+group-commit`, replay throughput, and a bytes/id memory estimate. Run via `npm run bench` (non-gating in CI).

### Patch changes

- **Group commit now actually batches concurrent `setState` calls.** Appends are issued eagerly so writes arriving in the same tick share a single `fsync`, while the cache/event apply stays serialized in call order. Under concurrency, `fsync` throughput now approaches `flush` levels (~15× the serial-fsync rate in local benchmarks) — fulfilling the durability-vs-throughput design target.

## 0.1.0

Initial public release — durable, crash-safe workflow state with replay.

### Features

- `createStateReplay()` / `StateReplay<TData>` — persist workflow state to a durable, append-only JSONL log and replay it on restart.
- **Durable by default** — `fsync` (fdatasync) per write with group-commit; selectable `flush` / `none` levels.
- **Single-writer safe** — advisory `O_EXCL` lockfile with dead-PID stealing on the same host.
- **Streaming replay** — line-by-line via `readline`; the log is never loaded whole into memory.
- **Crash semantics** — a truncated trailing line is skipped as a benign `replayWarning`; interior corruption is skipped (tolerant) or throws (`tolerantReplay: false`).
- **Optional at-rest encryption** — AES-256-GCM with a random per-deployment scrypt salt stored in `meta.json`.
- **Immutable reads** — `getState` / `getAllStates` return frozen deep clones.
- **Typed events** — `ready`, `change`, `replayWarning`, `error`; observability via `getStats()`.
- Zero runtime dependencies. Dual ESM + CJS, Node ≥ 18.
