import { open, rm } from "node:fs/promises";

import { FsStoreError, isErrorWithCode } from "./errors.js";
import { ensureDirectory } from "./json.js";
import { normalizeRootDir, runDirectory, writerLockPath, type FsStorageOptions } from "./paths.js";

export interface FsWriterLockHandle {
  run_id: string;
  path: string;
  release(): Promise<void>;
}

export class FsWriterLock {
  readonly rootDir: string;

  constructor(options: FsStorageOptions) {
    this.rootDir = normalizeRootDir(options.rootDir);
  }

  async acquire(run_id: string): Promise<FsWriterLockHandle> {
    await ensureDirectory(runDirectory(this.rootDir, run_id));
    const path = writerLockPath(this.rootDir, run_id);

    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(
          JSON.stringify({
            run_id,
            pid: process.pid,
            acquired_at: new Date().toISOString()
          }),
          "utf8"
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isErrorWithCode(error, "EEXIST")) {
        throw new FsStoreError("LOCK_ALREADY_HELD", "Run writer lock already exists.", { run_id, path });
      }

      throw error;
    }

    return {
      run_id,
      path,
      async release() {
        await rm(path, { force: true });
      }
    };
  }
}
