import type { StorageEntry } from "../storage-allocation.js";
import type { CollectorPolicy } from "./collector.js";
import { record, strings } from "./protocol.js";
export function listIds(value: unknown): string[] {
  if (!record(value) || !strings(value.indexeddb) || !strings(value.opfs))
    throw new Error("Invalid storage list backend arrays");
  const ids = value.indexeddb
    .map((label) => `indexeddb: ${label}`)
    .concat(value.opfs.map((label) => `opfs: ${label}`));
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate storage list IDs");
  return ids;
}
export function validateStorageAllocation(
  entry: StorageEntry,
  runningCaseIds: readonly string[],
  run: string,
): void {
  const backendPrefix = entry.kind === "indexeddb" ? "indexeddb:" : "opfs:";
  const id = runningCaseIds.find((caseId) => caseId.startsWith(backendPrefix));
  if (!id) throw new Error("Allocation outside running storage case");
  const logical = logicalAllocation(entry);
  const backend = id.startsWith("indexeddb:") ? "storage" : "opfs";
  const expectedKind = backend === "storage" ? "indexeddb" : "opfs-directory";
  if (entry.kind !== expectedKind || !logical.startsWith(`bun-wasm-${backend}-test-${run}-`))
    throw new Error("Allocation not owned by this run and backend");
}
function invalid(detail: string): never {
  throw new Error(detail);
}
function logicalAllocation(entry: StorageEntry): string {
  if (entry.kind === "indexeddb") return entry.name;
  if (!entry.name.startsWith("bun-wasm-")) invalid("Invalid OPFS directory prefix");
  let logical: unknown;
  try {
    logical = JSON.parse(atob(entry.name.slice(9).replaceAll("-", "+").replaceAll("_", "/")));
  } catch {
    invalid("Invalid encoded OPFS allocation");
  }
  if (typeof logical !== "string") invalid("Invalid OPFS logical name");
  const encoded = btoa(JSON.stringify(logical))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  if (entry.name !== `bun-wasm-${encoded}`) invalid("Noncanonical OPFS directory name");
  return logical;
}
export const storagePolicy: CollectorPolicy = {
  listIds,
  allocation: validateStorageAllocation,
  check() {},
};
