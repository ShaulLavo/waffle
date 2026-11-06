/** Optional runner bookkeeping. The acknowledgement must precede every storage open. */
export type StorageEntry =
  | { kind: "indexeddb"; name: string }
  | { kind: "opfs-directory"; name: string };
export interface StorageAllocationHooks {
  name(): string;
  allocate(entry: StorageEntry): Promise<void>;
}
/** A cleanup fault must not erase the storage assertion that caused cleanup. */
export async function withStorageCleanup(
  run: () => Promise<void>,
  cleanup: () => Promise<void>,
): Promise<void> {
  let primary: { error: unknown } | undefined;
  let cleanupFailure: { error: unknown } | undefined;
  try {
    await run();
  } catch (error) {
    primary = { error };
  } finally {
    try {
      await cleanup();
    } catch (error) {
      cleanupFailure = { error };
    }
  }
  if (primary && cleanupFailure)
    throw new AggregateError(
      [primary.error, cleanupFailure.error],
      "Storage case and fixture cleanup failed",
    );
  if (primary) throw primary.error;
  if (cleanupFailure) throw cleanupFailure.error;
}
