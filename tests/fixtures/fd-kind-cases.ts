import type { DescriptorTable, Resource, Stream } from "../../core/descriptors.js";

function equal(actual: number, expected: number, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, received ${actual}`);
}

/** Shared host/browser assertions. Any payload access or endpoint retain is a failure. */
export function assertDescriptorKinds(table: DescriptorTable, kind: (fd: number) => number): void {
  const unexpected = (): never => {
    throw new Error("fd_kind touched a resource instead of looking up its kind");
  };
  const terminal: Stream = {
    kind: "terminal",
    read: unexpected,
    write: unexpected,
    readiness: unexpected,
    forProcess: unexpected,
  };
  const resources: Resource[] = [
    // The ABI reserves OTHER for host resources outside today's discriminated union.
    { kind: "unclassified" } as unknown as Resource,
    { ...terminal, kind: "pipe" },
    terminal,
    { kind: "file", handle: 123, offset: 29, append: false },
    { kind: "directory", handle: 456 },
  ];
  const owned: number[] = [];
  try {
    for (const [expected, resource] of resources.entries()) {
      const fd = table.open(resource, 0n, 0n);
      owned.push(fd);
      const description = table.get(fd)!.description;
      const references = description.references;
      equal(kind(fd), expected, `kind ${expected} without rights`);
      equal(kind(fd), expected, `repeated kind ${expected}`);
      equal(description.references, references, "lookup must not retain");
      const duplicate = table.dup(fd);
      owned.push(duplicate);
      equal(kind(duplicate), expected, `duplicate kind ${expected}`);
      table.close(fd);
      equal(kind(fd), -8, "closed fd");
      equal(kind(duplicate), expected, "duplicate survives original close");
    }
    equal((resources[3] as { offset: number }).offset, 29, "file cursor unchanged");
    equal(kind(0x7fffffff), -8, "never-opened fd");
    equal(kind(-1), -8, "unsigned invalid fd");
    equal(kind(0x80000000), -8, "out-of-range fd");
  } finally {
    for (const fd of owned) table.close(fd);
  }
}

/** Stdio uses actual bindings, not the fd number or preview1's generic stream type. */
export function assertStdioKinds(table: DescriptorTable, kind: (fd: number) => number): void {
  for (const fd of [0, 1, 2]) equal(kind(fd), 2, `default terminal stdio ${fd}`);
  const source = table.open({ kind: "file", handle: 123, offset: 0, append: false }, 0n, 0n);
  try {
    for (const fd of [0, 1, 2]) {
      table.inherit(fd, table.get(source)!);
      equal(kind(fd), 3, `file stdio ${fd}`);
    }
  } finally {
    table.close(source);
  }
}

export function assertPipeStdio(
  table: DescriptorTable,
  kind: (fd: number) => number,
  reader: number,
  writer: number,
): void {
  for (const [fd, source] of [
    [0, reader],
    [1, writer],
    [2, writer],
  ] as const) {
    table.inherit(fd, table.get(source)!);
    equal(kind(fd), 1, `pipe stdio ${fd}`);
  }
}
