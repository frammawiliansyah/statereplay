/**
 * StateReplay — public API.
 *
 * Persist workflow state to a durable, append-only JSONL log and replay it on
 * restart so a crashed multi-step process resumes without re-running dangerous
 * side-effects. Durable by default (`fsync`) and single-writer locked.
 *
 * @example
 * ```ts
 * import { createStateReplay } from "statereplay";
 *
 * const replay = await createStateReplay({ storagePath: "./.statereplay" });
 * await replay.setState("job-1", { step: "INIT", status: "PENDING" });
 * console.log(replay.getState("job-1"));
 * await replay.close();
 * ```
 */

export { createStateReplay, StateReplay } from "./core/StateReplay.js";
export {
  StateReplayClosedError,
  StateReplayConfigError,
  StateReplayDecryptError,
  StateReplayError,
  StateReplayLockError,
  StateReplayValidationError,
} from "./core/errors.js";
export type {
  StateChangeEvent,
  StatePayload,
  StateReplayEventMap,
  StateReplayOptions,
  StateReplayStats,
  StateStatus,
} from "./types/index.js";
