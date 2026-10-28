import { expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { spawnSync } from "node:child_process";
import { DescriptorTable } from "../core/descriptors.js";
import { BrowserProcessBroker } from "../browser/process-broker.js";
import { createFilesystemIdentity, revokeFilesystem } from "../fs/protocol.js";
import { ProcessIdentityAllocator } from "../proc/identity.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { ProcessTable } from "../proc/table.js";
import { controlLoad, packedControl } from "../proc/control.js";
import { collectDirectoryProcess } from "../proc/directory.js";
import { claimOutcome } from "../proc/outcome.js";
import {
  createWorkerProcessTransport,
  confirmWorkerProcessJob,
  WorkerProcessClient,
  workerProcessState,
  type WorkerProcessTransport,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";
import {
  attachTerminal,
  captureTerminalProcessLifetime,
  claimTerminalAuthority,
  createTerminalInput,
  createTerminalInputPolicy,
  createTerminalSession,
  type TerminalInput,
  type TerminalResult,
  type TerminalContext,
} from "../browser/runtime-terminals.js";

function must<T>(result: TerminalResult<T>): T {
  if (result.kind === "error") throw new Error(result.code);
  return result.value;
}

test("prepared terminal lifetime works with Node WebCrypto", () => {
  const terminals = new URL("../dist/browser/runtime-terminals.js", import.meta.url).href;
  const processes = new URL("../dist/proc/worker-client.js", import.meta.url).href;
  const script = `
    const t = await import(${JSON.stringify(terminals)});
    const p = await import(${JSON.stringify(processes)});
    const process = p.createWorkerProcessTransport({capacity:4});
    const input = t.createTerminalInput();
    const display = t.createTerminalSession({controller:process,geometry:{columns:80,rows:24}});
    const lifetime = t.captureTerminalProcessLifetime({process,terminals:[{identity:display.identity,inputs:[input]}]});
    await lifetime.quiesce();
    display.close('disposed');
    console.log('prepared terminal lifetime passed');
  `;
  const result = spawnSync("node", ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 2000,
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("prepared terminal lifetime passed");
});

function fixture(input: TerminalInput = createTerminalInput()) {
  const root = createWorkerProcessTransport({ capacity: 4 });
  const descriptors = new DescriptorTable();
  const messages: WorkerProcessMessage[] = [];
  let child: WorkerProcessTransport | undefined;
  const unused = (): never => {
    throw new Error("unexpected fd transfer");
  };
  const client = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec: { export: unused, import: unused, discard: unused },
    postMessage(message) {
      messages.push(message);
      if (message.operation === "spawn") child = message.transport;
    },
  });
  function spawn() {
    client.spawn(root.pid, { executable: "/child", argv: [], env: {}, cwd: "/", job: -1, fds: [] });
    if (!child) throw new Error("missing reserved child");
    return child;
  }
  const process = spawn();
  const display = createTerminalSession({ controller: root, geometry: { columns: 80, rows: 24 } });
  const policy = createTerminalInputPolicy({ input });
  const authority = must(
    claimTerminalAuthority({ identity: display.identity, process: root, policy, checkActive() {} }),
  );
  const group = must(authority.createGroup({ initialMode: "raw" }));
  const member = must(authority.admitExisting({ group, pid: process.pid }));
  const lease = must(authority.acquire({ group, expected: null }));
  const lifetime = captureTerminalProcessLifetime({
    process,
    terminals: [{ identity: display.identity, inputs: [input] }],
  });
  const state = workerProcessState(process);
  return {
    root,
    process,
    input,
    display,
    policy,
    authority,
    lifetime,
    state,
    spawn,
    messages,
    context: member.context,
    restore() {
      const rootGroup = must(authority.createGroup({ initialMode: "raw" }));
      must(authority.admitExisting({ group: rootGroup, pid: root.pid }));
      must(authority.release({ lease, restore: rootGroup }));
      return attachTerminal({
        context: display.inherit(),
        process: root,
        policy,
        checkActive() {},
      });
    },
    cleanup() {
      descriptors.dispose();
      display.close("disposed");
    },
  };
}

type Pause =
  | "session"
  | "input"
  | "before-entry"
  | "after-entry"
  | "after-unlock"
  | "before-leave"
  | "input-miss";
interface ProbeData {
  pause: Pause;
  process: WorkerProcessTransport;
  context: TerminalContext;
  input: SharedArrayBuffer;
  barrier: SharedArrayBuffer;
  admissionOffset: number;
  module: string;
}

async function probe() {
  const { parentPort, workerData } = await import("node:worker_threads");
  if (!parentPort) throw new Error("missing parent port");
  const port = parentPort;
  port.on("message", () => {}); // Retain the actual native consumer until the parent stops it.
  port.ref();
  const data: ProbeData = workerData;
  const barrier = new Int32Array(data.barrier);
  const nativeCAS = Atomics.compareExchange,
    nativeStore = Atomics.store;
  let paused = false;
  function pause() {
    if (paused) return;
    paused = true;
    port.postMessage({ phase: "held" });
    if (Atomics.wait(barrier, 0, 0, 5000) === "timed-out")
      throw new Error("holder barrier timeout");
  }
  function admissionCAS(array: unknown, index: unknown): boolean {
    return (
      array instanceof BigInt64Array &&
      array.buffer === data.process.directory &&
      array.byteOffset === data.admissionOffset &&
      index === 0
    );
  }
  function cas(...args: unknown[]) {
    const [array, index, expected, replacement] = args;
    const entry =
      admissionCAS(array, index) &&
      typeof expected === "bigint" &&
      (expected & 0xffffffffn) === 0n &&
      typeof replacement === "bigint" &&
      (replacement & 0xffffffffn) === 1n;
    if (entry && data.pause === "before-entry") pause();
    const leaving =
      admissionCAS(array, index) &&
      typeof expected === "bigint" &&
      (expected & 0xffffffffn) === 1n &&
      typeof replacement === "bigint" &&
      (replacement & 0xffffffffn) === 0n;
    if (leaving && data.pause === "before-leave") pause();
    const result: unknown = Reflect.apply(nativeCAS, Atomics, args);
    if (entry && data.pause === "after-entry" && result === expected) pause();
    const inputLock =
      array instanceof BigInt64Array &&
      array.buffer === data.input &&
      index === 0 &&
      array.byteOffset === 16;
    if (inputLock && data.pause === "input" && result === 0n) pause();
    if (inputLock && data.pause === "input-miss" && result !== 0n) pause();
    return result;
  }
  function store(...args: unknown[]) {
    const [array, index, value] = args;
    const result: unknown = Reflect.apply(nativeStore, Atomics, args);
    if (
      data.pause === "after-unlock" &&
      array instanceof BigInt64Array &&
      array.byteOffset === 64 &&
      array.buffer !== data.input &&
      array.buffer !== data.process.directory &&
      index === 0 &&
      value === 0n
    )
      pause();
    return result;
  }
  Reflect.set(Atomics, "compareExchange", cas);
  Reflect.set(Atomics, "store", store);
  const { attachTerminal, createTerminalInputPolicy } = await import(data.module);
  const base = createTerminalInputPolicy({ input: data.input });
  const attachment = attachTerminal({
    process: data.process,
    context: data.context,
    checkActive() {},
    policy: {
      ...base,
      tryRead(turn: Parameters<typeof base.tryRead>[0], chunks: readonly Uint8Array[]) {
        if (data.pause === "session") pause();
        return base.tryRead(turn, chunks);
      },
    },
  });
  const bytes = new Uint8Array(1);
  port.postMessage({ phase: "done", count: attachment.resolve(0).tryRead([bytes]), bytes });
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("terminal lifetime deadline")), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function start(f: ReturnType<typeof fixture>, pause: Pause) {
  const barrier = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(
    `(${probe.toString()})().catch(error=>{require('node:worker_threads').parentPort.postMessage({phase:'error',error:String(error)})})`,
    {
      eval: true,
      workerData: {
        process: f.process,
        context: f.context,
        input: f.input.buffer,
        barrier: barrier.buffer,
        pause,
        admissionOffset: f.state.terminalAdmission.byteOffset,
        module: new URL("../browser/runtime-terminals.ts", import.meta.url).href,
      } satisfies ProbeData,
    },
  );
  const queue: unknown[] = [];
  let receiver: ((message: unknown) => void) | undefined;
  function receive(message: unknown) {
    if (!receiver) {
      queue.push(message);
      return;
    }
    const resolve = receiver;
    receiver = undefined;
    resolve(message);
  }
  worker.on("message", receive);
  worker.on("error", (error) => receive({ phase: "error", error: String(error) }));
  worker.once("exit", (code) => receive({ phase: "exit", code }));
  return {
    worker,
    next: () =>
      bounded(
        queue.length
          ? Promise.resolve(queue.shift())
          : new Promise<unknown>((resolve) => {
              receiver = resolve;
            }),
      ),
    release() {
      Atomics.store(barrier, 0, 1);
      Atomics.notify(barrier, 0);
    },
  };
}

for (const pause of [
  "session",
  "input",
  "before-entry",
  "after-entry",
  "after-unlock",
  "before-leave",
] as const)
  test(`terminal pre-stop fence joins a live Worker at ${pause}`, async () => {
    const f = fixture();
    expect(f.input.push(Uint8Array.of(65))).toBe(1);
    const holder = start(f, pause);
    try {
      expect(await holder.next()).toEqual({ phase: "held" });
      let quiet = false;
      const pending = f.lifetime.quiesce();
      const joined = Promise.resolve(pending).then(() => {
        quiet = true;
      });
      await Promise.resolve();
      expect(quiet).toBe(pause === "before-entry");
      expect(controlLoad(f.state.terminalAdmission)).toBe(pause === "before-entry" ? -1 : -2);
      if (pause === "session" || pause === "input")
        expect(f.display.snapshot()).toEqual({ kind: "error", code: "AGAIN" });
      if (pause === "after-unlock") expect(f.display.snapshot().kind).toBe("ok");
      holder.release();
      expect(await holder.next()).toMatchObject({
        phase: "done",
        count: pause === "before-entry" ? -8 : 1,
      });
      await bounded(joined); // Release, not disposal/termination, must wake the actual waitAsync join.
      expect(controlLoad(f.state.terminalAdmission)).toBe(-1);
      await holder.worker.terminate();
      f.lifetime.stopped();
      expect(f.display.snapshot().kind).toBe("ok");
      expect(controlLoad(f.state.terminalStopped)).toBe(1);
      const root = f.restore();
      try {
        const expected = pause === "before-entry" ? 2 : 1;
        expect(f.input.push(Uint8Array.of(66))).toBe(1);
        expect(root.resolve(0).tryRead?.([new Uint8Array(2)])).toBe(expected);
      } finally {
        root.dispose();
      }
    } finally {
      holder.release();
      await holder.worker.terminate();
      f.cleanup();
    }
  });

function checkReusedInput(input: TerminalInput, expected: number): void {
  const other = fixture(input);
  const stream = attachTerminal({
    process: other.process,
    context: other.context,
    policy: other.policy,
    checkActive() {},
  });
  try {
    expect(stream.resolve(0).tryRead?.([new Uint8Array(2)])).toBe(expected);
    expect(other.display.snapshot().kind).toBe("ok");
  } finally {
    stream.dispose();
    other.cleanup();
  }
}

for (const pause of ["session", "input"] as const)
  test(`proven native death holding ${pause} fails closed without unlocking`, async () => {
    const f = fixture();
    expect(f.input.push(Uint8Array.of(65))).toBe(1);
    const holder = start(f, pause);
    try {
      expect(await holder.next()).toEqual({ phase: "held" });
      await holder.worker.terminate();
      f.lifetime.stopped();
      await bounded(Promise.resolve(f.lifetime.quiesce()));
      expect(f.display.snapshot()).toEqual({ kind: "error", code: "CLOSED" });
      const inputLock = Atomics.load(new BigInt64Array(f.input.buffer, 16, 1), 0);
      expect(inputLock > 1n).toBe(pause === "input");
      expect(f.input.push(Uint8Array.of(66))).toBe(pause === "input" ? -8 : 1);
      checkReusedInput(f.input, pause === "input" ? -8 : 2);
    } finally {
      await holder.worker.terminate();
      f.cleanup();
    }
  });

test("a dead Session cannot poison another root's live acquisition of the same raw input", async () => {
  const owner = fixture();
  const contender = fixture(owner.input);
  expect(owner.input.push(Uint8Array.of(65))).toBe(1);
  const live = start(owner, "input");
  let dying: ReturnType<typeof start> | undefined;
  try {
    expect(await live.next()).toEqual({ phase: "held" });
    const token = Atomics.load(new BigInt64Array(owner.input.buffer, 16, 1), 0);
    dying = start(contender, "input-miss");
    expect(await dying.next()).toEqual({ phase: "held" });
    await dying.worker.terminate();
    contender.lifetime.stopped();
    expect(contender.display.snapshot()).toEqual({ kind: "error", code: "CLOSED" });
    expect(Atomics.load(new BigInt64Array(owner.input.buffer, 16, 1), 0)).toBe(token);
    live.release();
    expect(await live.next()).toMatchObject({ phase: "done", count: 1, bytes: Uint8Array.of(65) });
    expect(owner.input.push(Uint8Array.of(66))).toBe(1);
    expect(owner.display.snapshot().kind).toBe("ok");
  } finally {
    live.release();
    await Promise.all([live.worker.terminate(), dying?.worker.terminate()]);
    contender.cleanup();
    owner.cleanup();
  }
});

test("a stale physical-stop capture cannot change a replacement directory incarnation", async () => {
  const f = fixture();
  try {
    await f.lifetime.quiesce();
    claimOutcome(f.state.signals.outcome, { kind: "exited", code: 0 });
    confirmWorkerProcessJob(f.process);
    collectDirectoryProcess(f.process);
    const replacement = f.spawn();
    expect(replacement.slot).toBe(f.process.slot);
    const state = workerProcessState(replacement);
    f.lifetime.stopped();
    expect(controlLoad(state.terminalAdmission)).toBe(0);
    expect(controlLoad(state.terminalStopped)).toBe(0);
  } finally {
    f.cleanup();
  }
});

async function brokerFixture(
  f: ReturnType<typeof fixture>,
  launch: ConstructorParameters<typeof BrowserProcessBroker>[0]["launch"],
) {
  const identities = new ProcessIdentityAllocator(f.root.identity);
  const registry = new ExecutableRegistry();
  registry.register("/child", {
    adapter: "fixture",
    module: new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)),
  });
  const errors: unknown[] = [];
  const broker = new BrowserProcessBroker({
    identities,
    registry,
    table: new ProcessTable(identities),
    launch,
    filesystem: {
      connect() {
        throw new Error("unused filesystem connection");
      },
      revoke: revokeFilesystem,
      reap: revokeFilesystem,
      async quiesce() {},
    },
    onError(error) {
      errors.push(error);
    },
  });
  f.root.data = { filesystem: createFilesystemIdentity() };
  f.process.data = { filesystem: createFilesystemIdentity() };
  await broker.adoptRuntimeRoot(f.root);
  const supervisor = await broker.ready();
  return { broker, supervisor, errors };
}

async function finishInterrupted(
  f: ReturnType<typeof fixture>,
  b: Awaited<ReturnType<typeof brokerFixture>>,
  holder: ReturnType<typeof start>,
  whileFenced: () => void,
): Promise<void> {
  expect(await holder.next()).toEqual({ phase: "held" });
  const retired = Promise.withResolvers<void>();
  const unsubscribe = b.supervisor.onJobRetirement(() => retired.resolve());
  try {
    b.supervisor.kill(f.process.pid, 9);
    expect(controlLoad(f.state.terminalAdmission)).toBe(-2);
    expect(controlLoad(f.state.terminalStopped)).toBe(0);
    whileFenced();
    holder.release();
    expect(await holder.next()).toMatchObject({ phase: "done", count: 1 });
    await bounded(retired.promise);
  } finally {
    unsubscribe();
  }
}

for (const controller of [false, true])
  test(`broker joins live terminal sections before external native stop, controller=${controller}`, async () => {
    const f = fixture();
    let holder: ReturnType<typeof start> | undefined;
    let stops = 0;
    const b = await brokerFixture(f, () => {
      holder = start(f, "session");
      return {
        async terminate() {
          stops++;
          await holder!.worker.terminate();
        },
      };
    });
    if (controller) b.broker.registerController(f.process.pid, {});
    try {
      expect(f.input.push(Uint8Array.of(65))).toBe(1);
      await b.broker.runtimeMessage(f.messages[0]!, f.root.pid);
      await b.supervisor.start(f.process.pid);
      if (!holder) throw new Error("native handle was not launched");
      await finishInterrupted(f, b, holder, () => expect(stops).toBe(0));
      expect(stops).toBe(1);
      expect(controlLoad(f.state.terminalStopped)).toBe(1);
      expect(f.display.snapshot().kind).toBe("ok");
      expect(b.errors).toEqual([]);
    } finally {
      holder?.release();
      await holder?.worker.terminate();
      await bounded(b.broker.dispose());
      f.cleanup();
    }
  });

test("failed native stop retains the controller and does not acknowledge physical death", async () => {
  const f = fixture();
  let holder: ReturnType<typeof start> | undefined;
  let retiredController = 0;
  const failure = new Error("native stop refused");
  const b = await brokerFixture(f, () => {
    holder = start(f, "input");
    return {
      terminate() {
        throw failure;
      },
    };
  });
  b.broker.registerController(f.process.pid, {
    stop() {}, // Auxiliary controller cleanup does not prove the returned native handle stopped.
    retired() {
      retiredController++;
    },
  });
  try {
    expect(f.input.push(Uint8Array.of(65))).toBe(1);
    await b.broker.runtimeMessage(f.messages[0]!, f.root.pid);
    await b.supervisor.start(f.process.pid);
    if (!holder) throw new Error("native handle was not launched");
    await finishInterrupted(f, b, holder, () => expect(retiredController).toBe(0));
    expect(controlLoad(f.state.terminalStopped)).toBe(0);
    expect(retiredController).toBe(0);
    expect(holder.worker.threadId).toBeGreaterThan(0);
    expect(f.input.push(Uint8Array.of(66))).toBe(1);
    expect(b.errors).toContain(failure);
    await expect(bounded(b.broker.dispose())).rejects.toThrow();
    expect(retiredController).toBe(0);
    // Disposal can collect the fenced directory row before the failed native stop settles.
    expect(Atomics.load(f.state.terminalStopped.cells, 0)).toBe(packedControl(f.process.pid, 0));
  } finally {
    holder?.release();
    await holder?.worker.terminate();
    await b.broker.dispose().catch(() => {});
    f.cleanup();
  }
});

test("failed launch joins a live terminal holder before its controller stops the native Worker", async () => {
  const f = fixture();
  let holder: ReturnType<typeof start> | undefined;
  let stops = 0;
  const b = await brokerFixture(f, () => {
    throw new Error("controller owns launch");
  });
  b.broker.registerController(f.process.pid, {
    async launch() {
      holder = start(f, "input");
      expect(await holder.next()).toEqual({ phase: "held" });
      throw new Error("launcher failed after acquiring its native consumer");
    },
    async stop() {
      stops++;
      await holder?.worker.terminate();
    },
  });
  const retired = Promise.withResolvers<void>();
  const unsubscribe = b.supervisor.onJobRetirement(() => retired.resolve());
  try {
    expect(f.input.push(Uint8Array.of(65))).toBe(1);
    await b.broker.runtimeMessage(f.messages[0]!, f.root.pid);
    await b.supervisor.start(f.process.pid);
    if (!holder) throw new Error("failed launch did not acquire a native handle");
    expect(stops).toBe(0);
    expect(controlLoad(f.state.terminalAdmission)).toBe(-2);
    holder.release();
    expect(await holder.next()).toMatchObject({ phase: "done", count: 1 });
    await bounded(retired.promise);
    expect(stops).toBe(1);
    expect(controlLoad(f.state.terminalStopped)).toBe(1);
    expect(f.display.snapshot().kind).toBe("ok");
  } finally {
    unsubscribe();
    holder?.release();
    await holder?.worker.terminate();
    await bounded(b.broker.dispose());
    f.cleanup();
  }
});
