import { expect, spyOn, test } from "bun:test";
import { CHILD_FINAL_SIGNAL, SubprocessHost, childTransport, wasiPipe, type ChildTransport } from "../src/subprocess.ts";
import { claimOutcome, outcomeWord, readOutcome } from "../../runtime/proc/outcome.ts";
import { createSignalState, takeSignal } from "../../runtime/proc/signals.ts";
import { SLOT_NAMES, installHostSlots, installHostSlotsViaImport } from "../src/net/trampoline.ts";
import { NetHost } from "../src/net/host.ts";
import { createRing } from "../src/net/ring.ts";

const command = JSON.stringify({ argv: ["fixture"] });

function fixture() {
  const launched: ChildTransport[] = [];
  const events: string[] = [];
  const host = new SubprocessHost({
    output() {},
    launch(_meta, transport) {
      launched.push(transport);
      return { revoke() { events.push("revoke"); }, terminate() { events.push("terminate"); } };
    },
  });
  const pid = host.spawn(command);
  const transport = launched[0]!;
  const defaults: number[] = [];
  const current = new SubprocessHost({
    signalState: transport.signalState, defaultSignal: signal => defaults.push(signal),
    output() {}, launch() { return { terminate() {} }; },
  });
  return { host, pid, transport, current, events, defaults, dispose() { current.dispose(); host.dispose(); } };
}

for (const signal of [2, 15, 13]) test(`unhandled signal ${signal} claims its outcome and closes immediately`, () => {
  const f = fixture();
  try {
    expect(f.transport.signalState.byteLength).toBe(65 * Int32Array.BYTES_PER_ELEMENT);
    expect(Array.from(new Int32Array(f.transport.signalState))).toEqual(new Array(65).fill(0));
    expect(f.host.kill(f.pid, signal)).toBe(0);
    expect(f.host.wait(f.pid)).toBe(128 + signal);
    expect(f.host.pipe(f.pid, CHILD_FINAL_SIGNAL)).toBe(signal);
    expect(f.events.slice(0, 2)).toEqual(["revoke", "terminate"]);
    expect(Atomics.load(new Int32Array(f.transport.control), 3)).toBe(1);
    expect(childTransport(f.transport).stdout.write(new Uint8Array([1]))).toBe(-1);
    childTransport(f.transport).finish(0);
    expect(readOutcome(outcomeWord(f.transport.outcome))).toEqual({ kind: "signaled", code: signal, status: 128 + signal });
  } finally { f.dispose(); }
});

for (const signal of [2, 15, 13]) for (const code of [0, 23, 143]) {
  test(`handled ${signal} preserves ordinary guest exit ${code}`, () => {
    const f = fixture();
    try {
      expect(f.current.signal(signal, 2)).toBe(0);
      expect(f.host.kill(f.pid, signal)).toBe(0);
      expect(f.events).toEqual([]);
      expect(f.host.wait(f.pid)).toBe(-2);
      expect(readOutcome(outcomeWord(f.transport.outcome))).toBeNull();
      expect(f.current.signal(0, 0)).toBe(signal);
      expect(f.current.signal(0, 0)).toBe(0);
      childTransport(f.transport).finish(code);
      expect(f.host.wait(f.pid)).toBe(code);
      expect(f.host.pipe(f.pid, CHILD_FINAL_SIGNAL)).toBe(0);
    } finally { f.dispose(); }
  });
}

test("engine polls preserve the authoritative handled pending set", () => {
  const f = fixture();
  try {
    for (const signal of [2, 15]) {
      expect(f.current.signal(signal, 2)).toBe(0);
      expect(f.host.kill(f.pid, signal)).toBe(0);
    }
    const pending = Array.from(new Int32Array(f.transport.signalState));
    for (let i = 0; i < 3; i++) expect(f.current.signal(0, 4)).toBe(0);
    expect(Array.from(new Int32Array(f.transport.signalState))).toEqual(pending);
    expect(f.current.engineNet().natives.hostSignal!(0, 4)).toBe(0);
    expect(f.current.slots().signal!(0, 4)).toBe(0);
    expect(f.current.signal(0, 0)).toBe(2);
    expect(f.current.signal(0, 0)).toBe(15);
    expect(f.current.signal(0, 0)).toBe(0);
    expect(f.current.signal(2, 4)).toBe(-22);
  } finally { f.dispose(); }
});

for (const disposition of [0, 1]) test(`disposition ${disposition} still sees handled pending after engine polls`, () => {
  const f = fixture();
  try {
    f.current.signal(15, 2);
    f.host.kill(f.pid, 15);
    expect(f.current.signal(0, 4)).toBe(0);
    expect(f.current.signal(15, disposition)).toBe(0);
    expect(f.defaults).toEqual(disposition === 0 ? [15] : []);
    expect(f.current.signal(0, 0)).toBe(0);
  } finally { f.dispose(); }
});

test("removing a pending handler applies the default synchronously and clears pending", () => {
  const f = fixture();
  try {
    f.current.signal(15, 2);
    f.host.kill(f.pid, 15);
    expect(f.defaults).toEqual([]);
    expect(f.current.signal(15, 0)).toBe(0);
    expect(f.defaults).toEqual([15]);
    expect(f.current.signal(0, 0)).toBe(0);
    expect(f.current.signal(15, 0)).toBe(0);
    expect(f.defaults).toEqual([15]);
  } finally { f.dispose(); }
});

test("dequeue clears pending before a once handler restores the default", () => {
  const f = fixture();
  try {
    f.current.signal(15, 2);
    f.host.kill(f.pid, 15);
    expect(f.current.signal(0, 0)).toBe(15);
    expect(f.current.signal(15, 0)).toBe(0);
    expect(f.defaults).toEqual([]);
    expect(f.current.signal(0, 0)).toBe(0);
    f.host.kill(f.pid, 15);
    expect(f.host.wait(f.pid)).toBe(143);
  } finally { f.dispose(); }
});

test("handled pending signals coalesce and dequeue in numeric order", () => {
  const f = fixture();
  try {
    for (const signal of [15, 2, 13]) f.current.signal(signal, 2);
    for (const signal of [15, 13, 2, 15]) f.host.kill(f.pid, signal);
    expect([f.current.signal(0, 0), f.current.signal(0, 0), f.current.signal(0, 0), f.current.signal(0, 0)]).toEqual([2, 13, 15, 0]);
  } finally { f.dispose(); }
});

test("ignored SIGPIPE neither interrupts nor replaces an EPIPE caller's own exit", () => {
  const f = fixture();
  try {
    expect(f.current.signal(13, 1)).toBe(0);
    const sink = f.current.spawn(command);
    const input = f.current.pipe(sink, 0);
    childTransport(f.current.children.get(sink)!.transport).stdin.close();
    const natives = f.current.engineNet().natives;
    expect(natives.hostWrite!(input, new Uint8Array([1]))).toBe(-1);
    expect(JSON.parse(natives.hostError!(input) as string)).toMatchObject({ code: "EPIPE", errno: -32, syscall: "write" });
    expect(f.host.kill(f.pid, 13)).toBe(0);
    expect(Atomics.load(new Int32Array(f.transport.interrupt), 0)).toBe(0);
    expect(readOutcome(outcomeWord(f.transport.outcome))).toBeNull();
    expect(f.current.signal(0, 0)).toBe(0);
    expect(f.events).toEqual([]);
    childTransport(f.transport).finish(23);
    expect(f.host.wait(f.pid)).toBe(23);
    expect(f.host.pipe(f.pid, CHILD_FINAL_SIGNAL)).toBe(0);
  } finally { f.dispose(); }
});

test("ignoring a pending signal consumes it without triggering its default", () => {
  const f = fixture();
  try {
    f.current.signal(13, 2);
    f.host.kill(f.pid, 13);
    expect(f.current.signal(13, 1)).toBe(0);
    expect(f.current.signal(0, 0)).toBe(0);
    expect(f.defaults).toEqual([]);
  } finally { f.dispose(); }
});

for (const signal of [2, 15, 13]) test(`own exit wins a late default signal ${signal} before completion publication`, () => {
  const f = fixture();
  try {
    claimOutcome(outcomeWord(f.transport.outcome), { kind: "exited", code: 143 });
    f.host.kill(f.pid, signal);
    expect(f.events).toEqual([]);
    expect(Atomics.load(new Int32Array(f.transport.requestedSignal), 0)).toBe(0);
    expect(Atomics.load(new Int32Array(f.transport.interrupt), 0)).toBe(0);
    childTransport(f.transport).finish(0);
    expect(f.host.wait(f.pid)).toBe(143);
    expect(f.host.pipe(f.pid, CHILD_FINAL_SIGNAL)).toBe(0);
  } finally { f.dispose(); }
});

test("default outcome is claimed before a broker can observe the requested-signal audit", () => {
  const f = fixture();
  const compareExchange = Atomics.compareExchange;
  let observed = false;
  const publication = spyOn(Atomics, "compareExchange").mockImplementation((array, index, expected, replacement) => {
    const previous = Reflect.apply(compareExchange, Atomics, [array, index, expected, replacement]);
    if (array.buffer === f.transport.requestedSignal && Number(replacement) === 15) {
      observed = true;
      expect(readOutcome(outcomeWord(f.transport.outcome))).toEqual({ kind: "signaled", code: 15, status: 143 });
      childTransport(f.transport).finish(0);
    }
    return previous;
  });
  try {
    f.host.kill(f.pid, 15);
    expect(observed).toBe(true);
    expect(f.host.wait(f.pid)).toBe(143);
    expect(f.host.pipe(f.pid, CHILD_FINAL_SIGNAL)).toBe(15);
  } finally { publication.mockRestore(); f.dispose(); }
});

test("fresh child dispositions do not inherit the parent's or a previous child's handlers", () => {
  const f = fixture();
  try {
    f.current.signal(15, 2);
    f.host.kill(f.pid, 9);
    const next = f.host.spawn(command);
    const transport = f.host.children.get(next)!.transport;
    expect(transport.signalState).not.toBe(f.transport.signalState);
    expect(Array.from(new Int32Array(transport.signalState))).toEqual(new Array(65).fill(0));
    f.host.kill(next, 15);
    expect(f.host.wait(next)).toBe(143);
  } finally { f.dispose(); }
});

test("signal registration validates the frozen ABI including uncatchable SIGKILL", () => {
  const f = fixture();
  try {
    for (const [signal, mode] of [[9, 0], [9, 1], [9, 2], [-1, 0], [65, 2], [2, -1], [2, 4], [0, 1], [0, 3], [-1, 3], [65, 3], [1.5, 2], [1.5, 3], [2, 1.5]]) {
      expect(f.current.signal(signal!, mode!)).toBe(-22);
    }
    expect(f.current.signal(64, 2)).toBe(0);
    expect(f.current.signal(64, 0)).toBe(0);
    expect(f.defaults).toEqual([]);
  } finally { f.dispose(); }
});

test("engine and numeric slot bridges expose the same current-process signal API", () => {
  const f = fixture();
  try {
    const engine = f.current.engineNet();
    expect(engine.caps.signal).toBe(true);
    expect(engine.natives.hostSignal!(15, 2)).toBe(0);
    f.host.kill(f.pid, 15);
    expect(f.current.slots().signal!(0, 0)).toBe(15);
    expect(f.current.slots().signal!(15, 0)).toBe(0);
    expect(f.defaults).toEqual([]);
    expect(SLOT_NAMES.slice(12, 16)).toEqual(["spawn", "child_wait", "child_pipe", "child_kill"]);
    expect(SLOT_NAMES[18]).toBe("signal");
    const memory = new WebAssembly.Memory({ initial: 1 });
    const view = new DataView(memory.buffer);
    view.setUint32(0, 1, true);
    view.setUint32(4, 19, true);
    const instance = { exports: { memory, bun_wasm_host_slots: () => 0 } } as unknown as WebAssembly.Instance;
    const dispatch = installHostSlotsViaImport(instance, f.current.slots())!;
    expect(dispatch(18, [13, 1])).toBe(0);
    expect(new DataView(memory.buffer).getUint32(8 + 4 * 18, true)).toBe(0xffffffff);
  } finally { f.dispose(); }
});

test("table trampolines append signal at slot 18 with both i32 arguments", () => {
  const f = fixture();
  try {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const table = new WebAssembly.Table({ initial: 0, element: "anyfunc" });
    const view = new DataView(memory.buffer);
    view.setUint32(0, 1, true);
    view.setUint32(4, 19, true);
    const instance = { exports: { memory, __indirect_function_table: table, bun_wasm_host_slots: () => 0 } } as unknown as WebAssembly.Instance;
    expect(installHostSlots(instance, { signal: f.current.slots().signal })).toEqual(["signal"]);
    const slot = new DataView(memory.buffer).getUint32(8 + 4 * 18, true);
    const signal = table.get(slot)!;
    expect(signal(15, 2)).toBe(0);
    f.host.kill(f.pid, 15);
    expect(signal(0, 0)).toBe(15);
    expect(signal(9, 2)).toBe(-22);
  } finally { f.dispose(); }
});

test("attaching another current-process host preserves dispositions and pending delivery", () => {
  const f = fixture();
  let attached: SubprocessHost | undefined;
  try {
    f.current.signal(15, 2);
    f.host.kill(f.pid, 15);
    attached = new SubprocessHost({ signalState: f.transport.signalState, output() {}, launch() { return { terminate() {} }; } });
    expect(attached.signal(0, 0)).toBe(15);
    f.host.kill(f.pid, 15);
    expect(f.current.signal(0, 0)).toBe(15);
    expect(f.events).toEqual([]);
  } finally { attached?.dispose(); f.dispose(); }
});

test("pending-to-default callback exceptions escape synchronously rather than becoming EINVAL", () => {
  const f = fixture();
  const stopped = new Error("default signal stopped current process");
  const current = new SubprocessHost({
    signalState: f.transport.signalState,
    defaultSignal() { throw stopped; },
    output() {}, launch() { return { terminate() {} }; },
  });
  try {
    current.signal(15, 2);
    f.host.kill(f.pid, 15);
    expect(() => current.signal(15, 0)).toThrow(stopped);
    expect(current.signal(0, 0)).toBe(0);
  } finally { current.dispose(); f.dispose(); }
});

test("a bare network host does not advertise the subprocess signal capability", () => {
  const net = new NetHost(createRing(), () => {}).engineNet();
  expect(net.caps.signal).toBe(false);
  expect(net.natives.hostSignal).toBeUndefined();
});

for (const signal of [1, 2, 9, 10, 13, 15, 64]) test(`RAISE ${signal} synchronously applies the default typed current outcome`, () => {
  const f = fixture();
  try {
    f.current.options.defaultSignal = raised => {
      f.defaults.push(raised);
      claimOutcome(outcomeWord(f.transport.outcome), { kind: "signaled", code: raised });
    };
    expect(f.current.signal(signal, 3)).toBe(0);
    expect(f.defaults).toEqual([signal]);
    expect(readOutcome(outcomeWord(f.transport.outcome))).toEqual({ kind: "signaled", code: signal, status: 128 + signal });
    childTransport(f.transport).finish(23);
    expect(f.host.wait(f.pid)).toBe(128 + signal);
    expect(f.host.pipe(f.pid, CHILD_FINAL_SIGNAL)).toBe(signal);
  } finally { f.dispose(); }
});

for (const signal of [1, 2, 10, 13, 15, 64]) test(`RAISE ${signal} respects IGNORE and queues HANDLE without changing guest exit`, () => {
  const f = fixture();
  try {
    expect(f.current.signal(signal, 1)).toBe(0);
    expect(f.current.signal(signal, 3)).toBe(0);
    expect(f.current.signal(0, 0)).toBe(0);
    expect(f.defaults).toEqual([]);
    expect(f.current.signal(signal, 2)).toBe(0);
    expect(f.current.signal(signal, 3)).toBe(0);
    expect(f.current.signal(signal, 3)).toBe(0);
    expect(f.current.signal(0, 0)).toBe(signal);
    expect(f.current.signal(0, 0)).toBe(0);
    expect(f.defaults).toEqual([]);
    expect(Atomics.load(new Int32Array(f.transport.requestedSignal), 0)).toBe(0);
    expect(Atomics.load(new Int32Array(f.transport.interrupt), 0)).toBe(0);
    expect(readOutcome(outcomeWord(f.transport.outcome))).toBeNull();
    childTransport(f.transport).finish(143);
    expect(f.host.wait(f.pid)).toBe(143);
    expect(f.host.pipe(f.pid, CHILD_FINAL_SIGNAL)).toBe(0);
  } finally { f.dispose(); }
});

test("RAISE defaults propagate callback exceptions synchronously", () => {
  const f = fixture();
  const stopped = new Error("RAISE stopped current process");
  try {
    f.current.options.defaultSignal = () => { throw stopped; };
    expect(() => f.current.signal(13, 3)).toThrow(stopped);
  } finally { f.dispose(); }
});

test("RAISE works through both native and numeric bridges", () => {
  const f = fixture();
  try {
    const native = f.current.engineNet().natives;
    expect(native.hostSignal!(10, 2)).toBe(0);
    expect(native.hostSignal!(10, 3)).toBe(0);
    expect(f.current.slots().signal!(0, 0)).toBe(10);
    expect(f.current.slots().signal!(10, 3)).toBe(0);
    expect(native.hostSignal!(0, 0)).toBe(10);
    expect(f.defaults).toEqual([]);
  } finally { f.dispose(); }
});

for (const signal of [2, 9, 10, 13, 15]) for (const mode of [0, 4]) test(`preselected fatal ${signal} stops mode ${mode} without consuming a handled pending signal`, () => {
  const f = fixture();
  const stopped = new Error(`fatal checkpoint ${signal}`);
  try {
    f.current.signal(15, 2);
    f.host.kill(f.pid, 15);
    f.current.options.outcome = f.transport.outcome;
    claimOutcome(outcomeWord(f.transport.outcome), { kind: "signaled", code: signal });
    f.current.options.defaultSignal = winner => { f.defaults.push(winner); throw stopped; };
    expect(() => f.current.signal(0, mode)).toThrow(stopped);
    expect(f.defaults).toEqual([signal]);
    expect(takeSignal(createSignalState(f.transport.signalState))).toBe(15);
    childTransport(f.transport).finish(0);
    expect(f.host.wait(f.pid)).toBe(128 + signal);
  } finally { f.dispose(); }
});

for (const mode of [0, 1, 2, 3]) test(`preselected SIGKILL stops mode ${mode} even when the default callback returns`, () => {
  const f = fixture();
  try {
    f.current.signal(13, 2);
    f.current.signal(13, 3);
    f.current.options.outcome = f.transport.outcome;
    claimOutcome(outcomeWord(f.transport.outcome), { kind: "signaled", code: 9 });
    expect(f.current.signal(13, mode)).toBe(0);
    expect(f.defaults).toEqual([9]);
    expect(takeSignal(createSignalState(f.transport.signalState))).toBe(13);
    expect(readOutcome(outcomeWord(f.transport.outcome))).toEqual({ kind: "signaled", code: 9, status: 137 });
  } finally { f.dispose(); }
});

test("fatal checkpoints take precedence over invalid signal arguments", () => {
  const f = fixture();
  try {
    f.current.options.outcome = f.transport.outcome;
    claimOutcome(outcomeWord(f.transport.outcome), { kind: "signaled", code: 15 });
    expect(f.current.signal(0, 3)).toBe(0);
    expect(f.current.signal(65, 0)).toBe(0);
    expect(f.defaults).toEqual([15, 15]);
  } finally { f.dispose(); }
});

for (const bridge of ["native", "slots"]) test(`the ${bridge} signal bridge observes the existing fatal outcome at entry`, () => {
  const f = fixture();
  const stopped = new Error("bridge fatal checkpoint");
  try {
    f.current.options.outcome = f.transport.outcome;
    claimOutcome(outcomeWord(f.transport.outcome), { kind: "signaled", code: 2 });
    f.current.options.defaultSignal = winner => { f.defaults.push(winner); throw stopped; };
    const checkpoint = bridge === "native" ? f.current.engineNet().natives.hostSignal! : f.current.slots().signal!;
    expect(() => checkpoint(0, 0)).toThrow(stopped);
    expect(f.defaults).toEqual([2]);
  } finally { f.dispose(); }
});

test("an ordinary own exit is never reinterpreted as a fatal signal checkpoint", () => {
  const f = fixture();
  try {
    f.current.signal(15, 2);
    f.host.kill(f.pid, 15);
    f.current.options.outcome = f.transport.outcome;
    claimOutcome(outcomeWord(f.transport.outcome), { kind: "exited", code: 143 });
    expect(f.current.signal(0, 0)).toBe(15);
    expect(f.defaults).toEqual([]);
    childTransport(f.transport).finish(0);
    expect(f.host.wait(f.pid)).toBe(143);
    expect(f.host.pipe(f.pid, CHILD_FINAL_SIGNAL)).toBe(0);
  } finally { f.dispose(); }
});

test("caught backend EPIPE never automatically raises SIGPIPE even with its default disposition", () => {
  const f = fixture();
  try {
    const sink = f.current.spawn(command);
    const sinkTransport = f.current.children.get(sink)!.transport;
    const pipe = childTransport(sinkTransport).stdin;
    pipe.close();
    const natives = f.current.engineNet().natives;
    const input = f.current.pipe(sink, 0);
    expect(natives.hostWrite!(input, new Uint8Array([1]))).toBe(-1);
    expect(JSON.parse(natives.hostError!(input) as string)).toMatchObject({ code: "EPIPE", errno: -32 });
    expect(wasiPipe(pipe, "write").write([new Uint8Array([1])])).toBe(-64);
    expect(f.defaults).toEqual([]);
    expect(f.current.signal(0, 0)).toBe(0);
    expect(Atomics.load(new Int32Array(f.transport.interrupt), 0)).toBe(0);
    expect(readOutcome(outcomeWord(f.transport.outcome))).toBeNull();
    expect(f.host.wait(f.pid)).toBe(-2);
    childTransport(f.transport).finish(23);
    expect(f.host.wait(f.pid)).toBe(23);
    expect(f.host.pipe(f.pid, CHILD_FINAL_SIGNAL)).toBe(0);
  } finally { f.dispose(); }
});
