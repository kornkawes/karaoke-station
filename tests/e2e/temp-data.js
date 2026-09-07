import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve, sep, join } from "node:path";

export const e2eDataDir = join(tmpdir(), "karaoke-station-e2e-current");

export async function removeCurrentE2eData() {
  const tempRoot = `${resolve(tmpdir())}${sep}`;
  const resolved = resolve(e2eDataDir);
  if (!resolved.startsWith(tempRoot) || basename(resolved) !== "karaoke-station-e2e-current") {
    throw new Error("Refusing to remove an E2E data directory outside the approved temp path");
  }
  await rm(resolved, { recursive: true, force: true });
}
