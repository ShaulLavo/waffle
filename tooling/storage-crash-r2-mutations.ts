import type { crashMatrix } from "../tests/storage-crash-r2-browser.js";

const modes = [
  "journal-control",
  "base-control",
  "rotation-control",
  "opfs-flush-payload-1",
  "opfs-flush-snapshot-2",
  "opfs-remove-snapshot-1",
  "opfs-removed-snapshot-1",
  "opfs-remove-payload-1",
  "opfs-control",
];
const oldOpfs = ["opfs-create-snapshot-1", "opfs-open-snapshot-1", "opfs-flush-snapshot-1"];
export const mutants = [
  {
    id: "drop-recovered-file-mode",
    file: "persistent.ts",
    old: "mode: entry.mode ?? 0o600",
    replacement: "mode: 0o600",
    failures: modes,
    assertion: "reopen selects one complete namespace, mode, identity and payload state",
  },
  {
    id: "leave-failed-save-payloads",
    file: "opfs.ts",
    old: "await Promise.all(\n        created.map((key) => this.data.removeEntry(payloadName(key)).catch(() => {})),\n      );",
    replacement: "void created;",
    failures: oldOpfs,
    assertion: "failed save preserves exact data and snapshot inventories before reopen",
  },
  {
    id: "leave-failed-snapshot",
    file: "opfs.ts",
    old: "await this.metadata.removeEntry(name).catch(() => {});",
    replacement: "void name;",
    failures: oldOpfs,
    assertion: "failed save preserves exact data and snapshot inventories before reopen",
  },
];
export type Mutation = (typeof mutants)[number];
export function verifyMatrix(
  result: Awaited<ReturnType<typeof crashMatrix>>,
  mutant?: Mutation,
): void {
  const indexeddb: ((typeof result.indexeddb)[number] | (typeof result.opfs)[number])[] =
    result.indexeddb;
  const cells = indexeddb.concat(result.opfs);
  const failed = cells.filter((cell) => !cell.ok);
  const expected = mutant?.failures.toSorted() ?? [];
  if (result.indexeddb.length !== 15 || result.opfs.length !== 9)
    throw new Error("Matrix cell count changed");
  if (JSON.stringify(failed.map((cell) => cell.id).sort()) !== JSON.stringify(expected))
    throw new Error(`Unexpected failure set for ${mutant?.id ?? "baseline"}`);
  for (const cell of failed) {
    if (!("error" in cell) || !cell.error.includes(mutant?.assertion ?? ""))
      throw new Error(`Wrong mutation assertion: ${cell.id}`);
  }
}
