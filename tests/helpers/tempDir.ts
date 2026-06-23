import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Create a fresh, unique temp directory for a test's storage. */
export function createTempStorage(): Promise<string> {
  return mkdtemp(join(tmpdir(), "statereplay-test-"));
}

/** Recursively remove a temp storage directory (best-effort). */
export async function removeTempStorage(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}
