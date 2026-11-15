import { expect, test } from "bun:test";
import { MemoryGroups } from "../group/state.js";
import { GroupOp, PAGE_BYTES } from "../group/protocol.js";
import { ProcessErrno, ProcessError } from "../proc/errors.js";
import {
  beginDirectoryAdmission,
  commitDirectoryAdmission,
  createDirectory,
  directoryAdmissionVersion,
  reserveDirectoryProcess,
  collectDirectoryProcess,
  confirmDirectoryProcess,
} from "../proc/directory.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessState,
} from "../proc/worker-client.js";
import { DescriptorTable } from "../core/descriptors.js";
import { createWorkerPipeCodec } from "../proc/worker-pipes.js";
import { claimOutcome } from "../proc/outcome.js";

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

test("a collected caller cannot stamp spawn intent or raw reservation into its old directory", () => {
  const root = createWorkerProcessTransport({ capacity: 3 });
  const child = { ...root, ...reserveDirectoryProcess(root, 2, root.pid, 2, root.pid) };
  const descriptors = new DescriptorTable();
  const client = new WorkerProcessClient({
    transport: child,
    descriptors,
    codec: createWorkerPipeCodec(),
    postMessage() {
      throw new Error("stale caller published");
    },
    prepareSpawn() {
      throw new Error("stale caller prepared an acquisition");
    },
  });
  try {
    claimOutcome(workerProcessState(child).signals.outcome, { kind: "exited", code: 0 });
    confirmDirectoryProcess(child);
    collectDirectoryProcess(child);
    const before = Array.from(new Uint8Array(root.directory));
    const request = { executable: "next", argv: [], env: {}, cwd: "/", job: -1, fds: [] };
    expect(() => client.spawn(child.pid, request)).toThrow(ProcessError);
    expect(Array.from(new Uint8Array(root.directory))).toEqual(before);
    expect(() => reserveDirectoryProcess(child, 3, child.pid, 3, child.pid)).toThrow(ProcessError);
    expect(Array.from(new Uint8Array(root.directory))).toEqual(before);
    const state = workerProcessState(root);
    expect(() =>
      reserveDirectoryProcess(child, 4, child.pid, state.job, root.pid, state.jobSlot),
    ).toThrow(ProcessError);
    expect(Array.from(new Uint8Array(root.directory))).toEqual(before);
  } finally {
    descriptors.dispose();
  }
});
