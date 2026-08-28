import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { rename, writeFile } from "node:fs/promises";

/**
 * Writes `contents` to `path` without a concurrent reader ever observing a
 * partial write. A plain writeFile() truncates the file in place — a
 * concurrent read can land between the truncate and the new content being
 * fully flushed, and see a torn/empty file. Writing to a temp file in the
 * same directory and renaming over the target sidesteps that: rename() is
 * atomic on the same filesystem (POSIX and Windows/NTFS both, including
 * overwriting an existing destination), so a reader either sees the old,
 * fully-written content or the new, fully-written content — never a partial
 * write in between.
 *
 * This is what actually enabled dispatcher concurrency to be safe: once
 * multiple tasks run at once, TaskStore.list() (reading every task file to
 * find the next one to claim) can genuinely race a concurrent update() to a
 * DIFFERENT task's file — not the same key the KeyedMutex protects, since
 * list()/get() were never routed through it.
 */
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const tmpPath = join(dirname(path), `.${randomUUID()}.tmp`);
  await writeFile(tmpPath, contents);
  await renameWithRetry(tmpPath, path);
}

/**
 * Windows can transiently refuse to rename over a destination file that's
 * momentarily open for reading elsewhere (EPERM, sometimes EBUSY/EACCES) — a
 * lock POSIX simply doesn't impose on a rename. It's held only for the
 * concurrent read's duration, not indefinitely, so a handful of short
 * retries clears it; anything else (or persisting past the last attempt)
 * propagates as a real failure.
 */
async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= attempts || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 15));
    }
  }
}
