import { expect, test } from "bun:test";
import { SharedFilesystemState } from "../fs/shared";
import { PAGE } from "../fs/protocol";
import { DirtyCapacityError } from "../fs/dirty-admission";
import { WRITE_INPUT_LIMIT } from "../fs/write-barrier";

function pressure(maxBytes: number) {
  const shared = new SharedFilesystemState();
  shared.dirtyAdmission.configure(
    { maxBytes: PAGE + maxBytes, maxMetadataBytes: 8192 },
    { maxBytes: 32, maxMetadataBytes: 65536, maxOperations: 1 },
    0,
  );
  shared.dirtyAdmission.file(PAGE, 0, 4, true);
  return shared;
}

test("pending transport bytes do not change the accepted dirty-growth inequality", () => {
  const shared = pressure(40);
  const dirty = shared.dirtyAdmission;
  const cost = { bytes: 8, metadataBytes: 0 };
  dirty.reserveCopy(cost, PAGE);
  const ticket = shared.writeAdmission.admit(1, 24);
  try {
    expect(() => dirty.file(PAGE, 4, 8, false)).not.toThrow();
    expect(dirty.diagnostics(PAGE)).toMatchObject({
      dirtyCaptureBytes: 16,
      immutableCopyBytes: 8,
      pendingInputBytes: 24,
      accountedBytes: PAGE + 24,
    });
    expect(() => dirty.checkFile(PAGE, 8, 9, false)).toThrow(DirtyCapacityError);
    expect(() => shared.writeAdmission.reserveInput(ticket, WRITE_INPUT_LIMIT + 1)).toThrow();
    expect(shared.writeAdmission.inputBytes).toBe(24);
  } finally {
    shared.writeAdmission.finish(ticket);
    dirty.releaseCopy(cost);
  }
  expect(dirty.diagnostics(PAGE).pendingInputBytes).toBe(0);
});

test("pending transport metadata is reported separately from dirty metadata enforcement", () => {
  const shared = pressure(64);
  const dirty = shared.dirtyAdmission;
  const ticket = shared.writeAdmission.admit(1, 0, undefined, 8192);
  try {
    expect(() => shared.checkWriteInput(true)).not.toThrow();
    dirty.growCopyMetadata(1024);
    expect(dirty.diagnostics(PAGE)).toMatchObject({
      pendingInputMetadataUnits: 8192,
      accountedMetadataUnits: 3072,
    });
    expect(() => dirty.growCopyMetadata(6144)).toThrow(DirtyCapacityError);
    expect(shared.writeAdmission.metadataBytes).toBe(8192);
  } finally {
    shared.writeAdmission.finish(ticket);
  }
  expect(dirty.diagnostics(PAGE).pendingInputMetadataUnits).toBe(0);
});
