/** Optional runner bookkeeping. The acknowledgement must precede every storage open. */
export type StorageEntry =
  | { kind: "indexeddb"; name: string }
  | { kind: "opfs-directory"; name: string };
export interface StorageAllocationHooks {
  name(): string;
  allocate(entry: StorageEntry): Promise<void>;
}
