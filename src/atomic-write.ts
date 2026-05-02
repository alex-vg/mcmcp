/**
 * Atomic file write: write to a sibling `.tmp.<pid>.<ts>` then `rename`.
 * On POSIX this is atomic — a crash between the write and the rename
 * leaves the original file untouched.
 */
import { writeFile, rename, unlink } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

export async function atomicWriteFile(path: string, contents: string): Promise<void> {
  const tmp = join(
    dirname(path),
    `.${basename(path)}.tmp.${process.pid}.${Date.now()}`,
  );
  try {
    await writeFile(tmp, contents, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    // Best-effort cleanup of the temp file on failure.
    try {
      await unlink(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}
