import { expect, test } from "bun:test";
import { createWorkerProcessTransport, workerProcessState } from "../proc/worker-client.ts";
import {
  collectDirectoryProcess,
  collectDirectoryJob,
  confirmDirectoryProcess,
  reserveDirectoryProcess,
  directoryControls,
} from "../proc/directory.ts";
import {
  captureNativeReturn,
  captureProcessObserver,
  acquireObservedProcess,
  checkProcessObservation,
  isProcessExecutionTerminated,
  observedProcessExit,
} from "../proc/observation.ts";
import { claimOutcome, readOutcome, markStarted } from "../proc/outcome.ts";
import { ProcessError, ProcessErrno } from "../proc/types.ts";
import {
  createSharedControlAllocator,
  installSharedControlAllocator,
  consumedControlBytes,
} from "../memory/control.ts";

function child(root = createWorkerProcessTransport({ capacity: 2 }), pid = 2) {
  const state = workerProcessState(root);
  return {
    ...root,
    ...reserveDirectoryProcess(root, pid, root.pid, state.job, root.pid, state.jobSlot),
  };
}
function select(process: ReturnType<typeof child>, code = 9) {
  const state = workerProcessState(process);
  claimOutcome(state.signals.outcome, { kind: "signaled", code });
  confirmDirectoryProcess(process);
  return state;
}
function caught(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
}

for (const nativeFirst of [false, true]) {
  test(`logical collection and native return are independent, native first=${nativeFirst}`, () => {
    const root = createWorkerProcessTransport({ capacity: 2 });
    const process = child(root);
    const observer = captureProcessObserver(structuredClone(process));
    const returned = captureNativeReturn(process);
    expect(observer.read()).toEqual({ kind: "pending" });
    const state = select(process);
    const selected = { kind: "signaled", code: 9, status: 137 } as const;
    expect(observer.read()).toEqual({ kind: "selected", result: selected });
    if (nativeFirst) returned();
    expect(collectDirectoryProcess(process)).toEqual(selected);
    expect(() => readOutcome(state.signals.outcome)).toThrow(ProcessError);
    if (!nativeFirst) {
      expect(observer.read()).toEqual({ kind: "selected", result: selected });
      expect(caught(() => child(root, 3))).toMatchObject({ errno: ProcessErrno.AGAIN });
      returned();
    }
    expect(observer.read()).toEqual({ kind: "terminated" });
    const successor = child(root, 4);
    expect(successor.slot).toBe(process.slot);
    const snapshot = new Uint8Array(root.directory).slice();
    returned();
    expect(observer.read()).toEqual({ kind: "terminated" });
    expect(() => markStarted(state.signals.outcome)).toThrow(ProcessError);
    expect(new Uint8Array(root.directory).slice()).toEqual(snapshot);
    expect(readOutcome(workerProcessState(successor).signals.outcome)).toBeNull();
  });
}

test("each admitted execution costs sixteen control bytes and successful churn has no count quota", () => {
  const grant = { kind: "bounded", state: new SharedArrayBuffer(8), limit: 64 * 1024 } as const;
  const receipts: SharedArrayBuffer[] = [];
  const restore = installSharedControlAllocator(
    createSharedControlAllocator(grant, (buffer) => receipts.push(buffer)),
  );
  try {
    const root = createWorkerProcessTransport({ capacity: 2 });
    const initial = consumedControlBytes(grant);
    for (let pid = 2; pid < 1026; pid++) {
      const process = child(root, pid);
      const returned = captureNativeReturn(process);
      select(process);
      collectDirectoryProcess(process);
      returned();
    }
    expect(consumedControlBytes(grant) - initial).toBe(1024 * 16);
    expect(receipts.filter((buffer) => buffer.byteLength === 16)).toHaveLength(1025);
  } finally {
    restore();
  }
});

test("directory backing is exactly 32 + P * 89 * 8 at both supported bounds", () => {
  expect(createWorkerProcessTransport({ capacity: 1 }).directory.byteLength).toBe(744);
  expect(createWorkerProcessTransport().directory.byteLength).toBe(729120);
  expect(createWorkerProcessTransport({ capacity: 65536 }).directory.byteLength).toBe(46661664);
});

test("allocation failure is NOMEM without publishing a process or a launch-count allowance", () => {
  const root = createWorkerProcessTransport({ capacity: 2 });
  const grant = { kind: "bounded", state: new SharedArrayBuffer(8), limit: 15 } as const;
  const restore = installSharedControlAllocator(createSharedControlAllocator(grant, () => {}));
  try {
    expect(caught(() => child(root))).toMatchObject({ errno: ProcessErrno.NOMEM });
    expect(consumedControlBytes(grant)).toBe(0);
  } finally {
    restore();
  }
  expect(child(root).slot).toBe(1);
});

test("forwarded phase four is not an ancestor dependency or ordinary authority", () => {
  const root = createWorkerProcessTransport({ capacity: 3 });
  const parent = child(root);
  const descendant = { ...root, ...reserveDirectoryProcess(parent, 3, parent.pid, 2, parent.pid) };
  const state = workerProcessState(descendant);
  const returned = captureNativeReturn(parent);
  select(parent);
  collectDirectoryProcess(parent);
  expect(
    directoryControls(root.directory, () => state.jobControlParent.load(), root.pid, true),
  ).toBe(true);
  expect(() => workerProcessState(parent)).toThrow(ProcessError);
  returned();
});

test("whole-job collection retires its header while native consumers remain pending", () => {
  const root = createWorkerProcessTransport({ capacity: 3 });
  const leader = { ...root, ...reserveDirectoryProcess(root, 2, 1, 2, 1) };
  const state = workerProcessState(leader);
  const member = { ...root, ...reserveDirectoryProcess(leader, 3, 2, 2, 1, state.jobSlot) };
  const leaderObserver = captureProcessObserver(leader);
  const memberObserver = captureProcessObserver(member);
  const leaderReturned = captureNativeReturn(leader);
  const memberReturned = captureNativeReturn(member);
  select(leader);
  select(member, 15);
  expect(collectDirectoryJob(root.directory, state.jobSlot, state.job).code).toBe(9);
  expect(leaderObserver.read().kind).toBe("selected");
  expect(memberObserver.read().kind).toBe("selected");
  expect(caught(() => child(root, 4))).toMatchObject({ errno: ProcessErrno.AGAIN });
  memberReturned();
  const successor = { ...root, ...reserveDirectoryProcess(root, 5, 1, 3, 1) };
  expect(workerProcessState(successor).jobSlot).toBe(state.jobSlot);
  expect(memberObserver.read()).toEqual({ kind: "terminated" });
  expect(leaderObserver.read().kind).toBe("selected");
  leaderReturned();
});

test("acquisition recovery preserves unrelated exception identity while pending or invalid", () => {
  const process = child();
  const observer = captureProcessObserver(process);
  const error = new ProcessError(71, "process incarnation was collected");
  expect(
    caught(() =>
      acquireObservedProcess(observer, () => {
        throw error;
      }),
    ),
  ).toBe(error);
  const lifetime = new BigInt64Array(process.lifetime);
  Atomics.store(lifetime, 0, Atomics.load(lifetime, 0) ^ 1n);
  expect(
    caught(() =>
      acquireObservedProcess(observer, () => {
        throw error;
      }),
    ),
  ).toBe(error);
  expect(isProcessExecutionTerminated(error)).toBe(false);
});

test("expiry has a distinct runtime unwind with no exit code or signal", () => {
  const process = child();
  const observer = captureProcessObserver(process);
  captureNativeReturn(process)();
  const error = caught(() => checkProcessObservation(observer));
  expect(isProcessExecutionTerminated(error)).toBe(true);
  expect(error).not.toHaveProperty("signal");
  expect(error).not.toHaveProperty("code");
  expect(isProcessExecutionTerminated(new Error("process execution terminated"))).toBe(false);
  expect(isProcessExecutionTerminated(new ProcessError(71, "process execution terminated"))).toBe(
    false,
  );
});

test("active observers reject wrong directory, pid, slot and token state", () => {
  const process = child();
  const other = child();
  for (const transfer of [
    { ...process, directory: other.directory },
    { ...process, pid: 3 },
    { ...process, slot: 0 },
    { ...process, lifetime: new SharedArrayBuffer(8) },
  ])
    expect(() => captureProcessObserver(transfer)).toThrow();
  const observer = captureProcessObserver(process);
  Atomics.store(new BigInt64Array(process.lifetime), 1, 0n);
  expect(() => observer.read()).toThrow(ProcessError);
});

test("a native-return helper finishes publication after the token expired but before the row flag", () => {
  const root = createWorkerProcessTransport({ capacity: 2 });
  const process = child(root);
  select(process);
  collectDirectoryProcess(process);
  const token = new BigInt64Array(process.lifetime);
  Atomics.store(token, 1, (BigInt(process.pid) << 32n) | 2n);
  expect(captureProcessObserver(process).read()).toEqual({ kind: "terminated" });
  captureNativeReturn(process)();
  expect(child(root, 3).slot).toBe(process.slot);
});

test("runtime-owned unwinds remain bound to the exact captured observer", () => {
  const first = child();
  const second = child();
  const firstObserver = captureProcessObserver(first);
  const secondObserver = captureProcessObserver(second);
  const returned = captureNativeReturn(first);
  select(first);
  const selected = caught(() =>
    acquireObservedProcess(firstObserver, () => {
      throw new Error("lost acquisition");
    }),
  );
  expect(observedProcessExit(selected, firstObserver)?.code).toBe(9);
  expect(observedProcessExit(selected, secondObserver)).toBeNull();
  returned();
  const expired = caught(() => checkProcessObservation(firstObserver));
  expect(isProcessExecutionTerminated(expired, firstObserver)).toBe(true);
  expect(isProcessExecutionTerminated(expired, secondObserver)).toBe(false);
});
