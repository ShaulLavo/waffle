import { expect, test } from "bun:test";
import { parseFileIdentity } from "../fs/file-identity.js";
import { NamespaceProjectionTable } from "../fs/namespace-projection-table.js";
import type { NamespaceRecord } from "../fs/workspace-protocol.js";
import { SIZES } from "../tooling/vfs-workloads.js";

function identity(serial: number) {
  const token = ((1n << 64n) | BigInt(serial)).toString(16);
  return parseFileIdentity({ id: token, version: token });
}

function record(serial: number, parent: number | null, name: string, directory = false): NamespaceRecord {
  return {
    ...identity(serial),
    parent: parent === null ? null : identity(parent).id,
    name,
    path: "/",
    selected: true,
    kind: directory ? "directory" : "file",
    size: 0,
    mtime: 0,
    mode: 0o700,
  };
}

function seedW1(table: NamespaceProjectionTable): number {
  let serial = 1;
  table.add(record(serial++, null, "", true));
  for (let directory = 0; directory < SIZES.W1.directories; directory++) {
    const parent = serial++;
    table.add(record(parent, 1, `d${directory.toString().padStart(5, "0")}`, true));
    for (let file = directory * 10; file < directory * 10 + 10; file++)
      table.add(record(serial++, parent, `f${file.toString().padStart(5, "0")}`));
    if (directory < SIZES.W1.largeFiles) table.add(record(serial++, parent, "large"));
  }
  return serial - 1;
}

test("the W1 historical namespace fits the unchanged two MiB budget", () => {
  const table = new NamespaceProjectionTable();
  expect(seedW1(table)).toBe(55033);
});
