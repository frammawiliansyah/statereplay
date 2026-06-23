# ADR 002 — Durability (fsync + group-commit) and single-writer locking

- **Status:** Accepted
- **Date:** 2026-06-23

## Context

Two correctness properties are non-negotiable for the headline use case (never trigger a double crypto withdrawal):

1. **"Persisted" must mean on disk.** A normal `write()` lands in the OS page cache; a crash before the kernel flushes loses it. **Flushed ≠ durable.** `setState` must not resolve until the bytes are truly durable.
2. **Two writers must not double-execute.** If two processes open the same log concurrently, they can interleave appends and each re-run a "once only" side-effect.

## Decision

- **Durability defaults to `fsync`.** On each commit, StateReplay `write()`s then `fdatasync()`s before resolving the `setState` promise. Lower levels are opt-in: `flush` (resolve on OS-cache write) and `none` (resolve immediately).
- **Group commit.** Appends arriving in the same tick are coalesced into **one `write` + one `fsync`**, and all their promises resolve together — the standard WAL technique that recovers throughput without weakening the per-call guarantee. Order is always preserved (serial write queue).
- **Parent-directory fsync** after first creating the log file, so a freshly created file cannot vanish on crash even after `fdatasync`.
- **Advisory single-writer lock.** An `O_EXCL` lockfile records `{pid, hostname, startedAt}`. A second live holder makes `init()` throw `StateReplayLockError`. A same-host lock whose PID is dead (`process.kill(pid, 0)` → `ESRCH`) is stolen automatically; an unreadable/incomplete lock is stolen only once it is older than `lockStaleMs`.

## Consequences

**Positive**

- `setState` resolving is a real durability guarantee — verified by a child-process test that `SIGKILL`s immediately after resolve and finds the line present and complete on re-read.
- Group commit keeps throughput acceptable despite per-write `fsync`.
- Crashed processes self-heal: their stale same-host lock is reclaimed on the next start.

**Negative**

- **`fsync` is disk-bound**, so write latency is dominated by storage; group-commit mitigates but does not eliminate it. Latency-sensitive, non-critical state can drop to `flush`/`none`.
- The lock is **single-host only.** `O_EXCL` lockfiles are **unreliable on NFS / network filesystems** — StateReplay is not a distributed lock.
- On **Windows**, POSIX permission hardening (`chmod 0600/0700`) is a no-op; security degrades to filesystem ACLs.

## Alternatives considered

- **`flush` as the default:** faster, but silently violates "persisted = on disk." Durable-by-default is the safer posture for financial workloads; speed is an opt-out.
- **OS advisory locks (`flock`)/`proper-lockfile`:** more machinery and still not cross-host. A self-contained `O_EXCL` lockfile with PID liveness checks is enough for the single-host scope and keeps the zero-dependency promise.

See also [ADR 001 — Append-only log](./001-append-only-log.md).
