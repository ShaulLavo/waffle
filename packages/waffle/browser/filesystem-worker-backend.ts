import { attemptCleanup, throwCleanupFailures } from "../fs/cleanup.js";
import type { StorageBackend } from "../fs/storage.js";
import {
  openFilesystemBackend,
  type FilesystemBackendLifecycle,
  type FilesystemBackendOptions,
} from "./filesystem-backend.js";

export async function openFilesystemWorkerBackend(
  options: FilesystemBackendOptions,
  lifecycle: Omit<FilesystemBackendLifecycle, "retainStorage">,
): ReturnType<typeof openFilesystemBackend> {
  let storage: StorageBackend | undefined;
  try {
    return await openFilesystemBackend(options, {
      ...lifecycle,
      retainStorage(value) {
        storage = value;
      },
    });
  } catch (error) {
    const failures: unknown[] = [error];
    await attemptCleanup(failures, () => storage?.close());
    throwCleanupFailures(failures, "Filesystem opening cleanup failed");
    throw error;
  }
}
