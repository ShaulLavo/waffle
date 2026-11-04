import { expect, test } from "bun:test";
import { GuestTerminal, guestProcExit, enterGuest, type GuestReport } from "../thread/entry.ts";
import {
  outcomeWord,
  claimOutcome,
  markStarted,
  readOutcome,
  serializeOutcome,
  processOutcome,
} from "../proc/outcome.ts";
import { ProcessSignalExit } from "../proc/abi.ts";
import { lifecycleModule } from "./threads-lifecycle-module.ts";
import { serviceFixture } from "./threads-service-fixture.ts";
import { shareFileResource, claimFileOffset } from "../core/open-file.ts";
import {
  retireRequestMemory,
  requestMemoryRetired,
  waitForFilesystemTransportRetirement,
} from "../fs/request-memory.ts";
import { createProcessFilesystemIdentity, wake } from "../fs/protocol.ts";

function terminalFixture() {
  const outcome = outcomeWord();
  const reports: GuestReport[] = [];
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const terminal = new GuestTerminal({
    thread: { directory: "test", pid: 1, tid: 1 },
    outcome,
    signal,
    report: (report) => reports.push(report),
  });
  return { outcome, reports, signal, terminal };
}
function instantiate(
  module: WebAssembly.Module,
  memory: WebAssembly.Memory,
  terminal: GuestTerminal,
) {
  return new WebAssembly.Instance(module, {
    env: { memory },
    fixture: { parked: () => {} },
    wasi_snapshot_preview1: { proc_exit: (code: number) => guestProcExit(code, terminal) },
  });
}

test("child proc_exit zero selects the process outcome without waiting for a parked initial guest", async () => {
  const value = await serviceFixture();
  const terminal = terminalFixture();
  const worker = new Worker(new URL("./threads-lifecycle-waiter.ts", import.meta.url).href);
  const parked = Promise.withResolvers<void>();
  const idle = Promise.withResolvers<void>();
  worker.onmessage = ({ data }: MessageEvent<{ kind: string }>) => {
    if (data.kind === "parked") parked.resolve();
    if (data.kind === "host-idle") idle.resolve();
  };
  worker.onerror = (error) => {
    parked.reject(error);
    idle.reject(error);
  };
  try {
    worker.postMessage({
      module: lifecycleModule("wait64"),
      memory: value.memory,
      outcome: serializeOutcome(terminal.outcome),
      signal: terminal.signal,
    });
    await parked.promise;
    const readFd = value.descriptors.open(value.reader, 0x1fffffffn, 0n);
    const read = value.service.submit(value.call(2), {
      kind: "read",
      fd: readFd,
      spans: [{ address: 64, length: 3 }],
    });
    new Uint8Array(value.memory.buffer, 80, 3).set([79, 85, 84]);
    expect(
      await value.service.submit(value.call(3), {
        kind: "write",
        fd: value.writerFd,
        spans: [{ address: 80, length: 3 }],
      }),
    ).toEqual({ kind: "ok", value: 3 });
    expect(await read).toEqual({ kind: "ok", value: 3 });
    const waitingSibling = value.service.submit(value.call(2), {
      kind: "read",
      fd: readFd,
      spans: [{ address: 96, length: 1 }],
    });
    await enterGuest({ kind: "secondary", tid: 1, startArg: 0 }, terminal.terminal, () =>
      instantiate(lifecycleModule("exit"), value.memory, terminal.terminal),
    );
    expect(readOutcome(terminal.outcome)).toEqual({ kind: "exited", code: 0, status: 0 });
    expect(value.descriptors.get(value.writerFd)).toBeDefined();
    expect(new Uint8Array(value.memory.buffer, 64, 3)).toEqual(new Uint8Array([79, 85, 84]));
    let disposals = 0;
    const canonical = value.wasi;
    const dropWatches = canonical.dropWatches.bind(canonical);
    canonical.dropWatches = () => {
      disposals++;
      dropWatches();
    };
    expect(() => value.service.disposeCanonical({ directory: "test", pid: 1 }, canonical)).toThrow(
      "premature",
    );
    const receipt = await value.service.quiesce();
    expect(await waitingSibling).toEqual({ kind: "error", errno: 11 });
    expect(requestMemoryRetired(value.pair.client.requests)).toBe(true);
    value.service.disposeCanonical(receipt, canonical);
    value.service.disposeCanonical(receipt, canonical);
    expect(disposals).toBe(1);
    expect(value.descriptors.get(value.writerFd)).toBeUndefined();
  } finally {
    const word = new BigInt64Array(value.memory.buffer);
    Atomics.store(word, 0, 1n);
    Atomics.notify(word, 0);
    await idle.promise;
    worker.terminate();
    await value.dispose();
  }
});

for (const first of ["exit", "kill"] as const) {
  test(`terminal CAS preserves ${first} as the winner`, async () => {
    const value = terminalFixture();
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
    markStarted(value.outcome);
    if (first === "kill") claimOutcome(value.outcome, { kind: "signaled", code: 9 });
    await enterGuest({ kind: "secondary", tid: 1, startArg: 0 }, value.terminal, () =>
      instantiate(lifecycleModule("exit"), memory, value.terminal),
    );
    const result = claimOutcome(value.outcome, { kind: "signaled", code: 9 });
    expect(result).toEqual(
      first === "exit"
        ? { kind: "exited", code: 0, status: 0 }
        : { kind: "signaled", code: 9, status: 137 },
    );
    expect(value.reports.at(-1)?.kind).toBe("host-idle");
  });
}

test("secondary return leaves process services and the canonical descriptor owner alive", async () => {
  const value = await serviceFixture();
  const terminal = terminalFixture();
  try {
    markStarted(terminal.outcome);
    await enterGuest({ kind: "secondary", tid: 1, startArg: 7 }, terminal.terminal, () =>
      instantiate(lifecycleModule(), value.memory, terminal.terminal),
    );
    expect(terminal.reports.map((report) => report.kind)).toEqual(["thread-returned", "host-idle"]);
    expect(readOutcome(terminal.outcome)).toBeNull();
    expect(value.descriptors.get(value.writerFd)).toBeDefined();
    new Uint8Array(value.memory.buffer, 64, 1)[0] = 81;
    expect(
      await value.service.submit(value.call(), {
        kind: "write",
        fd: value.writerFd,
        spans: [{ address: 64, length: 1 }],
      }),
    ).toEqual({ kind: "ok", value: 1 });
    const watch = await value.client.watch(await value.client.asyncCall("preopen", ["/"]));
    await watch.close();
  } finally {
    await value.dispose();
  }
});

for (const kind of ["initial", "secondary"] as const) {
  test(`${kind} start-section exit does not enter a later export`, async () => {
    const value = terminalFixture();
    if (kind === "secondary") markStarted(value.outcome);
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
    const entry = kind === "initial" ? { kind } : { kind, tid: 1, startArg: 0 };
    await enterGuest(entry, value.terminal, () =>
      instantiate(lifecycleModule("exit", true), memory, value.terminal),
    );
    expect(readOutcome(value.outcome)).toEqual({ kind: "exited", code: 0, status: 0 });
    expect(value.reports.some((report) => report.kind === "thread-returned")).toBe(false);
  });
}

test("terminal cancellation retains the offset and FD pin until remote cold preparation retires", async () => {
  const value = await serviceFixture();
  try {
    const description = value.descriptors.get(value.fd)!.description;
    const pending = value.service.submit(value.call(), {
      kind: "read",
      fd: value.fd,
      spans: [{ address: 64, length: 3 }],
    });
    await value.event("held");
    const offset = shareFileResource(value.resource, value.pair.client);
    let fenced = false;
    const safety = value.service.quiesce().then((receipt) => {
      fenced = true;
      return receipt;
    });
    await value.service.submit(value.call(2), { kind: "close", fd: value.fd });
    expect(fenced).toBe(false);
    expect(Atomics.load(new Int32Array(offset), 0)).toBe(value.pair.client.owner);
    expect(
      Atomics.load(new Int32Array(value.pair.client.ownerStates), value.pair.client.owner),
    ).toBe(1);
    expect(requestMemoryRetired(value.pair.client.requests)).toBe(false);
    expect(description.references).toBe(2);
    value.send({ kind: "release" });
    expect(await pending).toEqual({ kind: "error", errno: 11 });
    await safety;
    expect(Atomics.load(new Int32Array(offset), 0)).toBe(0);
    expect(value.resource.offset).toBe(0);
    expect(new Uint8Array(value.memory.buffer, 64, 3)).toEqual(new Uint8Array(3));
    expect(description.references).toBe(1);
    expect(
      Atomics.load(new Int32Array(value.pair.client.ownerStates), value.pair.client.owner),
    ).toBe(2);
  } finally {
    await value.dispose();
  }
});

test("foreign offset contention cannot park sibling calls or terminal drain", async () => {
  const value = await serviceFixture();
  try {
    const offset = shareFileResource(value.resource, value.pair.client);
    const foreign = createProcessFilesystemIdentity(value.pair.client);
    const resource = { ...value.resource };
    shareFileResource(resource, foreign, offset);
    const claim = claimFileOffset(resource);
    if (claim.kind !== "acquired") throw new Error("foreign cursor was not acquired");
    try {
      const pending = value.service.submit(value.call(), { kind: "tell", fd: value.fd });
      expect(
        await value.service.submit(value.call(2), {
          kind: "write",
          fd: value.writerFd,
          spans: [{ address: 64, length: 1 }],
        }),
      ).toEqual({ kind: "ok", value: 1 });
      await value.service.quiesce();
      expect(await pending).toEqual({ kind: "error", errno: 11 });
      expect(Atomics.load(new Int32Array(offset), 0)).toBe(foreign.owner);
    } finally {
      claim.lease.release();
    }
  } finally {
    await value.dispose();
  }
});

test("failed transport retirement cannot become a successful service safety receipt", async () => {
  const value = await serviceFixture();
  try {
    const pending = value.service.submit(value.call(), {
      kind: "read",
      fd: value.fd,
      spans: [{ address: 64, length: 3 }],
    });
    await value.event("held");
    retireRequestMemory(value.pair.client.requests, 29);
    wake(value.pair.client);
    void pending.catch(() => {});
    const safety = value.service.quiesce();
    const failure = await safety.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const result = await pending.catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    await expect(waitForFilesystemTransportRetirement(value.pair.client)).rejects.toThrow();
    expect(value.descriptors.get(value.fd)!.description.references).toBe(2);
    expect(
      Atomics.load(new Int32Array(value.pair.client.ownerStates), value.pair.client.owner),
    ).not.toBe(2);
  } finally {
    value.send({ kind: "release" });
    const cleanup = await value.dispose().catch((error: unknown) => error);
    expect(cleanup).toBeInstanceOf(Error);
  }
});

test("entry catches explicit signals without changing the process outcome", async () => {
  const value = terminalFixture();
  markStarted(value.outcome);
  await enterGuest({ kind: "secondary", tid: 1, startArg: 0 }, value.terminal, () => {
    throw new ProcessSignalExit(9);
  });
  expect(readOutcome(value.outcome)).toEqual(processOutcome({ kind: "signaled", code: 9 }));
});

test("canonical disposal failure is sticky and cannot replace the terminal winner", async () => {
  const value = await serviceFixture();
  const terminal = terminalFixture();
  try {
    const winner = terminal.terminal.claim(processOutcome({ kind: "exited", code: 0 }));
    const receipt = await value.service.quiesce();
    let closes = 0;
    const fd = value.descriptors.open(
      {
        kind: "device",
        device: "null",
        read: () => 0,
        write: () => 0,
        readiness: () => ({ readable: true, writable: true, hangup: false }),
      },
      0n,
      0n,
      () => {
        closes++;
        throw new Error("release failed");
      },
    );
    expect(() => value.service.disposeCanonical(receipt, value.wasi)).toThrow("canonical disposal");
    expect(() => value.service.disposeCanonical(receipt, value.wasi)).toThrow("canonical disposal");
    expect(value.descriptors.get(fd)).toBeUndefined();
    expect(closes).toBe(1);
    expect(readOutcome(terminal.outcome)).toEqual(winner);
  } finally {
    await value.dispose();
  }
});

for (const kind of ["initial", "secondary"] as const) {
  test(`${kind} unexpected instantiation failure has the right process phase`, async () => {
    const value = terminalFixture();
    if (kind === "secondary") markStarted(value.outcome);
    await enterGuest(
      kind === "initial" ? { kind } : { kind, tid: 1, startArg: 0 },
      value.terminal,
      () => {
        throw new WebAssembly.RuntimeError("startup trap");
      },
    );
    expect(readOutcome(value.outcome)).toEqual(
      kind === "initial"
        ? { kind: "start-failed", code: 5, status: null, error: "EIO" }
        : { kind: "exited", code: 1, status: 1 },
    );
    expect(value.reports.at(-1)?.kind).toBe("host-idle");
  });
}

test("a closed control route cannot erase normalized proc_exit or its terminal wake", () => {
  const outcome = outcomeWord();
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const terminal = new GuestTerminal({
    thread: { directory: "test", pid: 1, tid: 1 },
    outcome,
    signal,
    report: () => {
      throw new Error("closed control route");
    },
  });
  expect(() => guestProcExit(-1, terminal)).toThrow("exit 255");
  expect(readOutcome(outcome)).toEqual({ kind: "exited", code: 255, status: 255 });
  expect(Atomics.load(signal, 0)).toBeGreaterThan(0);
});

test("concurrent guest exit and SIGKILL retain the same atomic winner", async () => {
  const value = terminalFixture();
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const workers: Worker[] = [];
  const ready: Promise<void>[] = [];
  const done: Promise<void>[] = [];
  try {
    for (const role of ["exit", "kill"] as const) {
      const participant = raceParticipant({
        role,
        memory,
        outcome: serializeOutcome(value.outcome),
        signal: value.signal,
        gate,
      });
      workers.push(participant.worker);
      ready.push(participant.ready);
      done.push(participant.done);
    }
    await Promise.all(ready);
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    await Promise.all(done);
    const winner = readOutcome(value.outcome);
    expect(winner).not.toBeNull();
    expect(claimOutcome(value.outcome, { kind: "exited", code: 17 })).toEqual(winner!);
    expect(claimOutcome(value.outcome, { kind: "signaled", code: 9 })).toEqual(winner!);
    expect(winner!.kind === "signaled" ? winner!.code === 9 : winner!.code === 0).toBe(true);
  } finally {
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
    for (const worker of workers) worker.terminate();
  }
});

function raceParticipant(input: {
  role: "exit" | "kill";
  memory: WebAssembly.Memory;
  outcome: ReturnType<typeof serializeOutcome>;
  signal: Int32Array;
  gate: Int32Array;
}) {
  const worker = new Worker(new URL("./threads-lifecycle-waiter.ts", import.meta.url).href);
  const started = Promise.withResolvers<void>();
  const idle = Promise.withResolvers<void>();
  worker.onmessage = ({ data }: MessageEvent<{ kind: string }>) => {
    if (data.kind === "race-ready") started.resolve();
    if (data.kind === "host-idle") idle.resolve();
  };
  worker.onerror = (error) => {
    started.reject(error);
    idle.reject(error);
  };
  worker.postMessage({
    module: lifecycleModule("exit"),
    memory: input.memory,
    outcome: input.outcome,
    signal: input.signal,
    race: { gate: input.gate, role: input.role },
  });
  return { worker, ready: started.promise, done: idle.promise };
}
