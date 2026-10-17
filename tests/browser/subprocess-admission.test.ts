import { expect, test } from "bun:test";
import { SubprocessHost, SharedPipe, childTransport, type ChildTransport } from "../src/subprocess.ts";
import { SLOT_NAMES } from "../src/net/trampoline.ts";
import { claimOutcome, outcomeWord, readOutcome } from "../../runtime/proc/outcome.ts";
import { createSignalState, takeSignal } from "../../runtime/proc/signals.ts";

const command = JSON.stringify({ argv: ["fixture"] });
const bytes = new Uint8Array([1, 2, 3]);

function fixture(inherit = false) {
  const outcome = new SharedArrayBuffer(8);
  const state = createSignalState();
  const stdin = new SharedPipe();
  stdin.write(bytes);
  const events: string[] = [];
  const defaults: number[] = [];
  const launched: ChildTransport[] = [];
  const host = new SubprocessHost({
    outcome, signalState: state.buffer as SharedArrayBuffer, stdin: stdin.buffer,
    defaultSignal(signal) { defaults.push(signal); },
    output() { events.push("output"); },
    launch(_meta, transport) {
      events.push("launch");
      launched.push(transport);
      return { revoke() { events.push("revoke"); }, terminate() { events.push("terminate"); } };
    },
  });
  const pid = host.spawn(JSON.stringify({ argv: ["fixture"], stdout: inherit ? "inherit" : "pipe" }));
  const transport = launched[0]!;
  const input = host.pipe(pid, 0);
  const output = host.pipe(pid, 1);
  childTransport(transport).stdout.write(bytes);
  host.signal(15, 2);
  host.signal(15, 3);
  host.lastError = "preserved error";
  events.length = 0;
  return {
    host, pid, transport, input, output, outcome, state, stdin, events, defaults, launched,
    fatal(signal = 9) { claimOutcome(outcomeWord(outcome), { kind: "signaled", code: signal }); },
    dispose() { host.dispose(); },
  };
}

type Fixture = ReturnType<typeof fixture>;
const rawOperations: { name: string; run(f: Fixture): unknown }[] = [
  { name: "spawn", run: f => f.host.spawn(command) },
  { name: "invalid spawn", run: f => f.host.spawn("invalid metadata") },
  { name: "stdin read", run: f => f.host.read(0) },
  { name: "child pipe read", run: f => f.host.read(f.output) },
  { name: "child pipe write", run: f => f.host.write(f.input, bytes) },
  { name: "pipe close", run: f => f.host.close(f.input) },
  { name: "child close", run: f => f.host.close(f.pid) },
  { name: "wait", run: f => f.host.wait(f.pid) },
  { name: "pipe lookup", run: f => f.host.pipe(f.pid, 0) },
  { name: "final signal lookup", run: f => f.host.pipe(f.pid, 3) },
  { name: "kill", run: f => f.host.kill(f.pid, 9) },
  { name: "poll", run: f => f.host.poll(0) },
];

for (const signal of [9, 15]) for (const operation of rawOperations) {
  test(`fatal ${signal} rejects raw ${operation.name} without acquiring or changing a capability`, () => {
    const f = fixture();
    const pipeHeaders = f.transport.pipes.map(pipe => Array.from(new Int32Array(pipe, 0, 4)));
    const handles = f.host.handles.size;
    try {
      f.fatal(signal);
      expect(operation.run(f)).toBe(-1);
      expect(f.defaults).toEqual([signal]);
      expect(f.events).toEqual([]);
      expect(f.launched).toHaveLength(1);
      expect(f.host.handles.size).toBe(handles);
      expect(f.host.lastError).toBe("preserved error");
      expect(f.transport.pipes.map(pipe => Array.from(new Int32Array(pipe, 0, 4)))).toEqual(pipeHeaders);
      expect(readOutcome(outcomeWord(f.transport.outcome))).toBeNull();
      expect(f.stdin.read()).toEqual(bytes);
      expect(takeSignal(f.state)).toBe(15);
    } finally { f.dispose(); }
  });
}

const networkNatives = [
  "hostFetch", "hostFetchHead", "hostRead", "hostWrite", "hostClose", "hostListen", "hostLocalPort",
  "hostAccept", "hostConnect", "hostError", "hostPeerAddr", "hostShutdown", "hostLocalAddr", "hostCustomNative",
];

for (const name of networkNatives) test(`fatal admission guards merged network native ${name}`, () => {
  const f = fixture();
  const calls: string[] = [];
  try {
    const native = f.host.engineNet({
      natives: Object.fromEntries(networkNatives.map(key => [key, () => { calls.push(key); return 123; }])),
      caps: {}, onNews() {},
    }).natives;
    f.fatal();
    expect(native[name]!(1, bytes)).toBe(-1);
    expect(calls).toEqual([]);
    expect(f.defaults).toEqual([9]);
    expect(f.host.lastError).toBe("preserved error");
    expect(takeSignal(f.state)).toBe(15);
  } finally { f.dispose(); }
});

for (const name of ["hostPoll", "hostSpawn", "hostChildWait", "hostChildPipe", "hostChildKill", "hostRead", "hostWrite", "hostClose", "hostError"]) {
  test(`fatal admission guards own native ${name} before pipe access or metadata`, () => {
    const f = fixture();
    try {
      f.host.pipeErrors.set(f.input, "cached error");
      const native = f.host.engineNet().natives;
      f.fatal(15);
      const args = name === "hostSpawn" ? [command] : name === "hostRead" ? [f.output] : name === "hostPoll" ? [0] : [f.input, bytes];
      expect(Reflect.apply(native[name]!, null, args)).toBe(-1);
      expect(f.defaults).toEqual([15]);
      expect(f.events).toEqual([]);
      expect(takeSignal(f.state)).toBe(15);
    } finally { f.dispose(); }
  });
}

for (const name of SLOT_NAMES) test(`fatal admission guards slot ${name} before memory or network access`, () => {
  const f = fixture();
  const calls: string[] = [];
  try {
    const slots = f.host.slots(Object.fromEntries(SLOT_NAMES.map(key => [key, () => { calls.push(key); return 123; }])));
    f.fatal();
    expect(slots[name]!(1, 0, 4, 4)).toBe(name === "signal" ? 0 : -1);
    expect(calls).toEqual([]);
    expect(f.defaults).toEqual([9]);
    expect(f.host.lastError).toBe("preserved error");
    expect(takeSignal(f.state)).toBe(15);
  } finally { f.dispose(); }
});

for (const name of ["spawn", "read", "write", "error"] as const) test(`fatal ${name} slot does not inspect guest memory for own process handles`, () => {
  const f = fixture();
  try {
    const slots = f.host.slots();
    f.host.pipeErrors.set(f.input, "cached error");
    f.fatal();
    const handle = name === "read" ? f.output : f.input;
    // Deliberately do not attach memory: even decoding a guest pointer is a forbidden capability.
    expect(slots[name]!(handle, 0, 4)).toBe(-1);
    expect(f.defaults).toEqual([9]);
    expect(f.events).toEqual([]);
  } finally { f.dispose(); }
});

test("fatal callbacks escape merged network guards without admitting the underlying function", () => {
  const f = fixture();
  const stopped = new Error("fatal admission stopped guest");
  let called = false;
  try {
    f.host.options.defaultSignal = () => { throw stopped; };
    const native = f.host.engineNet({ natives: { hostFetch() { called = true; return 1; } }, caps: {}, onNews() {} }).natives;
    f.fatal();
    expect(() => native.hostFetch!("request")).toThrow(stopped);
    expect(called).toBe(false);
    expect(takeSignal(f.state)).toBe(15);
  } finally { f.dispose(); }
});

test("the inherited-output watcher stops quietly after a selected fatal outcome", async () => {
  const f = fixture(true);
  let notified = false;
  try {
    f.host.notify = () => { notified = true; };
    f.fatal();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.events).toEqual([]);
    expect(f.defaults).toEqual([]);
    expect(notified).toBe(false);
    expect(f.host.timer).toBeNull();
    expect(childTransport(f.transport).stdout.read()).toEqual(bytes);
    expect(takeSignal(f.state)).toBe(15);
  } finally { f.dispose(); }
});

for (const mode of [0, 1, 2]) test(`alive mode ${mode} preserves network calls and caught EPIPE without a fatal outcome`, () => {
  const f = fixture();
  let networkCalls = 0;
  try {
    f.host.signal(13, mode);
    const native = f.host.engineNet({
      natives: { hostFetch() { networkCalls++; return 123; } }, caps: {}, onNews() {},
    }).natives;
    const slots = f.host.slots({ fetch() { networkCalls++; return 123; } });
    expect(native.hostFetch!("request")).toBe(123);
    expect(slots.fetch!(0, 0, 0, 0)).toBe(123);
    expect(networkCalls).toBe(2);
    childTransport(f.transport).stdin.close();
    expect(native.hostWrite!(f.input, bytes)).toBe(-1);
    expect(JSON.parse(native.hostError!(f.input) as string).code).toBe("EPIPE");
    expect(f.defaults).toEqual([]);
    expect(readOutcome(outcomeWord(f.outcome))).toBeNull();
    childTransport(f.transport).finish(23);
    expect(f.host.wait(f.pid)).toBe(23);
  } finally { f.dispose(); }
});

test("host-owned disposal still tears down children after the current guest is fatal", () => {
  const f = fixture();
  try {
    f.fatal();
    f.host.dispose();
    expect(f.defaults).toEqual([]);
    expect(f.host.children.size).toBe(0);
    expect(f.events.slice(0, 2)).toEqual(["revoke", "terminate"]);
    expect(readOutcome(outcomeWord(f.transport.outcome))).toEqual({ kind: "signaled", code: 9, status: 137 });
  } finally { f.dispose(); }
});
