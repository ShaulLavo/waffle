import { expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { DescriptorTable, type Readiness } from "../core/descriptors.js";
import { MemFS } from "../fs/memory.js";
import { ProcessABI } from "../proc/abi.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessState,
  type WorkerProcessTransport,
} from "../proc/worker-client.js";
import {
  attachTerminal,
  claimTerminalAuthority,
  createTerminalInput,
  createTerminalInputPolicy,
  createTerminalSession,
  pushTerminalInput,
  type TerminalContext,
  type TerminalResult,
} from "../browser/runtime-terminals.js";

function must<T>(result: TerminalResult<T>): T {
  if (result.kind === "error") throw new Error(result.code);
  return result.value;
}

function controlBuffer(identity: unknown): SharedArrayBuffer {
  if (typeof identity !== "object" || identity === null || !("buffer" in identity))
    throw new Error("missing terminal control block");
  if (!(identity.buffer instanceof SharedArrayBuffer)) throw new Error("invalid terminal buffer");
  return identity.buffer;
}

function fixture() {
  const root = createWorkerProcessTransport({ capacity: 8 });
  const descriptors = new DescriptorTable();
  let child: WorkerProcessTransport | undefined;
  const unused = (): never => {
    throw new Error("no descriptor transfer expected");
  };
  const client = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec: { export: unused, import: unused, discard: unused },
    postMessage(message) {
      if (message.operation === "spawn") child = message.transport;
    },
  });
  client.spawn(root.pid, {
    executable: "/background",
    argv: [],
    env: {},
    cwd: "/",
    job: -1,
    fds: [],
  });
  if (!child) throw new Error("background process not reserved");
  const background = child;
  const input = createTerminalInput();
  const policy = createTerminalInputPolicy({ input });
  const display = createTerminalSession({ controller: root, geometry: { columns: 80, rows: 24 } });
  const authority = must(
    claimTerminalAuthority({ identity: display.identity, process: root, checkActive() {}, policy }),
  );
  const editor = must(authority.createGroup({ initialMode: "raw" }));
  must(authority.admitExisting({ group: editor, pid: root.pid }));
  must(authority.acquire({ group: editor, expected: null }));
  const group = must(authority.createGroup({ initialMode: "raw" }));
  const member = must(authority.admitExisting({ group, pid: background.pid }));
  must(authority.startBackground(group));
  const attachment = attachTerminal({
    context: display.inherit(),
    process: root,
    checkActive() {},
    policy,
  });
  const stream = attachment.resolve(0);
  descriptors.openAt(0, stream, (1n << 29n) - 1n, 0n);
  const common = workerProcessState(root).wake;
  const gate = new BigInt64Array(controlBuffer(display.identity), 64, 1);
  const line = new TextEncoder().encode("kill %1; wait; echo __BACKGROUND_REAPED__\r");
  must(pushTerminalInput(display, input, line));
  expect(stream.tryRead?.([new Uint8Array(24)])).toBe(24);
  return {
    root,
    background,
    client,
    descriptors,
    input,
    display,
    attachment,
    stream,
    common,
    gate,
    backgroundContext: member.context,
    cleanup() {
      descriptors.dispose();
      attachment.dispose();
      display.close("disposed");
    },
  };
}

test("a background no-op release wakes the fully notified infinite terminal poll", () => {
  const f = fixture();
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = new DataView(memory.buffer);
  view.setUint32(128, 0, true);
  view.setUint32(132, 0, true);
  view.setBigUint64(136, 77n, true);
  let expected: number | undefined;
  let waits = 0;
  const parked = new Error("stop at real infinite poll wait");
  const abi = new ProcessABI({
    memory,
    descriptors: f.descriptors,
    fs: new MemFS(),
    pid: f.root.pid,
    service: f.client,
    signals: workerProcessState(f.root).signals,
    wake: f.common,
    wait(milliseconds, word, sequence) {
      expect(milliseconds).toBe(Infinity);
      expect(word).toBe(f.common);
      expected = sequence;
      waits++;
      throw parked;
    },
  });
  const during: Readiness[] = [];
  const background = attachTerminal({
    context: f.backgroundContext,
    process: f.background,
    policy: createTerminalInputPolicy({ input: f.input.buffer }),
    checkActive() {
      if (Atomics.load(f.gate, 0) !== BigInt(f.background.pid)) return;
      during.push(f.stream.readiness());
      expect(f.stream.tryRead?.([new Uint8Array(1)])).toBe(-6);
      expect(() => abi.imports.poll!(128, 1, -1, 256)).toThrow(parked);
    },
  });
  try {
    expect(background.resolve(0).tryRead?.([new Uint8Array(1)])).toBe(-6);
    expect(during).toEqual([{ readable: false, writable: false, hangup: false, nbytes: 0 }]);
    expect(f.input.available()).toBe(18);
    expect(waits).toBe(1);
    if (expected === undefined) throw new Error("poll never reached its notified wait");
    expect(Atomics.wait(f.common, 0, expected, 0)).toBe("not-equal");
    expect(abi.imports.poll!(128, 1, -1, 256)).toBe(1);
    expect(view.getBigUint64(256, true)).toBe(77n);
    expect(f.stream.tryRead?.([new Uint8Array(18)])).toBe(18);
  } finally {
    background.dispose();
    f.cleanup();
  }
});

test("uncontended no-op terminal transactions remain silent", () => {
  const f = fixture();
  const background = attachTerminal({
    context: f.backgroundContext,
    process: f.background,
    checkActive() {},
    policy: createTerminalInputPolicy({ input: f.input.buffer }),
  });
  try {
    const before = Atomics.load(f.common, 0);
    expect(f.display.snapshot().kind).toBe("ok");
    expect(f.stream.readiness().nbytes).toBe(18);
    expect(background.resolve(0).tryRead?.([new Uint8Array(1)])).toBe(-6);
    expect(Atomics.load(f.common, 0)).toBe(before);
  } finally {
    background.dispose();
    f.cleanup();
  }
});

type ReleaseOrder = "before-hint" | "before-wait" | "registered";
interface ProbeData {
  role: "holder" | "contender";
  order: ReleaseOrder;
  process: WorkerProcessTransport;
  context: TerminalContext;
  input: SharedArrayBuffer;
  barrier: SharedArrayBuffer;
  control: SharedArrayBuffer;
  module: string;
}

// Each role runs in a fresh realm. Only the failed-CAS hook pauses an actual atomic operation;
// it neither changes the returned value nor replaces the terminal/poll implementation.
async function workerProbe() {
  const { parentPort, workerData } = await import("node:worker_threads");
  if (!parentPort) throw new Error("probe requires a Worker");
  const port = parentPort;
  const data: ProbeData = workerData;
  const barrier = new Int32Array(data.barrier);
  const gate = new BigInt64Array(data.control, 64, 1);
  const nativeWait = Atomics.wait;
  function pause(index: number) {
    if (Atomics.load(barrier, index) === 1) return;
    const result = nativeWait(barrier, index, 0, 5000);
    if (result === "timed-out" || Atomics.load(barrier, index) !== 1)
      throw new Error(`probe barrier ${index} not released`);
  }
  const compare = Atomics.compareExchange;
  function compareAndPause(...args: unknown[]) {
    const result: unknown = Reflect.apply(compare, Atomics, args);
    const array = args[0];
    if (!(array instanceof BigInt64Array) || array.buffer !== data.control || result === 0n)
      return result;
    port.postMessage({ phase: "missed-cas" });
    pause(1);
    return result;
  }
  if (data.role === "contender" && data.order === "before-hint")
    Reflect.set(Atomics, "compareExchange", compareAndPause);
  const { attachTerminal, createTerminalInputPolicy } = await import(data.module);
  let held = false;
  const attachment = attachTerminal({
    context: data.context,
    process: data.process,
    policy: createTerminalInputPolicy({ input: data.input }),
    checkActive() {
      if (data.role !== "holder" || held || Atomics.load(gate, 0) !== BigInt(data.process.pid))
        return;
      held = true;
      port.postMessage({ phase: "held" });
      pause(0);
    },
  });
  try {
    const stream = attachment.resolve(0);
    if (data.role === "holder") {
      port.postMessage({ phase: "released", count: stream.tryRead([new Uint8Array(1)]) });
      pause(3); // Disposal also wakes the session, so keep it outside the contention proof.
      return;
    }
    const common = new Int32Array(data.process.directory, 4, 1);
    const expected = Atomics.load(common, 0);
    const readiness = stream.readiness();
    port.postMessage({ phase: "scanned", readiness });
    if (data.order === "before-wait") pause(2);
    const wait = Atomics.waitAsync(common, 0, expected, 5000);
    port.postMessage({ phase: "waiting", async: wait.async });
    const result = await wait.value;
    const bytes = new Uint8Array(18);
    port.postMessage({ phase: "done", result, count: stream.tryRead([bytes]), bytes });
  } finally {
    attachment.dispose();
    port.close();
  }
}

function startProbe(data: Omit<ProbeData, "module">) {
  const worker = new Worker(
    `(${workerProbe.toString()})().catch(error=>{require('node:worker_threads').parentPort.postMessage({phase:'error',error:String(error)});require('node:worker_threads').parentPort.close()})`,
    {
      eval: true,
      workerData: {
        ...data,
        module: new URL("../browser/runtime-terminals.ts", import.meta.url).href,
      },
    },
  );
  const messages: unknown[] = [];
  let pending: ((message: unknown) => void) | undefined;
  const receive = (message: unknown) => {
    const resolve = pending;
    pending = undefined;
    if (resolve) resolve(message);
    else messages.push(message);
  };
  worker.on("message", receive);
  worker.on("error", (error) => receive({ phase: "error", error: String(error) }));
  return {
    worker,
    async next(): Promise<unknown> {
      if (messages.length) return messages.shift();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise((resolve, reject) => {
          pending = resolve;
          timer = setTimeout(() => reject(new Error("terminal probe message timeout")), 5000);
        });
      } finally {
        clearTimeout(timer);
        pending = undefined;
      }
    },
  };
}

function release(barrier: Int32Array, index: number): void {
  Atomics.store(barrier, index, 1);
  Atomics.notify(barrier, index);
}

for (const order of ["before-hint", "before-wait", "registered"] as const)
  test(`terminal contention wake crosses Workers when release is ${order}`, async () => {
    const f = fixture();
    const barrier = new Int32Array(new SharedArrayBuffer(16));
    const shared = {
      order,
      input: f.input.buffer,
      barrier: barrier.buffer,
      control: f.gate.buffer,
    };
    const holder = startProbe({
      ...shared,
      role: "holder",
      process: f.background,
      context: f.backgroundContext,
    });
    let contender: ReturnType<typeof startProbe> | undefined;
    try {
      expect(await holder.next()).toEqual({ phase: "held" });
      contender = startProbe({
        ...shared,
        role: "contender",
        process: f.root,
        context: f.display.inherit(),
      });
      if (order === "before-hint") {
        expect(await contender.next()).toEqual({ phase: "missed-cas" });
        release(barrier, 0);
        expect(await holder.next()).toEqual({ phase: "released", count: -6 });
        release(barrier, 1);
      }
      expect(await contender.next()).toMatchObject({
        phase: "scanned",
        readiness: { readable: false, nbytes: 0 },
      });
      if (order === "before-wait") {
        release(barrier, 0);
        expect(await holder.next()).toEqual({ phase: "released", count: -6 });
        release(barrier, 2);
      }
      expect(await contender.next()).toEqual({ phase: "waiting", async: order === "registered" });
      if (order === "registered") {
        release(barrier, 0);
        expect(await holder.next()).toEqual({ phase: "released", count: -6 });
      }
      expect(await contender.next()).toMatchObject({
        phase: "done",
        result: order === "registered" ? "ok" : "not-equal",
        count: 18,
        bytes: new TextEncoder().encode("CKGROUND_REAPED__\r"),
      });
      expect(f.input.available()).toBe(0);
    } finally {
      for (const index of [0, 1, 2, 3]) release(barrier, index);
      await Promise.all([holder.worker.terminate(), contender?.worker.terminate()]);
      f.cleanup();
    }
  });
