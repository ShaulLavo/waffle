import { expect, spyOn, test } from "bun:test";
import { DescriptorTable } from "../core/descriptors";
import { MemFS } from "../fs/memory";
import { ProcessABI, ProcessSignalExit } from "../proc/abi";
import { ExecutableRegistry } from "../proc/registry";
import { ProcessSupervisor } from "../proc/supervisor";
import { claimOutcome, readOutcome } from "../proc/outcome";
import { createSignalState, requestSignal, setSignalDisposition, SIGNAL_PENDING, takeSignal } from "../proc/signals";
import { checkedSignal, ProcessError } from "../proc/types";
import { confirmWorkerProcessJob, createWorkerProcessTransport, workerProcessState, WorkerProcessClient } from "../proc/worker-client";

function fixture(wait?: (milliseconds: number, word: Int32Array, expected: number) => void) {
  const supervisor = new ProcessSupervisor({ registry: new ExecutableRegistry(), launch() { throw new Error("not launched"); } });
  const pid = supervisor.createRoot(), record = supervisor.get(pid)!;
  const abi = new ProcessABI({ memory: new WebAssembly.Memory({ initial: 1 }), descriptors: record.descriptors,
    fs: new MemFS(), pid, service: supervisor, signals: record, wait });
  return { supervisor, pid, record, abi };
}
const ignored = [17, 18, 23, 28];
const fatal = Array.from({ length: 64 }, (_, index) => index + 1).filter(signal => !ignored.includes(signal) && ![19, 20, 21, 22, 32, 33].includes(signal));

for (const signal of ignored) test(`Linux default-ignore signal ${signal} stays alive, handles explicitly, and resets pending delivery safely`, () => {
  const f = fixture();
  try {
    f.supervisor.kill(f.pid, signal);
    expect(f.record.result).toBeNull();
    expect(readOutcome(f.record.outcome)).toBeNull();
    expect(Atomics.load(f.record.interrupt, 0)).toBe(0);
    expect(f.abi.imports.default_signal!(signal)).toBe(0);
    expect(f.abi.imports.signal!(signal, 2)).toBe(0);
    f.supervisor.kill(f.pid, signal);
    expect(f.abi.imports.interrupted!()).toBe(signal);
    f.supervisor.kill(f.pid, signal);
    expect(Atomics.load(f.record.signalState, signal) & SIGNAL_PENDING).toBe(SIGNAL_PENDING);
    expect(f.abi.imports.signal!(signal, 0)).toBe(0);
    expect(f.abi.imports.interrupted!()).toBe(0);
    expect(readOutcome(f.record.outcome)).toBeNull();
    f.supervisor.defaultSignal(f.pid, signal);
    expect(f.record.result).toBeNull();
  } finally { f.supervisor.dispose(); }
});

for (const signal of fatal) test(`Linux signal ${signal} defaults to a typed terminal outcome`, () => {
  const f = fixture();
  try {
    f.supervisor.kill(f.pid, signal);
    expect(f.record.result).toMatchObject({ kind: "signaled", code: signal, status: 128 + signal });
  } finally { f.supervisor.dispose(); }
});

for (const signal of [1, 10, 12, 34, 64]) test(`catchable signal ${signal} honors ignore, handler and pending-to-default`, () => {
  const f = fixture();
  try {
    expect(f.abi.imports.signal!(signal, 1)).toBe(0);
    f.supervisor.kill(f.pid, signal);
    expect(readOutcome(f.record.outcome)).toBeNull();
    expect(f.abi.imports.signal!(signal, 2)).toBe(0);
    f.supervisor.kill(f.pid, signal);
    expect(f.abi.imports.interrupted!()).toBe(signal);
    f.supervisor.kill(f.pid, signal);
    expect(() => f.abi.imports.signal!(signal, 0)).toThrow(ProcessSignalExit);
    expect(f.record.result).toMatchObject({ kind: "signaled", code: signal });
  } finally { f.supervisor.dispose(); }
});

for (const [signal, errno] of [[0, 28], [32, 28], [33, 28], [65, 28], [1.5, 28], [19, 58], [20, 58], [21, 58], [22, 58]]) {
  test(`signal ${signal} validates consistently across supervisor, shared delivery, ABI and worker`, () => {
    const f = fixture(), descriptors = new DescriptorTable();
    const client = new WorkerProcessClient({ transport: createWorkerProcessTransport(), descriptors,
      codec: { export() { throw new Error("unused"); }, import() { throw new Error("unused"); }, discard() {} }, postMessage() {} });
    const fails = (operation: () => unknown) => {
      try { operation(); throw new Error("accepted invalid signal"); }
      catch (error) { expect(error).toBeInstanceOf(ProcessError); expect((error as ProcessError).errno).toBe(errno!); }
    };
    try {
      fails(() => checkedSignal(signal!));
      fails(() => requestSignal(f.record, signal!));
      fails(() => f.supervisor.kill(f.pid, signal!));
      fails(() => f.supervisor.defaultSignal(f.pid, signal!));
      fails(() => client.kill(client.pid, signal!));
      fails(() => client.defaultSignal(client.pid, signal!));
      expect(f.abi.imports.kill!(f.pid, signal!)).toBe(-errno!);
      expect(f.abi.imports.default_signal!(signal!)).toBe(-errno!);
      for (const mode of [0, 1, 2, 3]) expect(f.abi.imports.signal!(signal!, mode)).toBe(signal === 0 && mode === 0 ? 0 : -errno!);
      expect(readOutcome(f.record.outcome)).toBeNull();
    } finally { descriptors.dispose(); f.supervisor.dispose(); }
  });
}

test("default-ignore disposition reset discards pending without claiming a fatal action", () => {
  const state = createSignalState();
  setSignalDisposition(state, 18, 2);
  // A handler's delivery has already been published before its removal.
  Atomics.or(state, 18, SIGNAL_PENDING);
  expect(setSignalDisposition(state, 18, 0)).toBe(false);
  expect(takeSignal(state)).toBe(0);
});

test("worker default-ignore actions do not publish exit or revoke, but KILL still wins", () => {
  const descriptors = new DescriptorTable(), messages: unknown[] = [];
  let revocations = 0;
  const client = new WorkerProcessClient({ transport: createWorkerProcessTransport(), descriptors,
    codec: { export() { throw new Error("unused"); }, import() { throw new Error("unused"); }, discard() {} },
    postMessage(message) { messages.push(message); }, revokeProcess() { revocations++; } });
  try {
    for (const signal of ignored) client.defaultSignal(client.pid, signal);
    expect(messages).toEqual([]);
    expect(revocations).toBe(0);
    expect(readOutcome(client.signals.outcome)).toBeNull();
    requestSignal(client.signals, 9);
    client.defaultSignal(client.pid, 18);
    expect(readOutcome(client.signals.outcome)).toMatchObject({ kind: "signaled", code: 9 });
    expect(revocations).toBe(1);
  } finally { descriptors.dispose(); }
});

test("slot-recycling follow-up: completed child reservations still exhaust today's append-only directory", () => {
  const descriptors = new DescriptorTable(), messages: import("../proc/worker-client").WorkerProcessMessage[] = [];
  const client = new WorkerProcessClient({ transport: createWorkerProcessTransport({ capacity: 4 }), descriptors,
    codec: { export() { throw new Error("unused"); }, import() { throw new Error("unused"); }, discard() {} },
    postMessage(message) { messages.push(message); } });
  try {
    for (let index = 0; index < 3; index++) {
      const pid = client.spawn(client.pid, { executable: "bun-like", argv: [], env: {}, cwd: "/", job: client.job, fds: [] });
      const state = workerProcessState(messages.pop()!.transport);
      // Stand in for the supervisor's already-tested post-fence publication. No real
      // guest, filesystem service or retained descriptors are created by this probe.
      claimOutcome(state.signals.outcome, { kind: "exited", code: 0 });
      Atomics.store(state.confirmed, 0, 1);
      confirmWorkerProcessJob({ ...client.options.transport, slot: index + 1 });
      expect(client.wait(client.pid, pid)?.status).toBe(0);
      expect(client.wait(client.pid, pid)?.status).toBe(0);
    }
    expect(Atomics.load(workerProcessState(client.options.transport).jobPending, 0)).toBe(1);
    expect(() => client.spawn(client.pid, { executable: "bun-like", argv: [], env: {}, cwd: "/", job: client.job, fds: [] })).toThrow("directory is full");
    // Slot-recycling lane replaces this known-limit assertion with >capacity successful
    // spawn/consume cycles; do not mask exhaustion or silently change repeatable wait.
  } finally { descriptors.dispose(); }
});


test("ABI default-ignore action cannot discard an already selected KILL", () => {
  const f = fixture();
  try {
    requestSignal(f.record, 9);
    let thrown: unknown;
    try { f.abi.imports.default_signal!(18); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(ProcessSignalExit);
    expect((thrown as ProcessSignalExit).signal).toBe(9);
    expect(f.record.result).toMatchObject({ kind: "signaled", code: 9 });
  } finally { f.supervisor.dispose(); }
});


test("ABI default action reports a KILL selected during service confirmation", () => {
  const f = fixture(), applyDefault = f.supervisor.defaultSignal.bind(f.supervisor);
  f.supervisor.defaultSignal = (pid, signal) => {
    requestSignal(f.record, 9);
    applyDefault(pid, signal);
  };
  try {
    let thrown: unknown;
    try { f.abi.imports.default_signal!(15); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(ProcessSignalExit);
    expect((thrown as ProcessSignalExit).signal).toBe(9);
    expect(f.record.result).toMatchObject({ kind: "signaled", code: 9 });
  } finally { f.supervisor.dispose(); }
});

for (const signal of [17, 18, 23, 28]) test(`resetting pending default-ignore signal ${signal} removes stale poll/job-wait hints`, () => {
  let child = 0, waits = 0;
  const f = fixture(() => { waits++; f.supervisor.exit(child, 0); });
  try {
    child = f.supervisor.reserveSpawn(f.pid, { executable: "fixture", argv: [], env: {}, cwd: "/", job: 0, fds: [] });
    f.abi.imports.signal!(signal, 2);
    f.supervisor.kill(f.pid, signal);
    f.abi.imports.signal!(signal, 0);
    expect(Atomics.load(f.record.interrupt, 0)).toBe(0);
    expect(f.abi.imports.poll!(0, 0, 0, 64)).toBe(0);
    expect(f.abi.imports.wait_job!(f.supervisor.jobOf(child), 0, 64)).toBe(0);
    expect(waits).toBe(1);
  } finally { f.supervisor.dispose(); }
});

for (const winner of [{ kind: "exited", code: 0 }, { kind: "exited", code: 23 }, { kind: "start-failed", code: 13 }] as const) test(`ABI explicit default preserves existing ${winner.kind} ${winner.code}`, async () => {
  const { WasiExit } = await import("../core");
  const { waitStatus } = await import("../proc/wait-status");
  const f = fixture();
  try {
    const selected = claimOutcome(f.record.outcome, winner);
    let thrown: unknown;
    try { f.abi.imports.default_signal!(15); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(WasiExit);
    expect((thrown as InstanceType<typeof WasiExit>).code).toBe(waitStatus(selected));
  } finally { f.supervisor.dispose(); }
});


test("discarding a pending ignored default rearms another handled signal", () => {
  const f = fixture();
  try {
    f.abi.imports.signal!(10, 2); f.abi.imports.signal!(17, 2);
    f.supervisor.kill(f.pid, 10); f.supervisor.kill(f.pid, 17);
    expect(Atomics.load(f.record.interrupt, 0)).toBe(17);
    f.abi.imports.signal!(17, 0);
    expect(Atomics.load(f.record.interrupt, 0)).toBe(10);
    expect(f.abi.imports.interrupted!()).toBe(10);
    expect(f.abi.imports.interrupted!()).toBe(0);
  } finally { f.supervisor.dispose(); }
});

test("discarding a pending ignored default cannot clear a racing KILL wake", () => {
  const f = fixture(), compareExchange = Atomics.compareExchange;
  let raced = false;
  const hook = spyOn(Atomics, "compareExchange").mockImplementation(((word: Int32Array, index: number, expected: number, replacement: number) => {
    if (!raced && word === f.record.interrupt && expected === 17 && replacement === 0) {
      raced = true; requestSignal(f.record, 9);
    }
    return compareExchange(word, index, expected, replacement);
  }) as typeof Atomics.compareExchange);
  try {
    f.abi.imports.signal!(17, 2); f.supervisor.kill(f.pid, 17);
    f.abi.imports.signal!(17, 0);
    expect(raced).toBe(true);
    expect(Atomics.load(f.record.interrupt, 0)).toBe(9);
    expect(readOutcome(f.record.outcome)).toMatchObject({ kind: "signaled", code: 9 });
  } finally { hook.mockRestore(); f.supervisor.dispose(); }
});
