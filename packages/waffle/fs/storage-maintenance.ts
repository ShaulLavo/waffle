/** Shared runtime connections permit takeover; exclusive inspection cannot be stolen. */
export interface StorageLockManager {
  request<T>(
    name: string,
    options:
      | { mode: "exclusive"; steal: true }
      | { mode: "exclusive" | "shared"; ifAvailable: true }
      | { mode: "exclusive" | "shared"; signal?: AbortSignal },
    callback: (lock: unknown | null) => Promise<T>,
  ): Promise<T>;
}

interface MaintenanceLease {
  release(): Promise<void>;
}

export async function maintenanceLock(
  locks: StorageLockManager,
  name: string,
  mode: "shared" | "exclusive",
  signal?: AbortSignal,
  onWaiting?: () => void,
): Promise<MaintenanceLease | "busy"> {
  const lease = await requestMaintenance(locks, name, { mode, ifAvailable: true }, signal);
  if (lease !== "busy" || mode === "exclusive") return lease;
  try {
    onWaiting?.();
  } catch {
    /* Observers do not own the lock. */
  }
  return requestMaintenance(locks, name, { mode: "shared", signal }, signal);
}

async function requestMaintenance(
  locks: StorageLockManager,
  name: string,
  options: Parameters<StorageLockManager["request"]>[1],
  signal?: AbortSignal,
): Promise<MaintenanceLease | "busy"> {
  signal?.throwIfAborted();
  const ready = Promise.withResolvers<MaintenanceLease | "busy">();
  const held = Promise.withResolvers<void>();
  const lifetime = locks.request(
    `bun-wasm:filesystem:indexeddb-maintenance:${name}`,
    options,
    async (lock) => {
      if (signal?.aborted) {
        ready.reject(signal.reason);
        return;
      }
      if (lock === null) {
        ready.resolve("busy");
        return;
      }
      ready.resolve({
        async release() {
          held.resolve();
          await lifetime;
        },
      });
      await held.promise;
    },
  );
  void lifetime.catch(ready.reject);
  return ready.promise;
}
