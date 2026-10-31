import type { MemoryBackendSharedRoot } from "../fs/backend.js";
import type { MemoryBudget } from "../fs/memory-budget.js";
import { MemoryBackend, PersistentBackend, IndexedDBStorage, OpfsStorage } from "../fs/index.js";
import type { StorageBackend } from "../fs/storage.js";
import type { RuntimeStartupObserver } from "../fs/startup.js";
import { resolveVfs, requireVfsCapabilities } from "../fs/vfs.js";

export interface FilesystemBackendOptions {
  readonly mode?: "fast" | "safe" | "memory";
  readonly whenBusy?: "wait" | "takeover";
  readonly name?: string;
  readonly implementation?: "indexeddb" | "opfs-memory" | "memory";
  readonly startupRoot?: MemoryBudget;
  readonly connect?: MemoryBackendSharedRoot;
}
export interface FilesystemBackendLifecycle {
  readonly retainOpeningDebt?: (debt: Promise<void>) => void;
  readonly onStartupStage?: RuntimeStartupObserver;
  readonly signal?: AbortSignal;
  readonly onWaiting?: () => void;
  readonly onOwnershipLost: () => void;
  readonly retainStorage: (storage: StorageBackend) => void;
}
/** The caller owns failed-open cleanup, including any failed native close. */
export async function openFilesystemBackend(
  options: FilesystemBackendOptions,
  lifecycle: FilesystemBackendLifecycle,
): Promise<MemoryBackend | PersistentBackend> {
  const { descriptor, whenBusy } = resolveVfs(options, options.implementation);
  requireVfsCapabilities(descriptor.implementation);
  if (descriptor.implementation === "memory")
    return new MemoryBackend(undefined, undefined, options.startupRoot, undefined, options.connect);
  let backend: PersistentBackend | undefined = undefined;
  let ownershipLost = false;
  const storage =
    descriptor.implementation === "opfs-memory"
      ? await OpfsStorage.open(options.name ?? "waffle-workspace", lifecycle)
      : await IndexedDBStorage.open(options.name ?? "waffle-workspace", {
          ...lifecycle,
          whenBusy,
          onOwnershipLost() {
            ownershipLost = true;
            backend?.dispose();
            lifecycle.onOwnershipLost();
          },
        });
  lifecycle.retainStorage(storage);
  backend = await PersistentBackend.open(storage, {
    startupRoot: options.startupRoot,
    sharedRoot: options.connect,
  });
  if (ownershipLost) {
    backend.dispose();
    throw new Error("Filesystem ownership was lost during recovery");
  }
  return backend;
}
