/**
 * Public types for StateReplay.
 *
 * These are the only shapes a consumer needs: the payload they persist, the
 * options they construct with, and the events/stats they observe.
 */

export type StateStatus = "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED" | "COMPLETED";

export interface StatePayload<TData = Record<string, unknown>> {
  /** Workflow step name, free-form string (e.g. "CEX_WITHDRAWAL"). */
  step: string;
  status: StateStatus;
  /** Arbitrary, JSON-serializable, type-safe via the `TData` generic. */
  data?: TData;
  /** Error message when status is FAILED. */
  error?: string;
  /** Auto-filled by StateReplay if omitted. */
  timestamp?: number;
  /** Free-form metadata (v1.1) — e.g. attempt count. */
  meta?: Record<string, unknown>;
}

export interface StateReplayOptions {
  /** Root storage directory, e.g. "./.statereplay". */
  storagePath: string;
  /** Default: "events.jsonl". */
  logFileName?: string;
  /** Durability level for `setState`. Default: "fsync". */
  durability?: "fsync" | "flush" | "none";
  /** Acquire an advisory single-writer lock at init. Default: true. */
  lock?: boolean;
  /**
   * Fallback staleness: an unreadable/incomplete lock file older than this is
   * treated as stale (covers a crash mid-creation). A live same-host lock is
   * never stolen on age alone; a dead-PID same-host lock is stolen immediately
   * regardless of this value. Default: 10_000 ms.
   */
  lockStaleMs?: number;
  /** Default: false. */
  encrypt?: boolean;
  /** Required when `encrypt` is true. 32-byte Buffer, or a passphrase (scrypt-derived). */
  secretKey?: string | Buffer;
  /** Run `init()` automatically on construction (async). Default: false (synchronous constructor). */
  autoInit?: boolean;
  /** Skip corrupt lines vs throw on interior corruption. Default: true (tolerant). */
  tolerantReplay?: boolean;
}

export interface StateChangeEvent<TData = Record<string, unknown>> {
  id: string;
  previous: StatePayload<TData> | null;
  current: StatePayload<TData>;
}

export interface StateReplayStats {
  /** Total applied log entries. */
  eventCount: number;
  /** Unique ids in cache. */
  idCount: number;
  /** Current log file size in bytes. */
  logSizeBytes: number;
  /** Wall-clock duration of the most recent replay. */
  lastReplayDurationMs: number;
  /** Timestamp of the last successful `setState`, or null if none yet. */
  lastWriteAt: number | null;
}

/** Event map for the typed EventEmitter (see `StateReplay`). */
export interface StateReplayEventMap<TData = Record<string, unknown>> {
  ready: [];
  change: [event: StateChangeEvent<TData>];
  error: [error: Error];
  replayWarning: [info: { lineNumber: number; message: string; fatal: boolean }];
}
