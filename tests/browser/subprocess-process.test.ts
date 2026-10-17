import { expect, spyOn, test } from "bun:test";
import { CHILD_FINAL_SIGNAL, SubprocessHost, childTransport, type ChildTransport } from "../src/subprocess.ts";
import { claimOutcome, outcomeWord, readOutcome } from "../../runtime/proc/outcome.ts";
import { createSignalState, setSignalDisposition, SignalDisposition } from "../../runtime/proc/signals.ts";

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
  return { host, launched, events };
}

const command = (executable = "fixture") => JSON.stringify({ argv: [executable, "argument"], executable });

test("first spawn reserves an arbitrary executable without waiting for activation", () => {
  const { host, launched } = fixture();
  try {
    const pid = host.spawn(command("/tools/fixture.wasm"));
    expect(pid).toBeGreaterThan(1);
    expect(launched[0]?.pid).toBe(pid);
    expect(launched[0]?.parentPid).toBe(1);
    expect(host.wait(pid)).toBe(-2);
  } finally { host.dispose(); }
});

test("nested stubs share globally unique process ids and never reuse signal buffers", () => {
  const { host, launched } = fixture();
  const first = host.spawn(command());
  const parent = launched[0]!;
  let nestedTransport: ChildTransport | undefined;
  const nested = new SubprocessHost({
    budget: parent.budget, slot: parent.slot, token: parent.token,
    identity: parent.identity, pid: parent.pid, jobId: parent.jobId,
    output() {}, launch(_meta, transport) { nestedTransport = transport; return { terminate() {} }; },
  });
  try {
    const descendant = nested.spawn(command());
    expect(descendant).not.toBe(first);
    expect(nestedTransport?.parentPid).toBe(first);
    expect(nestedTransport?.jobId).toBe(parent.jobId);
    host.kill(first, 9);
    const replacement = host.spawn(command());
    expect(replacement).not.toBe(first);
    expect(launched[1]?.interrupt).not.toBe(parent.interrupt);
    expect(launched[1]?.requestedSignal).not.toBe(parent.requestedSignal);
    expect(launched[1]?.signalState).not.toBe(parent.signalState);
    expect(launched[1]?.outcome).not.toBe(parent.outcome);
  } finally { nested.dispose(); host.dispose(); }
});

test("an atomically won own exit rejects a concurrent late SIGKILL before completion publication", () => {
  const { host, launched, events } = fixture();
  try {
    const pid = host.spawn(command());
    const transport = launched[0]!;
    expect(transport.outcome.byteLength).toBe(8);
    claimOutcome(outcomeWord(transport.outcome), { kind: "exited", code: 126 });
    expect(host.wait(pid)).toBe(-2);
    expect(host.kill(pid, 9)).toBe(0);
    expect(Atomics.load(new Int32Array(transport.requestedSignal), 0)).toBe(0);
    expect(Atomics.load(new Int32Array(transport.interrupt), 0)).toBe(0);
    expect(events).toEqual([]);
    childTransport(transport).finish(0);
    expect(host.wait(pid)).toBe(126);
    expect(readOutcome(outcomeWord(transport.outcome))).toEqual({ kind: "exited", code: 126, status: 126 });
  } finally { host.dispose(); }
});

for (const signal of [undefined, 15]) test(`transport preserves explicit signal kind ${signal ?? "own exit"} for status 143`, () => {
  const { host, launched } = fixture();
  try {
    const pid = host.spawn(command());
    const transport = launched[0]!;
    childTransport(transport).finish(143, signal);
    expect(host.wait(pid)).toBe(143);
    expect(readOutcome(outcomeWord(transport.outcome))).toEqual(signal === undefined
      ? { kind: "exited", code: 143, status: 143 }
      : { kind: "signaled", code: 15, status: 143 });
  } finally { host.dispose(); }
});

test("a winning SIGKILL is adopted before its pending signal or completion header is published", () => {
  const { host, launched } = fixture();
  try {
    const pid = host.spawn(command());
    const transport = launched[0]!;
    claimOutcome(outcomeWord(transport.outcome), { kind: "signaled", code: 9 });
    expect(Atomics.load(new Int32Array(transport.requestedSignal), 0)).toBe(0);
    expect(Atomics.load(new Int32Array(transport.interrupt), 0)).toBe(0);
    expect(host.wait(pid)).toBe(-2);
    childTransport(transport).finish(126);
    expect(host.wait(pid)).toBe(137);
    expect(readOutcome(outcomeWord(transport.outcome))).toEqual({ kind: "signaled", code: 9, status: 137 });
  } finally { host.dispose(); }
});

test("SIGKILL revokes before termination and wins over a late success", () => {
  const { host, launched, events } = fixture();
  try {
    const pid = host.spawn(command());
    expect(host.kill(pid, 9)).toBe(0);
    expect(events.slice(0, 2)).toEqual(["revoke", "terminate"]);
    expect(Atomics.load(new Int32Array(launched[0]!.interrupt), 0)).toBe(9);
    childTransport(launched[0]!).finish(0);
    expect(host.wait(pid)).toBe(137);
  } finally { host.dispose(); }
});

test.each([2, 13, 15])("handled signal %i notifies without destroying descriptors or overriding the guest exit", (signal) => {
  const { host, launched, events } = fixture();
  try {
    const pid = host.spawn(command());
    setSignalDisposition(createSignalState(launched[0]!.signalState), signal, SignalDisposition.HANDLE);
    expect(host.kill(pid, signal)).toBe(0);
    expect(events).toEqual([]);
    expect(host.wait(pid)).toBe(-2);
    expect(Atomics.exchange(new Int32Array(launched[0]!.interrupt), 0, 0)).toBe(signal);
    childTransport(launched[0]!).finish(23);
    expect(host.wait(pid)).toBe(23);
  } finally { host.dispose(); }
});

test("a concurrent supervisor SIGKILL cannot be downgraded while publishing a catchable interrupt", () => {
  const { host, launched } = fixture();
  const pid = host.spawn(command());
  const transport = launched[0]!;
  setSignalDisposition(createSignalState(transport.signalState), 15, SignalDisposition.HANDLE);
  const requested = new Int32Array(transport.requestedSignal);
  const interrupt = new Int32Array(transport.interrupt);
  const compareExchange = Atomics.compareExchange;
  let injected = false;
  const publication = spyOn(Atomics, "compareExchange").mockImplementation((array, index, expected, replacement) => {
    const previous = Reflect.apply(compareExchange, Atomics, [array, index, expected, replacement]);
    if (!injected && array.buffer === transport.requestedSignal && Number(replacement) === 15) {
      injected = true;
      // The page wins SIGKILL after the stub's requested-signal CAS but before its interrupt write.
      claimOutcome(outcomeWord(transport.outcome), { kind: "signaled", code: 9 });
      Atomics.store(requested, 0, 9);
      Atomics.store(interrupt, 0, 9);
      childTransport(transport).finish(137);
    }
    return previous;
  });
  try {
    expect(host.kill(pid, 15)).toBe(0);
    expect(injected).toBe(true);
    expect(Atomics.load(requested, 0)).toBe(9);
    expect(Atomics.load(interrupt, 0)).toBe(9);
    expect(host.wait(pid)).toBe(137);
  } finally { publication.mockRestore(); host.dispose(); }
});

test("invalid executable metadata is rejected before launch", () => {
  const { host, launched } = fixture();
  try {
    for (const executable of ["", "bad\0path", 4, null]) expect(host.spawn(JSON.stringify({ executable, argv: ["fixture"] }))).toBe(-1);
    expect(launched).toHaveLength(0);
  } finally { host.dispose(); }
});

test("SIGKILL closes transport endpoints before physical termination", () => {
  let writesAtTerminate: number[] | undefined;
  const host = new SubprocessHost({ output() {}, launch(_meta, transport) {
    return { terminate() {
      const child = childTransport(transport);
      writesAtTerminate = [child.stdin.write(new Uint8Array([1])), child.stdout.write(new Uint8Array([1]))];
    } };
  } });
  try {
    const pid = host.spawn(command());
    host.kill(pid, 9);
    expect(writesAtTerminate).toEqual([-1, -1]);
  } finally { host.dispose(); }
});

test("new job ids are separate from inherited job identity and survive parent detach", () => {
  const { host, launched, events } = fixture();
  try {
    const first = host.spawn(JSON.stringify({ argv: ["fixture"], job: -1 }));
    const second = host.spawn(JSON.stringify({ argv: ["fixture"], job: 0 }));
    expect(launched[0]?.jobId).toBeGreaterThan(1);
    expect(launched[1]?.jobId).not.toBe(launched[0]?.jobId);
    expect(first).not.toBe(second);
    host.detach();
    expect(events).toEqual([]);
    expect(host.wait(first)).toBe(-1);
    expect(host.wait(second)).toBe(-1);
    expect(readOutcome(outcomeWord(launched[0]!.outcome))).toBeNull();
    expect(readOutcome(outcomeWord(launched[1]!.outcome))).toBeNull();
  } finally { host.dispose(); }
});

test("a previously recorded SIGKILL cannot be replaced by a catchable signal", () => {
  const { host, launched } = fixture();
  try {
    const pid = host.spawn(command());
    claimOutcome(outcomeWord(launched[0]!.outcome), { kind: "signaled", code: 9 });
    Atomics.store(new Int32Array(launched[0]!.requestedSignal), 0, 9);
    host.kill(pid, 15);
    expect(Atomics.load(new Int32Array(launched[0]!.requestedSignal), 0)).toBe(9);
    expect(host.wait(pid)).toBe(137);
  } finally { host.dispose(); }
});

for (const bridge of ["engine", "slots"]) test(`network handle 2 cannot close a running child on the ${bridge} bridge`, () => {
  const { host, launched, events } = fixture();
  const networkClosed: number[] = [];
  try {
    const pid = host.spawn(command());
    expect(launched[0]?.pid).toBe(pid);
    const close = (id: number) => { networkClosed.push(id); return 0; };
    if (bridge === "engine") {
      const net = host.engineNet({ natives: { hostClose: close }, caps: {}, onNews() {} });
      expect(net.natives.hostClose(2)).toBe(0);
    } else expect(host.slots({ close }).close?.(2)).toBe(0);
    expect(networkClosed).toEqual([2]);
    expect(host.wait(pid)).toBe(-2);
    expect(events).toEqual([]);
  } finally { host.dispose(); }
});

test("orphan background completion releases capacity after its parent detaches", () => {
  const { host, launched } = fixture();
  const detached: SubprocessHost[] = [];
  try {
    for (let iteration = 0; iteration < 8; iteration++) {
      const parentPid = host.spawn(command());
      expect(parentPid).toBeGreaterThan(1);
      const parent = launched.at(-1)!;
      let orphan: ChildTransport | undefined;
      const nested = new SubprocessHost({
        budget: parent.budget, identity: parent.identity, pid: parent.pid, jobId: parent.jobId,
        slot: parent.slot, token: parent.token, output() {},
        launch(_meta, transport) { orphan = transport; return { terminate() {} }; },
      });
      detached.push(nested);
      expect(nested.spawn(JSON.stringify({ argv: ["fixture"], job: -1 }))).toBeGreaterThan(1);
      nested.detach();
      childTransport(parent).finish(0);
      expect(host.wait(parentPid)).toBe(0);
      host.close(parentPid);
      // Only the supervisor sees this finish: the dead parent can never run wait/reap.
      childTransport(orphan!).finish(0);
    }
  } finally { for (const nested of detached) nested.dispose(); host.dispose(); }
});

for (const state of ["detached root", "revoked root", "detached parent", "killed parent"]) {
  for (const signal of [15, 9, "close", "wait"] as const) test(`${state} cannot publish child control ${signal}`, () => {
    const root = fixture();
    const launched: ChildTransport[] = [];
    const events: string[] = [];
    let revoked = false;
    let parent: ChildTransport | undefined;
    if (state.endsWith("parent")) { root.host.spawn(command()); parent = root.launched[0]!; }
    const host = new SubprocessHost({
      budget: parent?.budget, identity: parent?.identity, pid: parent?.pid, jobId: parent?.jobId,
      slot: parent?.slot, token: parent?.token, revoked: () => revoked, output() {},
      onChildClose() { events.push("close"); },
      launch(_meta, transport) {
        launched.push(transport);
        return { revoke() { events.push("revoke"); }, terminate() { events.push("terminate"); } };
      },
    });
    try {
      const pid = host.spawn(JSON.stringify({ argv: ["fixture"], job: -1 }));
      expect(pid).toBeGreaterThan(0);
      const background = launched[0]!;
      if (state === "killed parent") root.host.kill(parent!.pid, 9);
      else if (state === "revoked root") revoked = true;
      else host.detach();
      const result = signal === "close" ? host.close(pid) : signal === "wait" ? host.wait(pid) : host.kill(pid, signal);
      expect(result).toBeLessThan(0);
      expect(readOutcome(outcomeWord(background.outcome))).toBeNull();
      expect(Atomics.load(new Int32Array(background.requestedSignal), 0)).toBe(0);
      expect(Atomics.load(new Int32Array(background.interrupt), 0)).toBe(0);
      expect(host.wait(pid)).toBe(-1);
      expect(Atomics.load(new Int32Array(background.control), 0)).toBe(0);
      expect(events).toEqual([]);
    } finally { host.dispose(); root.host.dispose(); }
  });
}

test("closing a child reports its real PID once for supervisor metadata cleanup", () => {
  const closed: number[] = [];
  const host = new SubprocessHost({ output() {}, onChildClose: pid => closed.push(pid), launch() { return { terminate() {} }; } });
  try {
    const pid = host.spawn(command());
    expect(pid).toBeGreaterThan(0x60000000);
    host.close(pid);
    expect(closed).toEqual([pid]);
    expect(host.close(pid)).toBe(-3);
    expect(closed).toEqual([pid]);
  } finally { host.dispose(); }
});

test("Bun process id exhaustion cannot overlap pipe handles or leak a capacity slot", () => {
  const { host, launched } = fixture();
  try {
    host.identities.observePid(0x6fffffff);
    expect(host.spawn(command())).toBe(-1);
    expect(launched).toHaveLength(0);
    expect(Array.from(new Int32Array(host.budget).subarray(2))).toEqual([0, 0, 0, 0]);
  } finally { host.dispose(); }
});

for (const [code, signal] of [[143, undefined], [143, 15], [137, undefined], [137, 9]] as const) {
  test(`slot14 final signal distinguishes own exit ${code} from signal ${signal ?? "none"}`, () => {
    const { host, launched } = fixture();
    try {
      const pid = host.spawn(command());
      const transport = launched[0]!;
      const pipe = host.pipe(pid, 1);
      expect(pipe).toBeGreaterThan(0);
      expect(host.pipe(pid, CHILD_FINAL_SIGNAL)).toBe(-2);
      claimOutcome(outcomeWord(transport.outcome), signal === undefined
        ? { kind: "exited", code }
        : { kind: "signaled", code: signal });
      // A selected result is not a completed result until descriptors have been closed.
      expect(host.pipe(pid, CHILD_FINAL_SIGNAL)).toBe(-2);
      childTransport(transport).finish(code, signal);
      expect(host.wait(pid)).toBe(code);
      expect(host.pipe(pid, CHILD_FINAL_SIGNAL)).toBe(signal ?? 0);
      expect(host.slots().child_pipe!(pid, CHILD_FINAL_SIGNAL)).toBe(signal ?? 0);
      expect(host.engineNet().natives!.hostChildPipe!(pid, CHILD_FINAL_SIGNAL)).toBe(signal ?? 0);
      expect(host.pipe(pid, 1)).toBe(pipe);
      expect(host.pipe(pid, 4)).toBe(-3);
      expect(host.pipe(pid + 1, CHILD_FINAL_SIGNAL)).toBe(-3);
    } finally { host.dispose(); }
  });
}

test("a detached root cannot query child terminal metadata", () => {
  const { host, launched } = fixture();
  const pid = host.spawn(command());
  try {
    childTransport(launched[0]!).finish(143);
    host.detach();
    expect(host.pipe(pid, CHILD_FINAL_SIGNAL)).toBe(-1);
    expect(JSON.parse(host.lastError!).code).toBe("ESRCH");
    expect(readOutcome(outcomeWord(launched[0]!.outcome))).toEqual({ kind: "exited", code: 143, status: 143 });
  } finally { host.dispose(); }
});
