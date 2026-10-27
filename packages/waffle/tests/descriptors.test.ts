import { expect, test } from "bun:test";
import { DescriptorTable, OpenDescription, type Resource } from "../core/descriptors";

const rights = { rightsBase: 7n, rightsInheriting: 3n };
test("duplicates share file offset and flags but not capability rights", () => {
  const table = new DescriptorTable();
  const file: Extract<Resource, { kind: "file" }> = {
    kind: "file",
    handle: 9,
    offset: 0,
    append: false,
  };
  const description = new OpenDescription(file);
  const fd = table.add(description, rights);
  const dup = table.dup(fd);
  file.offset = 17;
  table.get(dup)!.rightsBase = 1n;
  expect(table.get(dup)!.description.resource).toBe(file);
  expect(file.offset).toBe(17);
  expect(table.get(fd)!.rightsBase).toBe(7n);
  expect(description.references).toBe(2);
});
test("last close releases resource, including renumber replacement and table disposal", () => {
  let closed = 0;
  const resource = () =>
    new OpenDescription(
      {
        kind: "pipe",
        read() {
          return 0;
        },
        write() {
          return 0;
        },
        readiness() {
          return { readable: false, writable: false, hangup: true };
        },
      },
      () => closed++,
    );
  const table = new DescriptorTable();
  const a = resource();
  const b = resource();
  const fd = table.add(a, rights);
  const dup = table.dup(fd);
  const target = table.add(b, rights);
  expect(table.renumber(fd, target)).toBe(true);
  expect(b.references).toBe(0);
  expect(closed).toBe(1);
  expect(a.references).toBe(2);
  expect(table.renumber(target, target)).toBe(true);
  expect(a.references).toBe(2);
  table.close(dup);
  expect(closed).toBe(1);
  table.dispose();
  expect(closed).toBe(2);
  expect(table.close(target)).toBe(false);
});
test("inheritance retains before the parent can close and owns independent rights", () => {
  let closed = 0;
  const parent = new DescriptorTable();
  const child = new DescriptorTable();
  const description = new OpenDescription({ kind: "directory", handle: 3 }, () => closed++);
  const fd = parent.add(description, rights);
  child.inherit(8, parent.get(fd)!);
  parent.close(fd);
  expect(description.references).toBe(1);
  expect(closed).toBe(0);
  child.dispose();
  expect(closed).toBe(1);
});
