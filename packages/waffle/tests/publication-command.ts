export type PublicationMode = "ordinary" | "workspace";
export const publicationId = (mode: PublicationMode): string =>
  `publication: complete ${mode} command`;
export const publicationLabels = [
  "uninstrumented root allocates no publication domain",
  "host real WASI runtime_proc and resident writers publish receipts and current reads without nudges",
  "global and file contention preserve guest memory and offsets; one bounded prefix and no delayed suffix",
  "growth owns no guest bytes or logical revision before retry",
  "host replace append exclusive create and move each publish one complete group",
  "namespace groups retain distinct inode identities across rename link unlink and recursive removal",
  "direct and service metadata plus cached current reads enforce permissions",
  "exact duplicate conflicts retirement immutable pins and explicit history gaps",
  "live admission revocation waits without stealing from the holder",
  "native browser worker close is observed before reaping the dead admission holder",
  "actual paused PersistentBackend read cannot hydrate after domain stop",
  "cancelled cold writer preserves a live peer sharing the actual storage read",
  "after-commit response loss preserves receipt and exact duplicate result",
  "stopped authority rejects a late reply without installing an old cursor",
  "oracle detects missing direct publication and a stale retained cut",
];
export const workspaceLabels = [
  "public runtime worker memory",
  "public persistent worker flush/reopen",
  "WASI/direct/metadata all-writer handoff",
  "cursor cancellation and owner death",
];
export function checkPublicationLabels(mode: PublicationMode, value: unknown): void {
  const labels = mode === "workspace" ? workspaceLabels : publicationLabels;
  if (
    !Array.isArray(value) ||
    value.length !== labels.length ||
    value.some((label, index) => label !== labels[index])
  )
    throw new Error(`Incomplete or reordered ${mode} publication controls`);
}
