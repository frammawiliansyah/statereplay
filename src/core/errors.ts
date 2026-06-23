/**
 * Error hierarchy for StateReplay.
 *
 * Every error thrown by the library is an instance of {@link StateReplayError},
 * so callers can catch the whole family with a single `instanceof StateReplayError`
 * check, or narrow to a specific subclass.
 */

/** Base class for all StateReplay errors. */
export class StateReplayError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    // Each subclass reports its own constructor name (e.g. "StateReplayLockError"),
    // keeping stack traces and logs precise without per-subclass boilerplate.
    this.name = new.target.name;
  }
}

/** `encrypt: true` without a `secretKey`, or an otherwise invalid configuration. */
export class StateReplayConfigError extends StateReplayError {}

/** An operation was attempted after `close()`. */
export class StateReplayClosedError extends StateReplayError {}

/**
 * Invalid input (empty id, bad status, non-serializable `data`), or an interior
 * corrupt line encountered during replay when `tolerantReplay: false`.
 */
export class StateReplayValidationError extends StateReplayError {}

/** Payload decryption failed — wrong key, or a tampered/corrupt encrypted line. */
export class StateReplayDecryptError extends StateReplayError {}

/** The log is held by another live process (or a non-stealable cross-host lock). */
export class StateReplayLockError extends StateReplayError {}
