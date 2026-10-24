import type { Entry, EntryMetadata, ResolvedEntry } from "../browser/shared-fs.js";
import type { ExecutableLookup } from "../proc/registry.js";

type Assert<T extends true> = T;
type RawTarget<T> = [Extract<T, { kind: "symlink" }>] extends [never]
  ? false
  : Extract<T, { kind: "symlink" }> extends { target: string }
    ? true
    : false;
type NoChildren<T> = "children" extends keyof T ? false : true;
export type MetadataShape = [
  Assert<RawTarget<Entry>>,
  Assert<RawTarget<EntryMetadata>>,
  Assert<RawTarget<ResolvedEntry>>,
  Assert<NoChildren<Extract<Entry, { kind: "file" }>>>,
  Assert<NoChildren<Extract<Entry, { kind: "symlink" }>>>,
  Assert<NoChildren<Extract<EntryMetadata, { kind: "dir" }>>>,
];

export function target(entry: Entry | EntryMetadata | ResolvedEntry): string | undefined {
  return entry.kind === "symlink" ? entry.target : undefined;
}
export function children(entry: Entry): Map<string, EntryMetadata> | undefined {
  return entry.kind === "dir" ? entry.children : undefined;
}
export function executableLookup(metadata: ResolvedEntry | undefined): ExecutableLookup {
  return () => metadata;
}
