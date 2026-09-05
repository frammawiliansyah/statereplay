---
"statereplay": minor
---

Harden the log against tampering, and make failed startups recoverable.

### Security

- **Encrypted records now authenticate their `id` and `ts`.** AES-256-GCM previously covered only the payload, so anyone with write access to the log could move a valid ciphertext under a different `id` — or replay it with a new timestamp — and it would decrypt cleanly. `v|id|ts` is now passed as AEAD associated data, so any such relocation fails the auth-tag check.
- **Plaintext lines are rejected in an encrypted log.** A forged unencrypted entry used to replay as trusted state, meaning encryption provided no integrity for the log as a whole. When a `secretKey` is configured, a non-encrypted line is now treated as corrupt.
- **Replay applies the same validation as `setState`.** `step`, `status`, and the 256-character `id` limit were only enforced on write, so a hand-edited log could load states the public API would reject. Bad entries now follow the normal corrupt-line rule (skipped when `tolerantReplay`, thrown otherwise).

### Reliability

- **`meta.json` is now fsynced on creation.** It holds `kdfSalt`, which is unrecoverable — a crash right after storage init could leave it empty and render every encrypted line permanently undecryptable.
- **The advisory lock carries a nonce.** Stale-lock stealing re-checks the record before removing it, and both `close()` and the exit handler only unlink a lockfile still bearing our own nonce, so a lock belonging to another process is never evicted.
- **A failed `init()` releases the lock and can be retried.** A strict-mode replay failure used to strand the lockfile and cache the rejected promise, permanently bricking that storage path for the process.
- **Non-cloneable payloads are rejected before the write is made durable.** Values that `JSON.stringify` accepts but `structuredClone` rejects (e.g. functions) were persisted and only then threw, leaving the cache out of sync with the log.

### Express integration

- A malformed percent-escape in `/states/:id` (e.g. `/states/%`) returned a 500 with a stack trace and absolute filesystem paths; it now returns a 400.
- `/states` is bounded (`?limit`, default 500) and reports `total`/`returned`, instead of deep-cloning and serializing the entire cache on every dashboard poll.
- Responses set `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`; the dashboard sets a `Content-Security-Policy`.
- The mount prefix no longer matches a longer sibling route (`/_statereplay_admin` is left to your own handlers).

### Release

- The release workflow now actually publishes: `changesets/action` had no `publish` step or `NPM_TOKEN`, so it could only ever open a version PR. Added npm provenance via `publishConfig`.
