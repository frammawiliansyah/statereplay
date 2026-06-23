# ADR 001 — Append-only JSONL log + in-memory Map

- **Status:** Accepted
- **Date:** 2026-06-23

## Context

StateReplay must give a single-host, multi-step process **crash-safe local persistence**: every state transition has to survive a crash so the process can rebuild where it was on restart. The store must be simple to operate (no server), trivially inspectable when something goes wrong, and cheap to write to on the hot path.

## Decision

Persist each state transition as **one JSON object per line in an append-only `events.jsonl` file**, and hold current state in an **in-memory `Map<id, StatePayload>`**.

- Writes only ever **append** a line — never overwrite, truncate, or rewrite existing lines.
- On startup, **replay** streams the log line by line (`readline`), applying last-write-wins per id to rebuild the Map.
- Each line carries a schema version (`v`) so old lines can be upcast on read without rewriting the file.

## Consequences

**Positive**

- Dead simple and **inspectable** — the log is human-readable JSONL you can `tail`/`grep` (unless encryption is enabled).
- Append-only writes are fast and crash-friendly: a crash mid-append can only damage the **last** line, which replay detects (no terminating newline) and skips as a benign trailing partial.
- No external service, no schema migrations on disk — versioning happens on read.

**Negative**

- The **log grows unbounded** — there is no in-place update or compaction in v0.1. Long-lived ids accumulate history.
- **Replay is O(n)** in the number of transitions, so very large logs slow startup. (Compaction/snapshotting is deferred to a later version.)
- All live state must fit in memory (the Map).

## Alternatives considered

- **Embedded DB (SQLite/LevelDB):** more features, but adds a native/runtime dependency and obscures the data behind a binary format. StateReplay is intentionally zero-runtime-dependency.
- **Overwrite-in-place file:** breaks the crash-safety guarantee — a crash mid-rewrite can corrupt good state. Append-only confines damage to the tail.

See also [ADR 002 — Durability and locking](./002-durability-and-locking.md).
