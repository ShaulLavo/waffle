import { expect, test } from "bun:test";
import { MemoryGroups } from "../group/state.js";
import { GroupOp, PAGE_BYTES } from "../group/protocol.js";
import { ProcessErrno, ProcessError } from "../proc/errors.js";
import {
  beginDirectoryAdmission,
  commitDirectoryAdmission,
  createDirectory,
  directoryAdmissionVersion,
} from "../proc/directory.js";

test("sole-member closure uses the exact launched incarnation and preserves earlier joins", () => {
  const groups = new MemoryGroups({ stackBytes: 65536 });
  const source = groups.admit(2, "directory", "new");
  source.launch().request.port.close();
  const owner = groups.owner(source.group)!;
  const region = owner.request(source, GroupOp.CREATE, PAGE_BYTES, PAGE_BYTES)[1]!;
  const cell = owner.request(source, GroupOp.CREATE, 16, 16)[1]!;
  const pin = owner.request(source, GroupOp.PIN, region)[1]!;
  expect(owner.request(source, GroupOp.ROUTE_GROUP, pin)).toEqual([0]);
  expect(owner.request(source, GroupOp.PUBLISH, 1, region, cell, 1)[0]).toBe(0);
  const earlier = groups.admit(3, "directory", source.group);
  try {
    expect(() => source.closeAdmission()).toThrow(ProcessError);
    expect(groups.snapshot()[0]).toMatchObject({ members: 2, reserved: 1 });
    earlier.abort();
    const closing = source.closeAdmission();
    expect(() => groups.admit(4, "directory", source.group)).toThrow(
      new ProcessError(ProcessErrno.NOTSUP, "memory group admission is closed"),
    );
    closing.rollback();
    const later = groups.admit(4, "directory", source.group);
    later.abort();
    source.closeAdmission();
    closing.rollback();
    expect(() => groups.admit(5, "directory", source.group)).toThrow(ProcessError);
    expect(groups.snapshot()[0]?.members).toBe(1);
    expect(owner.snapshot()).toMatchObject({ pins: 1, published: 1 });
  } finally {
    earlier.abort();
    source.stopped();
  }
  expect(groups.snapshot()).toEqual([]);
  expect(owner.snapshot()).toMatchObject({ pins: 0, published: 0, holds: 0, regions: 0 });
});

test("directory commit preserves earlier hidden intents without freezing later admissions", () => {
  const directory = createDirectory(4);
  const original = directoryAdmissionVersion(directory);
  const release = beginDirectoryAdmission(directory);
  expect(() => directoryAdmissionVersion(directory)).toThrow(ProcessError);
  expect(() => commitDirectoryAdmission(directory, original)).toThrow(ProcessError);
  release();
  release();
  expect(() => commitDirectoryAdmission(directory, original)).toThrow(ProcessError);
  const current = directoryAdmissionVersion(directory);
  commitDirectoryAdmission(directory, current);
  const late = beginDirectoryAdmission(directory);
  late();
  expect(directoryAdmissionVersion(directory)).toBeGreaterThan(current);
});

test("retained members and released incarnations cannot close admission", () => {
  const groups = new MemoryGroups({ stackBytes: 65536 });
  const source = groups.admit(2, "directory", "new");
  source.launch().request.port.close();
  const sibling = groups.admit(3, "directory", source.group);
  sibling.launch().request.port.close();
  sibling.failed();
  expect(() => source.closeAdmission()).toThrow(ProcessError);
  expect(groups.snapshot()[0]?.retained).toBe(1);
  sibling.stopped();
  source.stopped();
  expect(() => source.closeAdmission()).toThrow(ProcessError);
});
