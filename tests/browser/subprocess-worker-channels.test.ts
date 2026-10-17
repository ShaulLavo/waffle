import { expect, test } from "bun:test";
import { CHILD_FINAL_SIGNAL, SharedPipe, SubprocessHost, childTransport, type ChildTransport, type SpawnMeta } from "../src/subprocess.ts";
import { claimOutcome, outcomeWord, readOutcome } from "../../runtime/proc/outcome.ts";
import { createSignalState, takeSignal } from "../../runtime/proc/signals.ts";

const TO_WORKER = 4;
const FROM_WORKER = 5;
const payload = new Uint8Array([7, 8, 9]);
const worker = { memoryLimitMb: 64, resourceLimits: { stackSizeMb: 2 } };
const command = (isWorker = true) => JSON.stringify({ argv: ["bun", "worker.ts"], ...(isWorker ? { worker } : {}) });

function fixture() {
  const launched: { meta: SpawnMeta; transport: ChildTransport }[] = [];
  const events: string[] = [];
  const parent = new SubprocessHost({
    output() {},
    launch(meta, transport) {
      launched.push({ meta, transport });
      return { revoke() { events.push("revoke"); }, terminate() { events.push("terminate"); } };
    },
  });
  const pid = parent.spawn(command());
  const transport = launched[0]!.transport;
  const defaults: number[] = [];
  const child = new SubprocessHost({
    workerTransport: transport,
    budget: transport.budget, slot: transport.slot, token: transport.token,
    identity: transport.identity, pid: transport.pid, jobId: transport.jobId,
    signalState: transport.signalState, outcome: transport.outcome,
    defaultSignal(signal) { defaults.push(signal); },
    output() {}, launch() { return { terminate() {} }; },
  });
  return { parent, child, pid, transport, launched, events, defaults, dispose() { child.dispose(); parent.dispose(); } };
}

test("worker channels occupy buffers 3/4 but selectors 4/5 without replacing final-signal metadata", () => {
  const f = fixture();
  try {
    expect(f.launched[0]!.meta.worker).toEqual(worker);
    expect(f.transport.pipes).toHaveLength(5);
    const handles = [0, 1, 2, TO_WORKER, FROM_WORKER].map(selector => f.parent.pipe(f.pid, selector));
    expect(handles.every(handle => handle > 0)).toBe(true);
    expect(new Set(handles).size).toBe(5);
    expect(f.parent.pipe(f.pid, CHILD_FINAL_SIGNAL)).toBe(-2);
    expect(f.child.pipe(0, CHILD_FINAL_SIGNAL)).toBe(-3);
    expect(f.child.pipe(0, TO_WORKER)).toBeGreaterThan(0);
    expect(f.child.pipe(0, FROM_WORKER)).toBeGreaterThan(0);
  } finally { f.dispose(); }
});

test("worker channels preserve direction and byte identity between parent and self", () => {
  const f = fixture();
  try {
    const to = f.parent.pipe(f.pid, TO_WORKER);
    const from = f.parent.pipe(f.pid, FROM_WORKER);
    const selfRead = f.child.pipe(0, TO_WORKER);
    const selfWrite = f.child.pipe(0, FROM_WORKER);
    expect(f.parent.write(to, payload)).toBe(payload.length);
    expect(f.child.read(selfRead)).toEqual(payload);
    expect(f.child.write(selfWrite, payload)).toBe(payload.length);
    expect(f.parent.read(from)).toEqual(payload);
    expect(f.parent.read(to)).toBe(-3);
    expect(f.parent.write(from, payload)).toBe(-3);
    expect(f.child.write(selfRead, payload)).toBe(-3);
    expect(f.child.read(selfWrite)).toBe(-3);
  } finally { f.dispose(); }
});

for (const selector of [-1, 0, 1, 2, 3, 4.5, 6]) test(`self worker selector ${selector} cannot alias a worker pipe or metadata`, () => {
  const f = fixture();
  try { expect(f.child.pipe(0, selector)).toBe(-3); }
  finally { f.dispose(); }
});

test("non-worker processes expose neither parent nor self worker channels", () => {
  const f = fixture();
  try {
    const pid = f.parent.spawn(command(false));
    expect(f.launched[1]!.transport.pipes).toHaveLength(3);
    expect(f.parent.pipe(pid, TO_WORKER)).toBe(-3);
    expect(f.parent.pipe(pid, FROM_WORKER)).toBe(-3);
    expect(f.parent.pipe(0, TO_WORKER)).toBe(-3);
    expect(f.parent.pipe(0, FROM_WORKER)).toBe(-3);
    expect(f.parent.pipe(0, CHILD_FINAL_SIGNAL)).toBe(-3);
  } finally { f.dispose(); }
});

for (const signaled of [false, true]) test(`completed worker channels do not alias ${signaled ? "signal15" : "ordinary143"} metadata`, () => {
  const f = fixture();
  try {
    const to = f.parent.pipe(f.pid, TO_WORKER);
    const from = f.parent.pipe(f.pid, FROM_WORKER);
    if (signaled) f.parent.kill(f.pid, 15);
    else childTransport(f.transport).finish(143);
    expect(f.parent.wait(f.pid)).toBe(143);
    expect(f.parent.pipe(f.pid, CHILD_FINAL_SIGNAL)).toBe(signaled ? 15 : 0);
    expect(f.parent.pipe(f.pid, TO_WORKER)).toBe(to);
    expect(f.parent.pipe(f.pid, FROM_WORKER)).toBe(from);
    expect(new SharedPipe(f.transport.pipes[3], f.transport.budget).readiness().hangup).toBe(true);
    expect(new SharedPipe(f.transport.pipes[4], f.transport.budget).readiness().hangup).toBe(true);
    expect(f.parent.write(to, payload)).toBe(-1);
    expect(f.parent.read(from)).toBe(0);
  } finally { f.dispose(); }
});

for (const bridge of ["native", "slots"] as const) test(`worker channel selectors and directions work through the ${bridge} bridge`, () => {
  const f = fixture();
  try {
    if (bridge === "native") {
      const parent = f.parent.engineNet().natives;
      const child = f.child.engineNet().natives;
      const call = (api: typeof parent, name: string, ...args: unknown[]) => Reflect.apply(api[name]!, null, args);
      const to = call(parent, "hostChildPipe", f.pid, TO_WORKER);
      const selfRead = call(child, "hostChildPipe", 0, TO_WORKER);
      expect(call(parent, "hostWrite", to, payload)).toBe(payload.length);
      expect(call(child, "hostRead", selfRead)).toEqual(payload);
      const from = call(parent, "hostChildPipe", f.pid, FROM_WORKER);
      const selfWrite = call(child, "hostChildPipe", 0, FROM_WORKER);
      expect(call(child, "hostWrite", selfWrite, payload)).toBe(payload.length);
      expect(call(parent, "hostRead", from)).toEqual(payload);
      expect(call(child, "hostChildPipe", 0, CHILD_FINAL_SIGNAL)).toBe(-3);
    } else {
      const parentMemory = new WebAssembly.Memory({ initial: 1 });
      const childMemory = new WebAssembly.Memory({ initial: 1 });
      f.parent.attach(parentMemory); f.child.attach(childMemory);
      const parent = f.parent.slots();
      const child = f.child.slots();
      new Uint8Array(parentMemory.buffer, 0, payload.length).set(payload);
      expect(parent.write!(parent.child_pipe!(f.pid, TO_WORKER), 0, payload.length)).toBe(payload.length);
      expect(child.read!(child.child_pipe!(0, TO_WORKER), 8, payload.length)).toBe(payload.length);
      expect(new Uint8Array(childMemory.buffer, 8, payload.length)).toEqual(payload);
      expect(child.write!(child.child_pipe!(0, FROM_WORKER), 8, payload.length)).toBe(payload.length);
      expect(parent.read!(parent.child_pipe!(f.pid, FROM_WORKER), 16, payload.length)).toBe(payload.length);
      expect(new Uint8Array(parentMemory.buffer, 16, payload.length)).toEqual(payload);
      expect(child.child_pipe!(0, CHILD_FINAL_SIGNAL)).toBe(-3);
    }
  } finally { f.dispose(); }
});

for (const bridge of ["native", "slots"] as const) test(`inherited worker ${bridge} writes report EPIPE without raising SIGPIPE or selecting an outcome`, () => {
  const f = fixture();
  try {
    const outgoing = f.parent.pipe(f.pid, FROM_WORKER);
    const selfWrite = f.child.pipe(0, FROM_WORKER);
    expect(f.parent.close(outgoing)).toBe(0);
    const expected = { code: "EPIPE", errno: -32, syscall: "write" };
    if (bridge === "native") {
      const child = f.child.engineNet().natives;
      expect(child.hostWrite!(selfWrite, payload)).toBe(-1);
      expect(JSON.parse(child.hostError!(selfWrite) as string)).toMatchObject(expected);
    } else {
      const memory = new WebAssembly.Memory({ initial: 1 });
      f.child.attach(memory);
      const child = f.child.slots();
      new Uint8Array(memory.buffer, 0, payload.length).set(payload);
      expect(child.write!(selfWrite, 0, payload.length)).toBe(-1);
      const length = child.error!(selfWrite, 32, 1024);
      expect(length).toBeGreaterThan(0);
      expect(JSON.parse(new TextDecoder().decode(new Uint8Array(memory.buffer, 32, length)))).toMatchObject(expected);
    }
    expect(f.defaults).toEqual([]);
    expect(f.child.signal(0, 0)).toBe(0);
    expect(readOutcome(outcomeWord(f.transport.outcome))).toBeNull();
    childTransport(f.transport).finish(23);
    expect(f.parent.wait(f.pid)).toBe(23);
    expect(f.parent.pipe(f.pid, CHILD_FINAL_SIGNAL)).toBe(0);
  } finally { f.dispose(); }
});

test("fatal current outcome denies inherited worker I/O and preserves handled pending state", () => {
  const f = fixture();
  try {
    const to = f.parent.pipe(f.pid, TO_WORKER);
    const selfRead = f.child.pipe(0, TO_WORKER);
    const selfWrite = f.child.pipe(0, FROM_WORKER);
    f.parent.write(to, payload);
    f.child.signal(13, 2);
    f.child.signal(13, 3);
    claimOutcome(outcomeWord(f.transport.outcome), { kind: "signaled", code: 9 });
    expect(f.child.read(selfRead)).toBe(-1);
    expect(f.child.write(selfWrite, payload)).toBe(-1);
    expect(f.child.close(selfRead)).toBe(-1);
    expect(f.child.pipe(0, TO_WORKER)).toBe(-1);
    expect(f.defaults).toEqual([9, 9, 9, 9]);
    expect(takeSignal(createSignalState(f.transport.signalState))).toBe(13);
    expect(new SharedPipe(f.transport.pipes[3], f.transport.budget).read()).toEqual(payload);
    expect(new SharedPipe(f.transport.pipes[4], f.transport.budget).read()).toBe(-2);
  } finally { f.dispose(); }
});

test("nested workers retain shared identities, budget, fresh signals, and revoked-parent authority", () => {
  const f = fixture();
  try {
    const pid = f.child.spawn(command());
    expect(pid).toBeGreaterThan(0);
    const nested = f.child.children.get(pid)!.transport;
    expect(nested.pid).not.toBe(f.pid);
    expect(nested.parentPid).toBe(f.pid);
    expect(nested.identity).toBe(f.transport.identity);
    expect(nested.budget).toBe(f.transport.budget);
    expect(nested.signalState).not.toBe(f.transport.signalState);
    expect(nested.pipes).toHaveLength(5);
    f.parent.kill(f.pid, 9);
    expect(f.child.spawn(command())).toBe(-1);
    expect(f.child.kill(pid, 9)).toBe(-1);
    expect(readOutcome(outcomeWord(nested.outcome))).toBeNull();
    f.child.dispose();
    expect(readOutcome(outcomeWord(nested.outcome))).toEqual({ kind: "signaled", code: 9, status: 137 });
  } finally { f.dispose(); }
});

test("worker allocation counts both channel handles and cannot enter inherited-handle space", () => {
  const f = fixture();
  try {
    f.child.nextHandle = 0x7fff0000 - 4;
    expect(f.child.spawn(command())).toBe(-1);
    expect(JSON.parse(f.child.lastError!).code).toBe("EAGAIN");
    expect(f.child.children.size).toBe(0);
    expect(f.child.read(f.child.pipe(0, TO_WORKER))).toBe(-2);
    expect(f.child.write(f.child.pipe(0, FROM_WORKER), payload)).toBe(payload.length);
    expect(f.parent.read(f.parent.pipe(f.pid, FROM_WORKER))).toEqual(payload);
  } finally { f.dispose(); }
});
