import { controlLoad, controlStore } from "../proc/control.js";
import { compileInterruptible } from "../interrupt/loader.js";
import { expect, spyOn, test } from "bun:test";
import {
  bootstrap,
  RuntimeWorkerSignal,
  type RuntimeWorkerMessage,
  type RuntimeWorkerRequest,
  type WorkerExecutor,
} from "../browser/worker.js";
import {
  createFilesystemConnection,
  FilesystemClient,
  FilesystemService,
  MemoryBackend,
  revokeFilesystem,
} from "../fs/index.js";
import { collectDirectoryJob, confirmDirectoryProcess } from "../proc/directory.js";
import { DescriptorTable } from "../core/descriptors.js";
import { shareFileResource } from "../core/open-file.js";
import { claimOutcome, outcomeWord, readOutcome } from "../proc/outcome.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessState,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";
import {
  createSignalState,
  requestSignal,
  setSignalDisposition,
  signalPending,
  SIGNAL_PENDING,
  takeSignal,
} from "../proc/signals.js";

// Original tiny guest: one memory and an empty preview1 command entry point.
const module = new WebAssembly.Module(
  new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 7, 19, 2, 6, 109,
    101, 109, 111, 114, 121, 2, 0, 6, 95, 115, 116, 97, 114, 116, 0, 0, 10, 4, 1, 2, 0, 11,
  ]),
);

test("injected worker executor observes live descriptors, then acknowledgement follows filesystem release", async () => {
  const service = new FilesystemService(new MemoryBackend());
  const connection = createFilesystemConnection();
  service.connect(connection.server);
  const messages: RuntimeWorkerMessage[] = [];
  let released = false;
  try {
    await bootstrap(
      { module, args: ["fixture"], env: {}, filesystem: connection.client },
      {
        setup({ fs }) {
          // The fixture has no filesystem calls. Keep its preopen local so this unit test
          // never blocks waiting for a service on the same JavaScript thread.
          fs.preopen = () => 1;
          fs.retain = () => {};
          fs.release = () => {};
        },
        run(context, exited) {
          expect(exited).toBeNull();
          expect(context.wasi.descriptors.get(1)).toBeDefined();
          const dispose = context.fs.dispose.bind(context.fs);
          context.fs.dispose = () => {
            dispose();
            released = true;
          };
          context.post("stdout", new Uint8Array([65]));
          context.finish({ code: 23 });
          return 0;
        },
      },
      {
        crossOriginIsolated: true,
        postMessage(message) {
          if (message.type === "exit") expect(released).toBe(true);
          messages.push(message);
        },
      },
    );
    expect(messages.filter((message) => message.type === "exit")).toEqual([
      { type: "exit", code: 23, signal: undefined, sleep: "atomics" },
    ]);
    expect(messages.filter((message) => message.type === "stdout")).toEqual([
      { type: "stdout", data: new Uint8Array([65]) },
    ]);
  } finally {
    connection.client.port.close();
    service.dispose();
  }
});

test("bootstrap captures explicit host methods before executor setup replaces them", async () => {
  const connection = createFilesystemConnection();
  const messages: RuntimeWorkerMessage[] = [],
    listeners: string[] = [];
  const host = {
    crossOriginIsolated: true,
    postMessage(message: RuntimeWorkerMessage) {
      expect(this).toBe(host);
      messages.push(message);
    },
    addEventListener(type: string) {
      expect(this).toBe(host);
      listeners.push(`add:${type}`);
    },
    removeEventListener(type: string) {
      expect(this).toBe(host);
      listeners.push(`remove:${type}`);
    },
  };
  const replaced = () => {
    throw new Error("guest host hook called");
  };
  try {
    await bootstrap(
      { module, args: [], env: {}, filesystem: connection.client },
      {
        setup({ fs }) {
          fs.preopen = () => 1;
          fs.retain = () => {};
          fs.release = () => {};
          host.postMessage = replaced;
          host.addEventListener = replaced;
          host.removeEventListener = replaced;
        },
        run(context) {
          context.post("stdout", new Uint8Array([65]));
          return 23;
        },
      },
      host,
    );
    expect(messages.filter((message) => message.type === "stdout")).toEqual([
      { type: "stdout", data: new Uint8Array([65]) },
    ]);
    expect(messages.filter((message) => message.type === "exit")).toMatchObject([{ code: 23 }]);
    expect(listeners).toEqual([
      "add:error",
      "add:unhandledrejection",
      "remove:error",
      "remove:unhandledrejection",
    ]);
  } finally {
    connection.client.port.close();
    connection.server.port.close();
  }
});

test("preview1 worker bundle has no Bun engine, native slot or legacy subprocess graph", async () => {
  const result = await Bun.build({
    entrypoints: [new URL("../browser/preview1-worker.js", import.meta.url).pathname],
    target: "browser",
  });
  expect(result.success).toBe(true);
  const source = await result.outputs[0]!.text();
  for (const marker of [
    "startEngineHost",
    "SubprocessHost",
    "installHostSlots",
    "bunwasm_ready",
    "moduleCache",
    "engine-host.js",
  ]) {
    expect(source).not.toContain(marker);
  }
});

async function fixture(
  executor: WorkerExecutor,
  options: {
    isolated?: boolean;
    runtimeProcess?: RuntimeWorkerRequest["runtimeProcess"];
    module?: WebAssembly.Module;
    interruptible?: boolean;
    env?: Record<string, string>;
  } = {},
) {
  const connection = createFilesystemConnection();
  const messages: RuntimeWorkerMessage[] = [];
  const order: string[] = [];
  try {
    await bootstrap(
      {
        module: options.module ?? module,
        args: ["fixture"],
        env: options.env ?? {},
        filesystem: connection.client,
        runtimeProcess: options.runtimeProcess,
        interruptible: options.interruptible,
      },
      {
        ...executor,
        setup(context) {
          const { fs } = context;
          fs.preopen = () => 1;
          fs.retain = () => {};
          fs.release = () => {
            order.push("descriptor release");
          };
          const dispose = fs.dispose.bind(fs);
          fs.dispose = () => {
            order.push("filesystem release");
            dispose();
          };
          executor.setup?.(context);
        },
      },
      {
        crossOriginIsolated: options.isolated ?? true,
        postMessage(message) {
          messages.push(message);
          if (message.type === "exit" || message.type === "error") order.push("acknowledgement");
        },
      },
    );
    return { messages, order };
  } finally {
    connection.client.port.close();
    connection.server.port.close();
  }
}

test("runtime diagnostics claim the execution failure before a queued signal can win", async () => {
  let defaultSignal!: (signal: number) => void;
  let writes = 0;
  const result = await fixture({
    stdio: {
      2: {
        kind: "terminal",
        read: () => 0,
        write: () => {
          throw new Error("blocking diagnostic write");
        },
        tryWrite() {
          if (writes++ === 0) {
            queueMicrotask(() => {
              try {
                defaultSignal(15);
              } catch {
                /* the claimed failure rejects the signal */
              }
            });
            return -6;
          }
          return -64;
        },
        readiness: () => ({ readable: false, writable: true, hangup: false }),
      },
    },
    setup({ defaultSignal: signal }) {
      defaultSignal = signal;
    },
    run() {
      throw new Error("execution failed");
    },
  });
  expect(result.messages.filter((message) => message.type === "error")).toMatchObject([
    { code: 1, cleanupErrors: [expect.stringContaining("diagnostic write failed (-64)")] },
  ]);
});

for (const append of [false, true])
  test(`file stderr diagnostics bound shared-offset waits (append=${append})`, async () => {
    let lock!: SharedArrayBuffer;
    let blockingWrites = 0;
    const started = performance.now();
    const result = await fixture({
      instantiated({ wasi, fs }) {
        const resource = { kind: "file" as const, handle: 17, offset: 0, append };
        lock = shareFileResource(resource, fs.connection);
        const alias = wasi.descriptors.open(resource, 1n << 6n, 0n);
        wasi.descriptors.close(2);
        wasi.descriptors.inherit(2, wasi.descriptors.get(alias)!);
        wasi.descriptors.close(alias);
        // A live owner makes blocking withFileOffset wait indefinitely. Immediate mode must
        // return EAGAIN to the shared drain instead, so the five-second deadline still applies.
        Atomics.store(new Int32Array(lock), 0, fs.connection.owner);
        fs.write = () => {
          blockingWrites++;
          return -64;
        };
        fs.append = () => {
          blockingWrites++;
          return -64;
        };
        fs.tryWrite = () => -6;
        fs.tryAppend = () => -6;
      },
      run() {
        throw new Error("file diagnostic");
      },
    });
    const elapsed = performance.now() - started;
    Atomics.store(new Int32Array(lock), 0, 0);
    expect(elapsed).toBeLessThan(6_000);
    expect(blockingWrites).toBe(0);
    expect(result.messages.filter((message) => message.type === "error")).toMatchObject([
      {
        code: 1,
        cleanupErrors: [expect.stringContaining("reader made no progress for five seconds")],
      },
    ]);
  }, 10_000);

for (const append of [false, true])
  test(`file stderr diagnostics use immediate filesystem calls (append=${append})`, async () => {
    const chunks: Uint8Array[] = [];
    const error = new Error("file diagnostic");
    error.stack = "";
    const expected = new TextEncoder().encode("Error: file diagnostic\n");
    const result = await fixture({
      instantiated({ wasi, fs }) {
        const resource = { kind: "file" as const, handle: 17, offset: 4, append };
        const alias = wasi.descriptors.open(resource, 1n << 6n, 0n);
        shareFileResource(resource, fs.connection);
        wasi.descriptors.inherit(2, wasi.descriptors.get(alias)!);
        fs.write = fs.append = () => {
          throw new Error("blocking diagnostic file I/O");
        };
        fs.tryWrite = (_handle, data, offset) => {
          expect(append).toBe(false);
          expect(offset).toBe(4 + chunks.reduce((sum, chunk) => sum + chunk.length, 0));
          const part = data[0]!.slice(0, 3);
          chunks.push(part);
          return part.length;
        };
        fs.tryAppend = (_handle, data) => {
          expect(append).toBe(true);
          const part = data[0]!.slice(0, 3);
          chunks.push(part);
          return {
            written: part.length,
            offset: 99 + chunks.reduce((sum, chunk) => sum + chunk.length, 0),
          };
        };
      },
      run() {
        throw error;
      },
    });
    expect(new Uint8Array(Buffer.concat(chunks))).toEqual(expected);
    expect(result.messages.filter((message) => message.type === "error")).toMatchObject([
      { code: 1 },
    ]);
  });

test("diagnostic revocation after a partial write reports a typed failure and exact unwritten span", async () => {
  const error = new Error("revoked diagnostic");
  error.stack = "";
  const total = new TextEncoder().encode("Error: revoked diagnostic\n").length;
  let writes = 0;
  const result = await fixture({
    instantiated({ wasi, fs }) {
      const fd = wasi.descriptors.open(
        {
          kind: "terminal",
          read: () => 0,
          write: () => -64,
          tryWrite() {
            if (writes++ === 0) {
              Atomics.store(new Int32Array(fs.connection.revocations[0]!), 0, 1);
              return 3;
            }
            return -64;
          },
          readiness: () => ({ readable: false, writable: true, hangup: false }),
        },
        1n << 6n,
        0n,
      );
      wasi.descriptors.inherit(2, wasi.descriptors.get(fd)!);
    },
    run() {
      throw error;
    },
  });
  expect(result.messages.filter((message) => message.type === "error")).toMatchObject([
    {
      code: 1,
      cleanupErrors: [
        expect.stringContaining(
          `ProcessError: diagnostic write threw (exit 1); ${total - 3} of ${total} diagnostic bytes unwritten`,
        ),
      ],
    },
  ]);
});

for (const isolated of [true, false])
  test(`generic signal winner guards stdio and survives caught unwinds (isolated=${isolated})`, async () => {
    const result = await fixture(
      {
        run(context) {
          try {
            context.defaultSignal(15);
          } catch (error) {
            expect(error).toBeInstanceOf(RuntimeWorkerSignal);
          }
          expect(() => context.post("stdout", new Uint8Array([65]))).toThrow("signal 15");
          expect(() => context.post("stderr", new Uint8Array([66]))).toThrow("signal 15");
          return 0;
        },
      },
      { isolated },
    );
    expect(
      result.messages.filter((message) => message.type === "exit" || message.type === "error"),
    ).toEqual([{ type: "exit", code: 143, signal: 15, sleep: isolated ? "atomics" : "busy-wait" }]);
    expect(
      result.messages.some((message) => message.type === "stdout" || message.type === "stderr"),
    ).toBe(false);
    expect(result.messages.filter((message) => message.type === "default-signal").length).toBe(
      isolated ? 0 : 3,
    );
    expect(result.order).toEqual(["descriptor release", "filesystem release", "acknowledgement"]);
  });

test("a delayed stale Worker releases its filesystem and reports startup failure without touching its replacement", async () => {
  const root = createWorkerProcessTransport({ capacity: 2 });
  const descriptors = new DescriptorTable(),
    notices: WorkerProcessMessage[] = [];
  const owner = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec: {
      export() {
        throw new Error("unused");
      },
      import() {
        throw new Error("unused");
      },
      discard() {},
    },
    postMessage(message) {
      notices.push(message);
    },
  });
  const request = { executable: "fixture", argv: [], env: {}, cwd: "/", job: -1, fds: [] };
  const first = owner.spawn(owner.pid, request);
  const old = notices.find((message) => message.operation === "spawn")!;
  if (old.operation !== "spawn") throw new Error("missing spawn fixture");
  const state = workerProcessState(old.transport);
  claimOutcome(state.signals.outcome, { kind: "exited", code: 23 });
  confirmDirectoryProcess(old.transport);
  collectDirectoryJob(root.directory, state.jobSlot, state.job);
  const replacement = owner.spawn(owner.pid, request);
  const latest = notices.at(-1)!;
  if (latest.operation !== "spawn") throw new Error("missing replacement fixture");
  const current = workerProcessState(latest.transport);
  expect(replacement).not.toBe(first);
  expect(current.slot).toBe(state.slot);
  const connection = createFilesystemConnection(),
    messages: RuntimeWorkerMessage[] = [],
    order: string[] = [];
  const dispose = spyOn(FilesystemClient.prototype, "dispose");
  let entered = false;
  try {
    await expect(
      bootstrap(
        { module, args: [], env: {}, filesystem: connection.client, runtimeProcess: old.transport },
        {
          setup() {
            entered = true;
          },
          run() {
            entered = true;
            return 0;
          },
          beforeFinish() {
            order.push("executor cleanup");
          },
        },
        {
          crossOriginIsolated: true,
          postMessage(message) {
            if (message.type === "error") {
              expect(dispose).toHaveBeenCalledTimes(1);
              order.push("acknowledgement");
            }
            messages.push(message);
          },
        },
      ),
    ).resolves.toBeUndefined();
    expect(entered).toBe(false);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["executor cleanup", "acknowledgement"]);
    expect(messages.filter((message) => message.type === "error")).toMatchObject([
      {
        type: "error",
        code: 126,
        message: expect.stringContaining("process incarnation was collected"),
      },
    ]);
    expect(messages.some((message) => message.type === "runtime-proc")).toBe(false);
    expect(readOutcome(current.signals.outcome)).toBeNull();
    expect(controlLoad(current.confirmed)).toBe(0);
    expect(controlLoad(current.jobPending)).toBe(1);
  } finally {
    dispose.mockRestore();
    descriptors.dispose();
    connection.client.port.close();
    connection.server.port.close();
  }
});

test("collection during Worker setup cannot bypass filesystem cleanup through a stale outcome", async () => {
  const root = createWorkerProcessTransport({ capacity: 2 }),
    descriptors = new DescriptorTable();
  const notices: WorkerProcessMessage[] = [];
  const client = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec: {
      export() {
        throw new Error("unused");
      },
      import() {
        throw new Error("unused");
      },
      discard() {},
    },
    postMessage(message) {
      notices.push(message);
    },
  });
  const request = { executable: "fixture", argv: [], env: {}, cwd: "/", job: -1, fds: [] };
  client.spawn(client.pid, request);
  const notice = notices[0]!;
  if (notice.operation !== "spawn") throw new Error("missing spawn fixture");
  const state = workerProcessState(notice.transport);
  let replacement: ReturnType<typeof workerProcessState> | undefined,
    ran = false;
  try {
    const result = await fixture(
      {
        setup() {
          claimOutcome(state.signals.outcome, { kind: "exited", code: 23 });
          confirmDirectoryProcess(notice.transport);
          collectDirectoryJob(root.directory, state.jobSlot, state.job);
          client.spawn(client.pid, request);
          replacement = workerProcessState(notices.at(-1)!.transport);
        },
        run() {
          ran = true;
          return 0;
        },
      },
      { runtimeProcess: notice.transport },
    );
    expect(ran).toBe(false);
    expect(result.order).toEqual(["descriptor release", "filesystem release", "acknowledgement"]);
    expect(result.messages.filter((message) => message.type === "error")).toMatchObject([
      {
        type: "error",
        code: 126,
        message: expect.stringContaining("process incarnation was collected"),
      },
    ]);
    expect(replacement?.slot).toBe(state.slot);
    expect(readOutcome(replacement!.signals.outcome)).toBeNull();
    expect(controlLoad(replacement!.confirmed)).toBe(0);
  } finally {
    descriptors.dispose();
  }
});

test("generic runtime process adopts the shared signal winner and releases descriptors before exit acknowledgement", async () => {
  const runtimeProcess = createWorkerProcessTransport();
  const state = workerProcessState(runtimeProcess);
  const result = await fixture(
    {
      run(context) {
        claimOutcome(state.signals.outcome, { kind: "signaled", code: 9 });
        expect(() => context.checkActive()).toThrow();
        return 23;
      },
    },
    { runtimeProcess },
  );
  expect(readOutcome(state.signals.outcome)).toMatchObject({ kind: "signaled", code: 9 });
  expect(
    result.messages.filter((message) => message.type === "exit" || message.type === "error"),
  ).toEqual([{ type: "exit", code: 137, signal: 9, sleep: "atomics" }]);
  expect(result.order.at(-1)).toBe("acknowledgement");
});

test("generic executor crash keeps host diagnostics and the first terminal result", async () => {
  const outcome = new SharedArrayBuffer(8);
  const result = await fixture({
    outcome,
    run() {
      throw new Error("executor diagnostic");
    },
  });
  expect(readOutcome(outcomeWord(outcome))).toMatchObject({ kind: "exited", code: 1 });
  expect(
    result.messages.filter((message) => message.type === "exit" || message.type === "error"),
  ).toMatchObject([
    { type: "error", code: 1, message: expect.stringContaining("executor diagnostic") },
  ]);
  expect(result.order).toEqual(["descriptor release", "filesystem release", "acknowledgement"]);
});

test("generic startup failure reports 126 and never enters its injected executor", async () => {
  const missingStart = new WebAssembly.Module(
    new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 0, 1, 7, 10, 1, 6, 109, 101, 109, 111, 114, 121, 2, 0,
    ]),
  );
  let ran = false;
  const result = await fixture(
    {
      run() {
        ran = true;
        return 0;
      },
    },
    { module: missingStart },
  );
  expect(ran).toBe(false);
  expect(
    result.messages.filter((message) => message.type === "exit" || message.type === "error"),
  ).toMatchObject([{ type: "error", code: 126, message: expect.stringContaining("_start") }]);
  expect(result.order).toEqual(["descriptor release", "filesystem release", "acknowledgement"]);
});

test("throwing finish hook still releases owned resources and acknowledges the selected exit once", async () => {
  const outcome = new SharedArrayBuffer(8);
  const result = await fixture({
    outcome,
    beforeFinish() {
      throw new Error("finish hook failed");
    },
    run() {
      return 23;
    },
  });
  expect(readOutcome(outcomeWord(outcome))).toMatchObject({ kind: "exited", code: 23 });
  expect(result.order).toEqual(["descriptor release", "filesystem release", "acknowledgement"]);
  expect(
    result.messages.filter((message) => message.type === "exit" || message.type === "error"),
  ).toMatchObject([
    { type: "exit", code: 23, cleanupErrors: [expect.stringContaining("finish hook failed")] },
  ]);
});

test("descriptor release failures drain the table and filesystem but require the page fence instead of acknowledging quiescence", async () => {
  const runtimeProcess = createWorkerProcessTransport();
  const outcome = workerProcessState(runtimeProcess).signals.outcome;
  const released: string[] = [];
  let descriptors: import("../core/descriptors.js").DescriptorTable;
  const result = await fixture(
    {
      instantiated({ wasi }) {
        descriptors = wasi.descriptors;
        wasi.descriptors.open({ kind: "file", handle: 2, offset: 0, append: false }, 0n, 0n, () => {
          released.push("first");
          throw new Error("first descriptor failed");
        });
        wasi.descriptors.open({ kind: "file", handle: 3, offset: 0, append: false }, 0n, 0n, () => {
          released.push("second");
          throw new Error("second descriptor failed");
        });
        wasi.descriptors.open({ kind: "file", handle: 4, offset: 0, append: false }, 0n, 0n, () => {
          released.push("last");
        });
      },
      run() {
        claimOutcome(outcome, { kind: "signaled", code: 9 });
        return 0;
      },
    },
    { runtimeProcess },
  );
  expect(released).toEqual(["first", "second", "last"]);
  expect(readOutcome(outcome)).toMatchObject({ kind: "signaled", code: 9 });
  expect(() => descriptors!.dispose()).not.toThrow();
  expect(released).toEqual(["first", "second", "last"]);
  expect(result.order).toEqual(["descriptor release", "filesystem release"]);
  expect(
    result.messages.filter((message) => message.type === "exit" || message.type === "error"),
  ).toEqual([]);
  expect(result.messages.filter((message) => message.type === "cleanup-error")).toMatchObject([
    {
      type: "cleanup-error",
      code: 137,
      signal: 9,
      cleanupErrors: [
        expect.stringContaining("first descriptor failed"),
        expect.stringContaining("second descriptor failed"),
      ],
    },
  ]);
  expect(
    result.messages.some(
      (message) => message.type === "runtime-proc" && message.operation === "exit",
    ),
  ).toBe(false);
});

test("filesystem release failure preserves the exit winner without publishing quiescence", async () => {
  const runtimeProcess = createWorkerProcessTransport();
  let restored: (() => void) | undefined;
  try {
    const result = await fixture(
      {
        setup({ fs }) {
          restored = fs.dispose.bind(fs);
          fs.dispose = () => {
            throw new Error("filesystem release failed");
          };
        },
        run() {
          return 23;
        },
      },
      { runtimeProcess },
    );
    expect(readOutcome(workerProcessState(runtimeProcess).signals.outcome)).toMatchObject({
      kind: "exited",
      code: 23,
    });
    expect(
      result.messages.filter((message) => message.type === "exit" || message.type === "error"),
    ).toEqual([]);
    expect(result.messages.filter((message) => message.type === "cleanup-error")).toMatchObject([
      {
        type: "cleanup-error",
        code: 23,
        cleanupErrors: [expect.stringContaining("filesystem release failed")],
      },
    ]);
    expect(
      result.messages.some(
        (message) => message.type === "runtime-proc" && message.operation === "exit",
      ),
    ).toBe(false);
    expect(result.order).toEqual(["descriptor release"]);
  } finally {
    restored?.();
  }
});

test("legacy lifecycle failures still attempt diagnostics, release and completion without overwriting its signal winner", async () => {
  const outcome = new SharedArrayBuffer(8);
  const hooks: string[] = [];
  const result = await fixture({
    outcome,
    beforeFinish() {
      hooks.push("before");
      throw new Error("before failed");
    },
    diagnostic() {
      hooks.push("diagnostic");
      throw new Error("diagnostic failed");
    },
    complete() {
      hooks.push("complete");
      claimOutcome(outcomeWord(outcome), { kind: "signaled", code: 9 });
      throw new Error("complete failed");
    },
    run() {
      throw new Error("guest failed");
    },
  });
  expect(hooks).toEqual(["before", "diagnostic", "complete"]);
  expect(result.order).toEqual(["descriptor release", "filesystem release", "acknowledgement"]);
  expect(
    result.messages.filter((message) => message.type === "exit" || message.type === "error"),
  ).toMatchObject([
    {
      type: "exit",
      code: 137,
      signal: 9,
      cleanupErrors: [
        expect.stringContaining("before failed"),
        expect.stringContaining("diagnostic failed"),
        expect.stringContaining("complete failed"),
      ],
    },
  ]);
});

// Original wasm fixture exports its imported ABI functions so the test observes the real
// bootstrap-selected imports without an unbounded guest loop or a second signal model.
function signalSource(): Uint8Array<ArrayBuffer> {
  const text = (value: string) =>
    [value.length].concat(Array.from(new TextEncoder().encode(value)));
  const section = (id: number, bytes: number[]) => [id, bytes.length].concat(bytes);
  const imported = (name: string, type: number, namespace = "runtime_proc") =>
    text(namespace).concat(text(name), [0, type]);
  const exported = (name: string, kind: number, index: number) => text(name).concat([kind, index]);
  // The bound prevents a broken checkpoint from hanging the test: select fatal once,
  // then execute 10,000 host-call-free loop iterations unless instrumentation traps.
  const loop = [1, 1, 0x7f].concat(
    [0x10, 3, 0x03, 0x40],
    [0x20, 0, 0x41, 1, 0x6a, 0x22, 0],
    [0x41, 0x90, 0xce, 0, 0x49, 0x0d, 0, 0x0b, 0x0b],
  );
  return new Uint8Array(
    [0, 97, 115, 109, 1, 0, 0, 0].concat(
      section(1, [4, 96, 2, 127, 127, 1, 127, 96, 0, 1, 127, 96, 0, 0, 96, 1, 127, 1, 127]),
      section(
        2,
        [4].concat(
          imported("signal", 0),
          imported("interrupted", 1),
          imported("default_signal", 3),
          imported("selectFatal", 2, "checkpoint_fixture"),
        ),
      ),
      section(3, [2, 2, 2]),
      section(5, [1, 0, 1]),
      section(
        7,
        [6].concat(
          exported("signal", 0, 0),
          exported("interrupted", 0, 1),
          exported("default_signal", 0, 2),
          exported("memory", 2, 0),
          exported("_start", 0, 4),
          exported("fatalLoop", 0, 5),
        ),
      ),
      section(10, [2, 2, 0, 11, loop.length].concat(loop)),
    ),
  );
}

for (const interruptible of [false, true])
  test(`handled TERM dequeues only through cooperative ABI (fatal instrumentation=${interruptible})`, async () => {
    const runtimeProcess = createWorkerProcessTransport();
    const state = workerProcessState(runtimeProcess);
    const deliveries: number[] = [];
    const source = signalSource();
    const guest = interruptible
      ? await compileInterruptible(source)
      : new WebAssembly.Module(source);
    const result = await fixture(
      {
        namespaces: () => ({ checkpoint_fixture: { selectFatal: () => {} } }),
        run({ instance }) {
          const signal = instance.exports.signal as (signal: number, mode: number) => number;
          const interrupted = instance.exports.interrupted as () => number;
          expect(signal(15, 2)).toBe(0);
          expect(requestSignal(state.signals, 15).action).toBe("handled");
          // Execute enough instrumented entries to call the fatal checkpoint while TERM
          // is still pending. Checkpoints must neither trap nor dequeue that delivery.
          const tick = instance.exports._start as () => void;
          for (let index = 0; index < 4096; index++) tick();
          expect(controlLoad(state.signals.signalState, 15) & SIGNAL_PENDING).toBe(SIGNAL_PENDING);
          for (let i = 0; i < 3; i++) deliveries.push(interrupted());
          expect(controlLoad(state.signals.signalState, 15) & SIGNAL_PENDING).toBe(0);
          return 0;
        },
      },
      { runtimeProcess, module: guest, interruptible },
    );
    expect(deliveries).toEqual([15, 0, 0]);
    expect(
      result.messages.filter((message) => message.type === "exit" || message.type === "error"),
    ).toMatchObject([{ type: "exit", code: 0 }]);
  });

test("raw-source worker fatal checkpoints stop a CPU loop without consuming handled TERM", async () => {
  const runtimeProcess = createWorkerProcessTransport();
  const state = workerProcessState(runtimeProcess);
  const guest = await compileInterruptible(signalSource());
  let trapped = false;
  const result = await fixture(
    {
      namespaces: () => ({
        checkpoint_fixture: {
          selectFatal() {
            expect(requestSignal(state.signals, 9).action).toBe("default");
          },
        },
      }),
      run({ instance }) {
        const signal = instance.exports.signal as (signal: number, mode: number) => number;
        expect(signal(15, 2)).toBe(0);
        expect(requestSignal(state.signals, 15).action).toBe("handled");
        const loop = instance.exports.fatalLoop as () => void;
        try {
          loop();
        } catch (error) {
          expect(error).toBeInstanceOf(WebAssembly.RuntimeError);
          trapped = true;
        }
        expect(controlLoad(state.signals.signalState, 15) & SIGNAL_PENDING).toBe(SIGNAL_PENDING);
        return 0;
      },
    },
    { runtimeProcess, module: guest, interruptible: true },
  );
  expect(trapped).toBe(true);
  expect(readOutcome(state.signals.outcome)).toMatchObject({ kind: "signaled", code: 9 });
  expect(result.messages.filter((message) => message.type === "exit")).toMatchObject([
    { code: 137, signal: 9 },
  ]);
});

function cwdSource(): Uint8Array<ArrayBuffer> {
  const text = (value: string) =>
    [value.length].concat(Array.from(new TextEncoder().encode(value)));
  const section = (id: number, bytes: number[]) => [id, bytes.length].concat(bytes);
  return Uint8Array.from(
    [0, 97, 115, 109, 1, 0, 0, 0].concat(
      section(1, [2, 96, 2, 127, 127, 1, 127, 96, 0, 0]),
      section(2, [1].concat(text("runtime_proc"), text("cwd"), [0, 0])),
      section(3, [2, 1, 0]),
      section(5, [1, 0, 1]),
      section(7, [3].concat(text("memory"), [2, 0], text("_start"), [0, 1], text("query"), [0, 2])),
      section(10, [2, 2, 0, 11, 8, 0, 32, 0, 32, 1, 16, 0, 11]),
    ),
  );
}
for (const env of [{}, { PWD: "/different" }])
  test(`raw-source cwd import reads root request independently of env ${JSON.stringify(env)}`, async () => {
    const cwd = "/tmp/spec/🧇";
    const bytes = new TextEncoder().encode(cwd);
    const guest = await compileInterruptible(cwdSource());
    let observed = "";
    const result = await fixture(
      {
        run({ instance, request }) {
          const query = instance.exports.query as (ptr: number, capacity: number) => number;
          const memory = instance.exports.memory;
          if (!(memory instanceof WebAssembly.Memory)) throw new Error("missing memory");
          expect(query(0, 0)).toBe(bytes.length);
          expect(query(16, bytes.length)).toBe(bytes.length);
          observed = new TextDecoder().decode(new Uint8Array(memory.buffer, 16, bytes.length));
          expect(request.env).toEqual(env);
          return 0;
        },
      },
      {
        module: guest,
        interruptible: true,
        runtimeProcess: createWorkerProcessTransport({ cwd }),
        env,
      },
    );
    expect(observed).toBe(cwd);
    expect(result.messages.filter((message) => message.type === "exit")).toMatchObject([
      { code: 0 },
    ]);
  });

test("synchronous executor completion selects its outcome before queued guest microtasks", async () => {
  const outcome = new SharedArrayBuffer(8);
  let observed: ReturnType<typeof readOutcome>;
  await fixture({
    outcome,
    run() {
      queueMicrotask(() => {
        observed = readOutcome(outcomeWord(outcome));
      });
      return 23;
    },
  });
  expect(observed!).toMatchObject({ kind: "exited", code: 23 });
});

for (const complete of [false, true])
  test(`startup failure selects typed ENOEXEC before completion (legacy=${complete})`, async () => {
    const outcome = new SharedArrayBuffer(8);
    const missingStart = new WebAssembly.Module(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 0, 1, 7, 10, 1, 6, 109, 101, 109, 111, 114, 121, 2, 0,
      ]),
    );
    const result = await fixture(
      {
        outcome,
        complete: complete
          ? (code, signal) =>
              claimOutcome(
                outcomeWord(outcome),
                signal === undefined
                  ? { kind: "exited", code }
                  : { kind: "signaled", code: signal },
              )
          : undefined,
        run() {
          throw new Error("must not run");
        },
      },
      { module: missingStart },
    );
    expect(readOutcome(outcomeWord(outcome))).toEqual({
      kind: "start-failed",
      code: 8,
      error: "ENOEXEC",
      status: null,
    });
    expect(
      result.messages.filter((message) => message.type === "exit" || message.type === "error"),
    ).toMatchObject([{ code: 126 }]);
  });

// Original tiny module: expose one adapter import and runtime_proc.spawn to the executor.
function extensionModule(): WebAssembly.Module {
  const text = (value: string) =>
    [value.length].concat(Array.from(new TextEncoder().encode(value)));
  const section = (id: number, bytes: number[]) => [id, bytes.length].concat(bytes);
  const imported = (namespace: string, name: string, type: number) =>
    text(namespace).concat(text(name), [0, type]);
  const exported = (name: string, kind: number, index: number) => text(name).concat([kind, index]);
  return new WebAssembly.Module(
    new Uint8Array(
      [0, 97, 115, 109, 1, 0, 0, 0].concat(
        section(1, [3, 96, 0, 1, 127, 96, 2, 127, 127, 1, 127, 96, 0, 0]),
        section(
          2,
          [2].concat(imported("guest_extension", "value", 0), imported("runtime_proc", "spawn", 1)),
        ),
        section(3, [1, 2]),
        section(5, [1, 0, 1]),
        section(
          7,
          [4].concat(
            exported("value", 0, 0),
            exported("spawn", 0, 1),
            exported("memory", 2, 0),
            exported("_start", 0, 2),
          ),
        ),
        section(10, [1, 2, 0, 11]),
      ),
    ),
  );
}

test("executor hooks link extra namespaces after setup and before instantiation, preserving reserved spawn authority", async () => {
  const runtimeProcess = createWorkerProcessTransport();
  const order: string[] = [];
  const metadata = new SharedArrayBuffer(8);
  const result = await fixture(
    {
      setup() {
        order.push("setup");
      },
      namespaces({ request }) {
        expect(request.runtimeProcess).toBe(runtimeProcess);
        order.push("namespaces");
        return { guest_extension: { value: () => 7 }, runtime_proc: { spawn: () => -99 } };
      },
      beforeBindings({ wasi }) {
        order.push("beforeBindings");
        expect(wasi.descriptors.get(3)?.preopen).toBe("/");
      },
      imports(imports, { wasi }) {
        order.push("imports");
        expect(wasi.descriptors.get(3)?.preopen).toBe("/");
        expect((imports.guest_extension!.value as () => number)()).toBe(7);
        return { ...imports, guest_extension: { value: () => 23 } };
      },
      spawnData() {
        order.push("spawnData");
        return { metadata, filesystem: "forbidden", pipeRegistry: "forbidden" };
      },
      instantiated({ wasi, instance }) {
        order.push("instantiated");
        expect(wasi.descriptors.get(3)?.preopen).toBe("/");
        expect((instance.exports.value as () => number)()).toBe(23);
      },
      run({ instance }) {
        order.push("run");
        const request = new TextEncoder().encode(
          JSON.stringify({ executable: "fixture", argv: [], env: {}, cwd: "/", job: 0, fds: [] }),
        );
        new Uint8Array((instance.exports.memory as WebAssembly.Memory).buffer).set(request);
        expect(
          (instance.exports.spawn as (ptr: number, size: number) => number)(0, request.length),
        ).toBeGreaterThan(0);
        return 0;
      },
    },
    { runtimeProcess, module: extensionModule() },
  );
  expect(order).toEqual([
    "setup",
    "namespaces",
    "beforeBindings",
    "imports",
    "instantiated",
    "run",
    "spawnData",
  ]);
  const spawn = result.messages.find(
    (message) => message.type === "runtime-proc" && message.operation === "spawn",
  );
  expect(spawn).toBeDefined();
  if (spawn?.type !== "runtime-proc" || spawn.operation !== "spawn") throw new Error("no spawn");
  expect(spawn.transport.data).toMatchObject({ metadata });
  expect((spawn.transport.data as Record<string, unknown>).filesystem).toBeObject();
  expect((spawn.transport.data as Record<string, unknown>).pipeRegistry).toBeObject();
});

function armingRequest(
  filesystem: RuntimeWorkerRequest["filesystem"],
  extras: Pick<Partial<RuntimeWorkerRequest>, "runtimeProcess" | "outcome"> = {},
): RuntimeWorkerRequest {
  return {
    module: guestModule({
      namespace: "extension",
      name: "start",
      params: [],
      startSection: false,
      body: [16, 0, 26],
    }),
    args: [],
    env: {},
    filesystem,
    ...extras,
  };
}

function armingExecutor(
  start: () => void,
  release: () => void = () => {},
): Pick<WorkerExecutor, "setup" | "namespaces"> {
  return {
    setup({ fs }) {
      fs.preopen = () => 1;
      fs.retain = () => {};
      fs.release = release;
    },
    namespaces() {
      return {
        extension: {
          start() {
            start();
            return 0;
          },
        },
      };
    },
  };
}

function armingHost(messages: RuntimeWorkerMessage[]) {
  return {
    crossOriginIsolated: true,
    postMessage(message: RuntimeWorkerMessage) {
      messages.push(message);
    },
  };
}

test("awaited instantiated arming completes before entry and reuses ProcessABI context", async () => {
  const connection = createFilesystemConnection();
  const runtimeProcess = createWorkerProcessTransport();
  let starts = 0;
  let runProcess: unknown;
  let instantiatedProcess: unknown;
  try {
    await bootstrap(
      armingRequest(connection.client, { runtimeProcess }),
      {
        ...armingExecutor(() => {
          starts++;
        }),
        async instantiated(context) {
          instantiatedProcess = context.process;
          await Promise.resolve();
        },
        run(context) {
          runProcess = context.process;
          return 0;
        },
      },
      {
        crossOriginIsolated: true,
        postMessage() {},
      },
    );
    expect(starts).toBe(1);
    expect(instantiatedProcess).toBeDefined();
    expect(runProcess).toBe(instantiatedProcess);
  } finally {
    connection.client.port.close();
    connection.server.port.close();
  }
});

test("awaited instantiated arming rejection prevents guest entry", async () => {
  const connection = createFilesystemConnection();
  const messages: RuntimeWorkerMessage[] = [];
  let starts = 0;
  let runs = 0;
  try {
    await bootstrap(
      armingRequest(connection.client),
      {
        ...armingExecutor(() => {
          starts++;
        }),
        async instantiated() {
          await Promise.resolve();
          throw new Error("arm failed");
        },
        run() {
          runs++;
          return 0;
        },
      },
      armingHost(messages),
    );
    expect(starts).toBe(0);
    expect(runs).toBe(0);
    expect(messages.filter((message) => message.type === "error")).toMatchObject([
      { code: 126, message: expect.stringContaining("arm failed") },
    ]);
  } finally {
    connection.client.port.close();
    connection.server.port.close();
  }
});

test("finish during awaited instantiated arming prevents guest entry and cleans up once", async () => {
  const connection = createFilesystemConnection();
  const messages: RuntimeWorkerMessage[] = [];
  const armStarted = Promise.withResolvers<void>();
  const releaseArm = Promise.withResolvers<void>();
  let starts = 0;
  let runs = 0;
  let releases = 0;
  try {
    const pending = bootstrap(
      armingRequest(connection.client),
      {
        ...armingExecutor(
          () => {
            starts++;
          },
          () => {
            releases++;
          },
        ),
        async instantiated(context) {
          armStarted.resolve();
          context.finish({ code: 23 });
          await releaseArm.promise;
        },
        run() {
          runs++;
          return 0;
        },
      },
      armingHost(messages),
    );
    await armStarted.promise;
    releaseArm.resolve();
    await pending;
    expect(starts).toBe(0);
    expect(runs).toBe(0);
    expect(releases).toBe(1);
    expect(messages.filter((message) => message.type === "exit")).toMatchObject([{ code: 23 }]);
  } finally {
    connection.client.port.close();
    connection.server.port.close();
  }
});

test("filesystem revoke during arming is caught before guest entry", async () => {
  const connection = createFilesystemConnection();
  const messages: RuntimeWorkerMessage[] = [];
  const armStarted = Promise.withResolvers<void>();
  const releaseArm = Promise.withResolvers<void>();
  let starts = 0;
  let runs = 0;
  try {
    const pending = bootstrap(
      armingRequest(connection.client),
      {
        ...armingExecutor(() => {
          starts++;
        }),
        async instantiated() {
          armStarted.resolve();
          await releaseArm.promise;
        },
        run() {
          runs++;
          return 0;
        },
      },
      armingHost(messages),
    );
    await armStarted.promise;
    revokeFilesystem(connection.client);
    releaseArm.resolve();
    await pending;
    expect(starts).toBe(0);
    expect(runs).toBe(0);
    expect(messages.filter((message) => message.type === "exit")).toMatchObject([{ code: 1 }]);
  } finally {
    connection.client.port.close();
    connection.server.port.close();
  }
});

test("external terminal outcome during arming prevents guest entry", async () => {
  const connection = createFilesystemConnection();
  const outcome = new SharedArrayBuffer(8);
  const messages: RuntimeWorkerMessage[] = [];
  const armStarted = Promise.withResolvers<void>();
  const releaseArm = Promise.withResolvers<void>();
  let starts = 0;
  let runs = 0;
  try {
    const pending = bootstrap(
      armingRequest(connection.client, { outcome }),
      {
        ...armingExecutor(() => {
          starts++;
        }),
        async instantiated() {
          armStarted.resolve();
          await releaseArm.promise;
        },
        run() {
          runs++;
          return 0;
        },
      },
      armingHost(messages),
    );
    await armStarted.promise;
    claimOutcome(outcomeWord(outcome), { kind: "signaled", code: 9 });
    releaseArm.resolve();
    await pending;
    expect(starts).toBe(0);
    expect(runs).toBe(0);
    expect(messages.filter((message) => message.type === "exit")).toMatchObject([
      { code: 137, signal: 9 },
    ]);
  } finally {
    connection.client.port.close();
    connection.server.port.close();
  }
});

test("cancellation queued after arming still prevents guest entry", async () => {
  const connection = createFilesystemConnection();
  const outcome = new SharedArrayBuffer(8);
  const messages: RuntimeWorkerMessage[] = [];
  let starts = 0;
  let runs = 0;
  try {
    await bootstrap(
      armingRequest(connection.client, { outcome }),
      {
        ...armingExecutor(() => {
          starts++;
        }),
        async instantiated() {
          await Promise.resolve();
          queueMicrotask(() => claimOutcome(outcomeWord(outcome), { kind: "signaled", code: 9 }));
        },
        run() {
          runs++;
          return 0;
        },
      },
      armingHost(messages),
    );
    expect(starts).toBe(0);
    expect(runs).toBe(0);
    expect(messages.filter((message) => message.type === "exit")).toMatchObject([
      { code: 137, signal: 9 },
    ]);
  } finally {
    connection.client.port.close();
    connection.server.port.close();
  }
});

test("beforeBindings can release default stdio while fd3 inheritance preserves the root preopen", async () => {
  const runtimeProcess = createWorkerProcessTransport();
  runtimeProcess.resources.push({ kind: "web-terminal", target: 0 });
  runtimeProcess.bindings.push({ fd: 3, reference: 0, rightsBase: 0n, rightsInheriting: 0n });
  let closed = 0;
  const result = await fixture(
    {
      stdio: {
        0: {
          kind: "terminal",
          read: () => 0,
          write: () => 0,
          readiness: () => ({ readable: true, writable: true, hangup: true }),
          close() {
            closed++;
          },
        },
      },
      beforeBindings({ wasi }) {
        for (const fd of [0, 1, 2]) wasi.descriptors.close(fd);
        // Waffle reserved fd3 before constructing the root preopen, so the root is already at fd4.
      },
      resolveTerminal(target) {
        expect(target).toBe(0);
        return {
          kind: "terminal",
          read: (chunks) => {
            chunks[0]![0] = 65;
            return 1;
          },
          write: () => 0,
          readiness: () => ({ readable: true, writable: false, hangup: false }),
          close() {
            closed++;
          },
        };
      },
      instantiated({ wasi }) {
        expect(closed).toBe(1);
        expect(wasi.descriptors.get(4)?.preopen).toBe("/");
        const terminal = wasi.descriptors.get(3)!.resource;
        if (terminal.kind !== "terminal") throw new Error("not terminal");
        const data = new Uint8Array(1);
        expect(terminal.read([data])).toBe(1);
        expect(data[0]).toBe(65);
      },
      run: () => 0,
    },
    { runtimeProcess },
  );
  expect(closed).toBe(2);
  expect(result.messages.filter((message) => message.type === "exit")).toMatchObject([{ code: 0 }]);
});

for (const append of [false, true])
  test(`executor post follows live files and shared offsets (append=${append})`, async () => {
    const { shareFileResource } = await import("../core/open-file.js");
    const writes: [number, string][] = [];
    const result = await fixture({
      instantiated({ wasi, fs, post }) {
        const resource = { kind: "file" as const, handle: 17, offset: 4, append };
        const alias = wasi.descriptors.open(resource, 1n << 6n, 0n);
        shareFileResource(resource, fs.connection);
        fs.write = (_handle, chunks, offset) => {
          writes.push([offset, new TextDecoder().decode(chunks[0])]);
          return chunks[0]!.length;
        };
        fs.append = (_handle, chunks) => {
          writes.push([99, new TextDecoder().decode(chunks[0])]);
          return { written: chunks[0]!.length, offset: 100 };
        };
        wasi.descriptors.inherit(1, wasi.descriptors.get(alias)!);
        wasi.descriptors.inherit(2, wasi.descriptors.get(alias)!);
        expect(post("stdout", new Uint8Array())).toBe(true);
        expect(resource.offset).toBe(4);
        expect(writes).toEqual([]);
        expect(post("stdout", new Uint8Array([65]))).toBe(true);
        expect(resource.offset).toBe(append ? 100 : 5);
        expect(post("stderr", new Uint8Array([66]))).toBe(true);
        expect(resource.offset).toBe(append ? 100 : 6);
        wasi.descriptors.close(1);
        expect(post("stdout", new Uint8Array([67]))).toBe(false);
      },
      run: () => 0,
    });
    expect(writes).toEqual(
      append
        ? [
            [99, "A"],
            [99, "B"],
          ]
        : [
            [4, "A"],
            [5, "B"],
          ],
    );
    expect(
      result.messages.some((message) => message.type === "stdout" || message.type === "stderr"),
    ).toBe(false);
  });

test("executor post uses blocking live pipe writes and reports partial-write backpressure", async () => {
  let staleWrites = 0,
    writes = 0;
  const result = await fixture({
    stdio: {
      1: {
        kind: "terminal",
        read: () => 0,
        write: () => {
          staleWrites++;
          return 1;
        },
        readiness: () => ({ readable: false, writable: true, hangup: false }),
      },
    },
    instantiated({ wasi, post }) {
      const fd = wasi.descriptors.open(
        {
          kind: "pipe",
          read: () => 0,
          write(chunks) {
            writes++;
            return chunks[0]!.length - 1;
          },
          tryWrite() {
            throw new Error("post must use blocking stream I/O");
          },
          readiness: () => ({ readable: false, writable: true, hangup: false }),
        },
        1n << 6n,
        0n,
      );
      wasi.descriptors.inherit(1, wasi.descriptors.get(fd)!);
      expect(post("stdout", new Uint8Array([65, 66]))).toBe(false);
    },
    run: () => 0,
  });
  expect(writes).toBe(1);
  expect(staleWrites).toBe(0);
  expect(result.messages.some((message) => message.type === "stdout")).toBe(false);
});

test("an inherited terminal alias keeps its destination when that target fd is redirected", async () => {
  const runtimeProcess = createWorkerProcessTransport();
  runtimeProcess.resources.push({ kind: "web-terminal", target: 1 });
  runtimeProcess.bindings.push({ fd: 2, reference: 0, rightsBase: 1n << 6n, rightsInheriting: 0n });
  const result = await fixture(
    {
      instantiated({ wasi, fs, post }) {
        fs.write = () => {
          throw new Error("terminal provenance must not follow fd1's file redirect");
        };
        const file = wasi.descriptors.open(
          { kind: "file", handle: 17, offset: 0, append: false },
          0n,
          0n,
        );
        wasi.descriptors.inherit(1, wasi.descriptors.get(file)!);
        expect(post("stderr", new Uint8Array([65]))).toBe(true);
      },
      run: () => 0,
    },
    { runtimeProcess },
  );
  expect(
    result.messages.filter((message) => message.type === "stdout" || message.type === "stderr"),
  ).toEqual([{ type: "stdout", data: new Uint8Array([65]) }]);
});

// Original fixture builder, not copied from an upstream implementation.
function guestModule(options: {
  namespace: string;
  name: string;
  params: number[];
  body: number[];
  importedMemory?: boolean;
  startSection?: boolean;
}): WebAssembly.Module {
  const text = (value: string) =>
    [value.length].concat(Array.from(new TextEncoder().encode(value)));
  const section = (id: number, bytes: number[]) => [id, bytes.length].concat(bytes);
  const exported = (name: string, kind: number, index: number) => text(name).concat([kind, index]);
  const imported = text(options.namespace).concat(text(options.name), [0, 0]);
  const memory = text("env").concat(text("memory"), [2, 0, 1]);
  const body = [0].concat(options.body, [11]);
  return new WebAssembly.Module(
    new Uint8Array(
      [0, 97, 115, 109, 1, 0, 0, 0].concat(
        section(1, [2, 96, options.params.length].concat(options.params, [1, 127, 96, 0, 0])),
        section(2, options.importedMemory ? [2].concat(memory, imported) : [1].concat(imported)),
        section(3, options.startSection ? [2, 1, 1] : [1, 1]),
        options.importedMemory ? [] : section(5, [1, 0, 1]),
        section(
          7,
          [2].concat(exported("memory", 2, 0), exported("_start", 0, options.startSection ? 2 : 1)),
        ),
        options.startSection ? section(8, [1]) : [],
        section(
          10,
          options.startSection
            ? [2, body.length].concat(body, [2, 0, 11])
            : [1, body.length].concat(body),
        ),
      ),
    ),
  );
}

for (const hook of ["setup", "namespaces", "beforeBindings", "imports", "instantiated"] as const) {
  for (const action of ["finish", "throw"] as const)
    test(`${hook} ${action} stops bootstrap and releases owned stdio exactly once`, async () => {
      let starts = 0,
        runs = 0,
        closed = 0;
      const seen: string[] = [];
      const stop = (name: string, context: import("../browser/worker.js").WorkerSetupContext) => {
        seen.push(name);
        if (name !== hook) return;
        if (action === "throw") throw new Error(`failed ${hook}`);
        context.finish({ code: 126 });
      };
      const guest = guestModule({
        namespace: "extension",
        name: "start",
        params: [],
        body: [16, 0, 26],
      });
      const result = await fixture(
        {
          stdio: {
            1: {
              kind: "terminal",
              read: () => 0,
              write: () => 0,
              readiness: () => ({ readable: false, writable: true, hangup: false }),
              close() {
                closed++;
              },
            },
          },
          setup(context) {
            stop("setup", context);
          },
          namespaces(context) {
            stop("namespaces", context);
            return {
              extension: {
                start() {
                  starts++;
                  return 0;
                },
              },
            };
          },
          beforeBindings(context) {
            stop("beforeBindings", context);
          },
          imports(_imports, context) {
            stop("imports", context);
          },
          instantiated(context) {
            stop("instantiated", context);
          },
          run() {
            runs++;
            return 0;
          },
        },
        { module: guest, runtimeProcess: createWorkerProcessTransport() },
      );
      expect(seen.at(-1)).toBe(hook);
      expect(starts).toBe(0);
      expect(runs).toBe(0);
      expect(closed).toBe(1);
      expect(
        result.messages.filter((message) => message.type === "exit" || message.type === "error"),
      ).toHaveLength(1);
      expect(result.order.at(-1)).toBe("acknowledgement");
    });
}

for (const inherited of [false, true])
  test(`post honors fd write rights (inherited=${inherited})`, async () => {
    const runtimeProcess = inherited ? createWorkerProcessTransport() : undefined;
    if (runtimeProcess) {
      runtimeProcess.resources.push({ kind: "web-terminal", target: 1 });
      runtimeProcess.bindings.push({ fd: 1, reference: 0, rightsBase: 0n, rightsInheriting: 0n });
    }
    let writes = 0;
    const result = await fixture(
      {
        resolveTerminal() {
          return {
            kind: "terminal",
            read: () => 0,
            write() {
              writes++;
              return 1;
            },
            readiness: () => ({ readable: false, writable: true, hangup: false }),
          };
        },
        run({ wasi, post }) {
          if (!inherited) wasi.descriptors.get(1)!.rightsBase = 0n;
          expect(post("stdout", new Uint8Array([65]))).toBe(false);
          expect(post("stdout", new Uint8Array())).toBe(false);
          return 0;
        },
      },
      { runtimeProcess },
    );
    expect(writes).toBe(0);
    expect(result.messages.some((message) => message.type === "stdout")).toBe(false);
  });

function spawnWithFds(
  instance: WebAssembly.Instance,
  fds: { parent: number; child: number }[],
): number {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ executable: "fixture", argv: [], env: {}, cwd: "/", job: 0, fds }),
  );
  new Uint8Array((instance.exports.memory as WebAssembly.Memory).buffer).set(bytes);
  return (instance.exports.spawn as (ptr: number, count: number) => number)(0, bytes.length);
}

for (const moved of [false, true])
  test(`default terminal provenance survives beforeBindings relocation (stdio-slot=${moved})`, async () => {
    const result = await fixture(
      {
        namespaces: () => ({ guest_extension: { value: () => 0 } }),
        beforeBindings({ wasi }) {
          if (moved) wasi.descriptors.inherit(0, wasi.descriptors.get(1)!);
          else expect(wasi.descriptors.dup(1)).toBe(4);
          wasi.descriptors.close(1);
        },
        run({ instance }) {
          expect(spawnWithFds(instance, [{ parent: moved ? 0 : 4, child: 7 }])).toBeGreaterThan(0);
          return 0;
        },
      },
      { module: extensionModule(), runtimeProcess: createWorkerProcessTransport() },
    );
    const spawn = result.messages.find(
      (message) => message.type === "runtime-proc" && message.operation === "spawn",
    );
    if (spawn?.type !== "runtime-proc" || spawn.operation !== "spawn")
      throw new Error("missing spawn");
    expect(spawn.transport.resources).toEqual([{ kind: "web-terminal", target: 1 }]);
  });

test("terminal provenance outranks a real resolved PipeEndpoint when spawning the next generation", async () => {
  const { PipeController } = await import("../proc/pipes.js");
  const runtimeProcess = createWorkerProcessTransport(),
    pipe = new PipeController({ relay: "manual" });
  const pid = workerProcessState(runtimeProcess).pid,
    reader = pipe.retain(pid, "read"),
    writer = pipe.retain(pid, "write");
  runtimeProcess.resources.push({ kind: "web-terminal", target: 1 });
  runtimeProcess.bindings.push({ fd: 1, reference: 0, rightsBase: 1n << 6n, rightsInheriting: 0n });
  try {
    const result = await fixture(
      {
        namespaces: () => ({ guest_extension: { value: () => 0 } }),
        resolveTerminal: () => writer,
        run({ instance }) {
          expect(spawnWithFds(instance, [{ parent: 1, child: 1 }])).toBeGreaterThan(0);
          return 0;
        },
      },
      { module: extensionModule(), runtimeProcess },
    );
    const spawn = result.messages.find(
      (message) => message.type === "runtime-proc" && message.operation === "spawn",
    );
    if (spawn?.type !== "runtime-proc" || spawn.operation !== "spawn")
      throw new Error("missing spawn");
    expect(spawn.transport.resources).toEqual([{ kind: "web-terminal", target: 1 }]);
    expect(reader.tryRead([new Uint8Array(1)])).toBe(0);
  } finally {
    writer.close();
    reader.close();
    pipe.dispose();
  }
});

test("supplied class streams keep immediate I/O, process capabilities and prototype cleanup", async () => {
  const { PipeController, PipeEndpoint } = await import("../proc/pipes.js");
  const pipe = new PipeController({ relay: "manual" });
  const reader = pipe.retain(1, "read"),
    writer = pipe.retain(1, "write");
  try {
    const result = await fixture({
      stdio: { 1: writer },
      run({ wasi }) {
        const stream = wasi.descriptors.get(1)!.resource as import("../core/descriptors.js").Stream;
        expect(stream).toBeInstanceOf(PipeEndpoint);
        expect(stream.notification).toBeDefined();
        expect(stream.tryWrite?.([new Uint8Array([65])])).toBe(1);
        const child = stream.forProcess!(2);
        expect(child).toBeInstanceOf(PipeEndpoint);
        expect(child.tryWrite?.([new Uint8Array([66])])).toBe(1);
        child.close!();
        return 0;
      },
    });
    expect(result.messages.filter((message) => message.type === "exit")).toMatchObject([
      { code: 0 },
    ]);
    expect(reader.tryRead([new Uint8Array(2)])).toBe(1);
    expect(reader.tryRead([new Uint8Array(2)])).toBe(1);
    expect(reader.tryRead([new Uint8Array(1)])).toBe(0);
  } finally {
    writer.close();
    reader.close();
    pipe.dispose();
  }
});

for (const mode of ["unchanged", "mutated", "replaced"] as const)
  test(`imports hook cannot retarget memory used by a real Wasm start section (${mode})`, async () => {
    const a = new WebAssembly.Memory({ initial: 1 }),
      b = new WebAssembly.Memory({ initial: 1 });
    const guest = guestModule({
      namespace: "wasi_snapshot_preview1",
      name: "environ_sizes_get",
      params: [127, 127],
      importedMemory: true,
      startSection: true,
      body: [65, 0, 65, 4, 16, 0, 26],
    });
    const result = await fixture(
      {
        env: () => ({ A: "b" }),
        namespaces: () => ({ env: { memory: a } }),
        imports(imports) {
          if (mode === "mutated") imports.env!.memory = b;
          if (mode === "replaced") return { ...imports, env: { memory: b } };
        },
        run: () => 0,
      },
      { module: guest },
    );
    expect(Array.from(new Uint32Array(a.buffer, 0, 2))).toEqual(
      mode === "unchanged" ? [1, 4] : [0, 0],
    );
    expect(Array.from(new Uint32Array(b.buffer, 0, 2))).toEqual([0, 0]);
    expect(
      result.messages.filter((message) => message.type === "exit" || message.type === "error"),
    ).toMatchObject(
      mode === "unchanged"
        ? [{ type: "exit", code: 0 }]
        : [
            {
              type: "error",
              code: 126,
              message: expect.stringContaining("cannot replace imported memory"),
            },
          ],
    );
  });

test("WASI diagnostics follow configured live stderr without recursing through a default terminal", async () => {
  const captured: string[] = [];
  const guest = guestModule({
    namespace: "wasi_snapshot_preview1",
    name: "fd_fdstat_get",
    params: [127, 127],
    body: [65, 1, 65, 255, 255, 3, 16, 0, 26],
  });
  const result = await fixture(
    {
      stdio: {
        2: {
          kind: "terminal",
          read: () => 0,
          write(chunks) {
            captured.push(new TextDecoder().decode(chunks[0]));
            return chunks[0]!.length;
          },
          readiness: () => ({ readable: false, writable: true, hangup: false }),
        },
      },
      run: () => 0,
    },
    { module: guest },
  );
  expect(captured).toHaveLength(1);
  expect(captured[0]).toContain("[wasi] fd_fdstat_get failed: RangeError");
  expect(result.messages.some((message) => message.type === "stderr")).toBe(false);
});

for (const signal of [17, 18, 23, 28])
  test(`generic bootstrap default signal ${signal} ignores without revoking the worker`, async () => {
    const result = await fixture({
      run(context) {
        context.defaultSignal(signal);
        context.checkActive();
        return 23;
      },
    });
    expect(result.messages.find((message) => message.type === "exit")).toMatchObject({
      type: "exit",
      code: 23,
    });
    expect(
      result.messages.some(
        (message) => message.type === "default-signal" || message.type === "error",
      ),
    ).toBe(false);
  });

for (const signal of [19, 20, 21, 22, 32, 33])
  test(`generic bootstrap rejects unsupported default signal ${signal} without selecting death`, async () => {
    const result = await fixture({
      run(context) {
        expect(() => context.defaultSignal(signal)).toThrow(/signal/);
        context.checkActive();
        return 0;
      },
    });
    expect(result.messages.find((message) => message.type === "exit")).toMatchObject({
      type: "exit",
      code: 0,
    });
  });

test("generic runtime_proc default_signal validates with WASI errno and returns zero for ignored defaults", async () => {
  const result = await fixture(
    {
      namespaces: () => ({ checkpoint_fixture: { selectFatal: () => {} } }),
      run({ instance }) {
        const applyDefault = instance.exports.default_signal as (signal: number) => number;
        for (const signal of [17, 18, 23, 28]) expect(applyDefault(signal)).toBe(0);
        for (const signal of [19, 20, 21, 22]) expect(applyDefault(signal)).toBe(-58);
        for (const signal of [0, 32, 33, 65]) expect(applyDefault(signal)).toBe(-28);
        const signal = instance.exports.signal as (signal: number, mode: number) => number;
        expect(signal(15, 2)).toBe(-52); // No signal adapter installed: WASI ENOSYS.
        return 23;
      },
    },
    { module: new WebAssembly.Module(signalSource()) },
  );
  expect(result.messages.find((message) => message.type === "exit")).toMatchObject({ code: 23 });
});

test("generic default-ignore action cannot discard an already selected KILL", async () => {
  const outcome = outcomeWord();
  const result = await fixture({
    outcome,
    run(context) {
      claimOutcome(outcome, { kind: "signaled", code: 9 });
      let thrown: unknown;
      try {
        context.defaultSignal(18);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(RuntimeWorkerSignal);
      expect((thrown as RuntimeWorkerSignal).signal).toBe(9);
      return 0;
    },
  });
  expect(result.messages.find((message) => message.type === "exit")).toMatchObject({
    code: 137,
    signal: 9,
  });
});

for (const winner of [
  { kind: "exited", code: 0 },
  { kind: "exited", code: 23 },
  { kind: "start-failed", code: 13 },
] as const) {
  test(`generic default action preserves existing ${winner.kind} ${winner.code} without signal unwind`, async () => {
    const { WasiExit } = await import("../core/index.js");
    const { waitStatus } = await import("../proc/wait-status.js");
    const runtimeProcess = createWorkerProcessTransport(),
      state = workerProcessState(runtimeProcess);
    let signalCalls = 0;
    const preserve = (context: import("../browser/worker.js").WorkerExecutionContext) => {
      const selected = claimOutcome(state.signals.outcome, winner);
      let thrown: unknown;
      try {
        context.defaultSignal(18);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(WasiExit);
      expect((thrown as InstanceType<typeof WasiExit>).code).toBe(waitStatus(selected));
    };
    const result = await fixture(
      {
        signalError() {
          signalCalls++;
          throw new Error("must not signal a non-signaled winner");
        },
        // START_FAILED can only be selected before entry, not from an executing guest.
        instantiated: winner.kind === "start-failed" ? preserve : undefined,
        run(context) {
          if (winner.kind !== "start-failed") preserve(context);
          return 0;
        },
      },
      { runtimeProcess },
    );
    expect(signalCalls).toBe(0);
    expect(result.messages.find((message) => message.type === "exit")).toMatchObject({
      code: winner.kind === "start-failed" ? 126 : winner.code,
      signal: undefined,
    });
  });
}

test("generic bootstrap preview1 polling treats stale process wake hints as advisory", async () => {
  const runtimeProcess = createWorkerProcessTransport(),
    state = workerProcessState(runtimeProcess);
  controlStore(state.signals.interrupt, 0, 17);
  let polled = false;
  const result = await fixture(
    {
      run({ wasi, instance }) {
        const view = new DataView((instance.exports.memory as WebAssembly.Memory).buffer);
        view.setUint8(8, 0); // An expired clock is ready even though the discarded wake remains.
        view.setUint32(16, 1, true);
        view.setBigUint64(24, 0n, true);
        const poll = (
          wasi as unknown as { functions(): Record<string, (...args: number[]) => number> }
        ).functions().poll_oneoff!;
        expect(poll(0, 1024, 1, 2048)).toBe(0);
        expect(view.getUint32(2048, true)).toBe(1);
        polled = true;
        return 0;
      },
    },
    { runtimeProcess },
  );
  expect(polled).toBe(true);
  expect(
    result.messages.filter((message) => message.type === "exit" || message.type === "error"),
  ).toMatchObject([{ type: "exit", code: 0 }]);
});

test("executor-only bootstrap polls authoritative signal readiness without consuming delivery", async () => {
  const interrupt = new SharedArrayBuffer(4),
    requestedSignal = new SharedArrayBuffer(4),
    outcome = outcomeWord();
  const signals = {
    interrupt: new Int32Array(interrupt),
    requestedSignal: new Int32Array(requestedSignal),
    outcome,
    signalState: createSignalState(),
  };
  let checks = 0;
  const result = await fixture({
    interrupt,
    requestedSignal,
    outcome,
    interruptPending: () => signalPending(signals),
    run({ wasi, instance, runtimeState }) {
      expect(runtimeState).toBeNull();
      const view = new DataView((instance.exports.memory as WebAssembly.Memory).buffer);
      view.setUint8(8, 0);
      view.setUint32(16, 1, true);
      view.setBigUint64(24, 0n, true); // Expired clock.
      const poll = (
        wasi as unknown as { functions(): Record<string, (...args: number[]) => number> }
      ).functions().poll_oneoff!;
      const clockReady = () => {
        expect(poll(0, 1024, 1, 2048)).toBe(0);
        expect(view.getUint32(2048, true)).toBe(1);
        checks++;
      };
      // A delayed publisher can leave a hint after registration discards delivery.
      Atomics.store(signals.interrupt, 0, 17);
      clockReady();
      clockReady();
      setSignalDisposition(signals.signalState, 17, 2, signals.interrupt);
      requestSignal(signals, 17);
      expect(poll(0, 1024, 1, 2048)).toBe(27);
      expect(poll(0, 1024, 1, 2048)).toBe(27); // Readiness must not dequeue it.
      expect(takeSignal(signals.signalState, signals.interrupt)).toBe(17);
      clockReady();
      requestSignal(signals, 17);
      setSignalDisposition(signals.signalState, 17, 0, signals.interrupt);
      Atomics.store(signals.interrupt, 0, 17); // A late advisory rearm is not readiness.
      clockReady();
      return 0;
    },
  });
  expect(checks).toBe(4);
  expect(
    result.messages.filter((message) => message.type === "exit" || message.type === "error"),
  ).toMatchObject([{ type: "exit", code: 0 }]);
});

for (const transport of ["interrupt", "requestedSignal", "signal"] as const) {
  test(`executor-owned ${transport} without authoritative readiness fails before setup or guest execution`, async () => {
    let setup = false,
      ran = false,
      closed = 0;
    const result = await fixture({
      [transport]: transport === "signal" ? () => 0 : new SharedArrayBuffer(4),
      stdio: {
        1: {
          kind: "terminal",
          read: () => 0,
          write: () => 0,
          readiness: () => ({ readable: false, writable: true, hangup: false }),
          close() {
            closed++;
          },
        },
      },
      setup() {
        setup = true;
      },
      run() {
        ran = true;
        return 0;
      },
    });
    expect(setup).toBe(false);
    expect(ran).toBe(false);
    expect(closed).toBe(1);
    expect(
      result.messages.filter((message) => message.type === "exit" || message.type === "error"),
    ).toMatchObject([
      {
        type: "error",
        code: 126,
        message: expect.stringContaining(
          "WorkerExecutor.interruptPending is required for executor-owned signal transports",
        ),
      },
    ]);
  });
}

for (const phase of ["entry", "start-section", "trap"] as const)
  test(`startup observation distinguishes ${phase} at the actual guest boundary`, async () => {
    const { startStatus } = await import("../proc/outcome.js");
    const transport = createWorkerProcessTransport(),
      state = workerProcessState(transport);
    let entered = false,
      ready = false;
    const guest = guestModule(
      phase === "start-section"
        ? {
            namespace: "wasi_snapshot_preview1",
            name: "proc_exit",
            params: [127],
            body: [65, 23, 16, 0, 26],
            startSection: true,
          }
        : {
            namespace: "extension",
            name: "observe",
            params: [],
            body: phase === "trap" ? [0] : [16, 0, 26],
          },
    );
    const result = await fixture(
      {
        setup() {
          expect(startStatus(state.signals.outcome)).toBe(-6);
        },
        namespaces() {
          return {
            extension: {
              observe() {
                entered = true;
                expect(startStatus(state.signals.outcome)).toBe(0);
                expect(readOutcome(state.signals.outcome)).toBeNull();
                return 0;
              },
            },
          };
        },
        instantiated() {
          ready = true;
          expect(startStatus(state.signals.outcome)).toBe(-6);
        },
        run() {
          return 127;
        },
      },
      { module: guest, runtimeProcess: transport },
    );
    expect(startStatus(state.signals.outcome)).toBe(phase === "start-section" ? -11 : 0);
    expect(readOutcome(state.signals.outcome)).toEqual({
      kind: "exited",
      code: phase === "entry" ? 127 : phase === "start-section" ? 23 : 1,
      status: phase === "entry" ? 127 : phase === "start-section" ? 23 : 1,
    });
    expect(ready).toBe(phase !== "start-section");
    expect(entered).toBe(phase === "entry");
    expect(result.messages.some((message) => message.type === "error")).toBe(phase === "trap");
  });

test("a kill after the ready hook but before entry prevents every guest instruction", async () => {
  const { startStatus } = await import("../proc/outcome.js");
  const transport = createWorkerProcessTransport(),
    state = workerProcessState(transport);
  let entered = false;
  await fixture(
    {
      instantiated() {
        claimOutcome(state.signals.outcome, { kind: "signaled", code: 9 });
      },
      namespaces() {
        return {
          extension: {
            observe() {
              entered = true;
              return 0;
            },
          },
        };
      },
      run() {
        throw new Error("must not run after pre-entry kill");
      },
    },
    {
      runtimeProcess: transport,
      module: guestModule({
        namespace: "extension",
        name: "observe",
        params: [],
        body: [16, 0, 26],
      }),
    },
  );
  expect(entered).toBe(false);
  expect(startStatus(state.signals.outcome)).toBe(-11);
  expect(readOutcome(state.signals.outcome)).toEqual({ kind: "signaled", code: 9, status: 137 });
});

// Independent imported effects observe Wasm instantiation and _start, not terminal I/O.
function terminalEntryModule(): WebAssembly.Module {
  const text = (value: string) =>
    [value.length].concat(Array.from(new TextEncoder().encode(value)));
  const section = (id: number, bytes: number[]) => [id, bytes.length].concat(bytes);
  const imported = (field: string) => text("probe").concat(text(field), [0, 0]);
  const exported = (field: string, kind: number, index: number) =>
    text(field).concat([kind, index]);
  return new WebAssembly.Module(
    new Uint8Array(
      [0, 97, 115, 109, 1, 0, 0, 0].concat(
        section(1, [1, 96, 0, 0]),
        section(2, [2].concat(imported("startSection"), imported("entry"))),
        section(3, [2, 0, 0]),
        section(5, [1, 0, 1]),
        section(7, [2].concat(exported("memory", 2, 0), exported("_start", 0, 3))),
        section(8, [2]),
        section(10, [2, 4, 0, 16, 0, 11, 4, 0, 16, 1, 11]),
      ),
    ),
  );
}
function terminalStartupWorker(): string {
  const moduleURL = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  return `const {parentPort,workerData}=require('node:worker_threads');
(async()=>{
 const {bootstrap}=await import(${moduleURL("../browser/worker.ts")});
 const {attachTerminal}=await import(${moduleURL("../browser/terminal-session.ts")});
 const {createFilesystemConnection}=await import(${moduleURL("../fs/protocol.ts")});
 const cells=new Int32Array(workerData.effects), connection=createFilesystemConnection();
 let guard=()=>{throw Error('unarmed guard')};
 const terminal=attachTerminal({context:workerData.context,process:workerData.process,checkActive:()=>guard(),
 policy:{tryRead:()=>-6,inputReadiness:()=>({readable:false,nbytes:0}),transition:()=>({kind:'ok',value:undefined}),tryWrite:()=>0,outputReadiness:()=>({writable:true})}});
 try {
 await bootstrap({module:workerData.module,args:[],env:{},filesystem:connection.client,runtimeProcess:workerData.process}, {
 setup(context){guard=()=>{context.checkActive();if(Atomics.load(cells,4)!==0)throw Error('Shell revoked')};Atomics.store(cells,2,1);parentPort.postMessage({phase:'setup'});
 const ready=workerData.runControl?{kind:'ok'}:terminal.ready();if(ready.kind==='error')throw Error(ready.code);
 context.fs.preopen=()=>1;context.fs.retain=()=>{};context.fs.release=()=>{};},
 namespaces(){return {probe:{startSection(){Atomics.add(cells,0,1)},entry(){Atomics.add(cells,1,1)}}}},
 resolveTerminal:target=>terminal.resolve(target), run:()=>{if(workerData.runControl){const ready=terminal.ready();if(ready.kind==='error')throw Error(ready.code)}return 0},
 beforeFinish(){terminal.dispose();Atomics.store(cells,3,1)}
 },{crossOriginIsolated:true,postMessage:message=>parentPort.postMessage(message)});
 } finally {terminal.dispose();connection.client.port.close();connection.server.port.close();}
 parentPort.postMessage({phase:'cleaned'});parentPort.close();
 })().catch(error=>{parentPort.postMessage({error:String(error)});parentPort.close()});`;
}

async function startupControl<T>(
  operation: () => import("../browser/runtime-terminals.js").TerminalResult<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = operation();
    if (result.kind === "ok") return result.value;
    if (result.code !== "AGAIN") throw Error(result.code);
    await Bun.sleep(1);
  }
  throw Error("startup control gate-contention budget exhausted");
}

test("planned setup controls yield to gate contention without accepting terminal failures", async () => {
  const { createTerminalSession } = await import("../browser/runtime-terminals.js");
  const root = createWorkerProcessTransport({ capacity: 16 });
  const display = createTerminalSession({
    controller: root,
    geometry: { columns: 127, rows: 39 },
  });
  let release: ReturnType<typeof setTimeout> | undefined;
  try {
    const identity: unknown = display.identity;
    if (typeof identity !== "object" || identity === null || !("buffer" in identity))
      throw Error("missing terminal buffer");
    if (!(identity.buffer instanceof SharedArrayBuffer)) throw Error("invalid terminal buffer");
    const gate = new BigInt64Array(identity.buffer, 64, 1);
    Atomics.store(gate, 0, 999n);
    release = setTimeout(() => Atomics.store(gate, 0, 0n), 0);
    let contended = false;
    const snapshot = await startupControl(() => {
      const result = display.snapshot();
      if (result.kind === "error" && result.code === "AGAIN") contended = true;
      return result;
    });
    expect(contended).toBe(true);
    expect(Atomics.load(gate, 0)).toBe(0n);
    expect(snapshot.geometry).toEqual({ columns: 127, rows: 39, revision: 1 });
    display.close("disposed");
    await expect(startupControl(() => display.snapshot())).rejects.toThrow("CLOSED");
  } finally {
    clearTimeout(release);
    display.close("disposed");
  }
});

for (const action of [
  "bind",
  "cancel",
  "retire",
  "plan-reuse",
  "child-end",
  "guard-revoke",
  "root-end",
  "gate-held-root-end",
  "run-control",
] as const)
  test(`planned setup gate suppresses start-section and _start before ${action}`, async () => {
    const { Worker } = await import("node:worker_threads");
    const { createTerminalSession, claimTerminalAuthority } =
      await import("../browser/runtime-terminals.js");
    const root = createWorkerProcessTransport({ capacity: 16 });
    const display = createTerminalSession({
      controller: root,
      geometry: { columns: 127, rows: 39 },
    });
    const policy = {
      tryRead: () => -6,
      inputReadiness: () => ({ readable: false, nbytes: 0 }),
      transition: () => ({ kind: "ok" as const, value: undefined }),
      tryWrite: () => 0,
      outputReadiness: () => ({ writable: true }),
    };
    const must = <T>(result: import("../browser/runtime-terminals.js").TerminalResult<T>): T => {
      if (result.kind === "error") throw Error(result.code);
      return result.value;
    };
    const authority = must(
      claimTerminalAuthority({
        identity: display.identity,
        process: root,
        checkActive() {},
        policy,
      }),
    );
    const group = must(authority.createGroup({ initialMode: "cooked" }));
    const parent = must(authority.admitExisting({ group, pid: root.pid }));
    const lease = must(authority.acquire({ group, expected: null }));
    const planned = must(authority.planMember({ group, parent: parent.member }));
    const later = must(authority.planMember({ group, parent: parent.member }));
    const descriptors = new DescriptorTable();
    let child: import("../proc/worker-client.js").WorkerProcessTransport | undefined;
    const client = new WorkerProcessClient({
      transport: root,
      descriptors,
      codec: {
        export() {
          throw Error("no descriptors");
        },
        import() {
          throw Error("no descriptors");
        },
        discard() {},
      },
      postMessage(message) {
        if (message.operation === "spawn") child = message.transport;
      },
    });
    const pid = client.spawn(root.pid, {
      executable: "entry",
      argv: [],
      env: {},
      cwd: "/",
      job: 0,
      fds: [],
    });
    const effects = new SharedArrayBuffer(32),
      cells = new Int32Array(effects);
    let worker: import("node:worker_threads").Worker | undefined;
    const received: unknown[] = [];
    try {
      if (!child) throw Error("no actual child transport");
      worker = new Worker(terminalStartupWorker(), {
        eval: true,
        workerData: {
          process: child,
          context: planned.context,
          effects,
          module: terminalEntryModule(),
          runControl: action === "run-control",
        },
      });
      const exited = new Promise((resolve, reject) => {
        worker!.once("exit", resolve);
        worker!.once("error", reject);
      });
      worker.on("message", (message) => received.push(message));
      await new Promise<void>((resolve, reject) =>
        worker!.on("message", (data) => {
          if (data.phase === "setup") resolve();
          if (data.type === "error" || data.error) reject(new Error(JSON.stringify(data)));
        }),
      );
      expect(Atomics.load(cells, 2)).toBe(1);
      // Allow repeated admission rescans. This duration never decides process death.
      await Bun.sleep(30);
      expect(Atomics.load(cells, 0)).toBe(action === "run-control" ? 1 : 0);
      expect(Atomics.load(cells, 1)).toBe(action === "run-control" ? 1 : 0);
      if (action === "bind")
        await startupControl(() => authority.bindMember({ planned: planned.member, pid }));
      if (action === "guard-revoke") Atomics.store(cells, 4, 1);
      if (action === "child-end")
        claimOutcome(workerProcessState(child).signals.outcome, { kind: "exited", code: 1 });
      if (action === "retire") {
        await startupControl(() => authority.release({ lease, restore: null }));
        await startupControl(() => authority.retireGroup({ group, reason: "cancelled" }));
      }
      if (action === "plan-reuse") {
        await startupControl(() => authority.cancelPlan(planned.member));
        await startupControl(() => authority.planMember({ group, parent: parent.member }));
      }
      if (action === "cancel" || action === "run-control")
        await startupControl(() => authority.cancelPlan(planned.member));
      if (action === "gate-held-root-end") {
        const raw = display.identity as unknown as { buffer: SharedArrayBuffer };
        Atomics.store(new BigInt64Array(raw.buffer, 64, 1), 0, 999n);
      }
      if (action === "root-end" || action === "gate-held-root-end")
        claimOutcome(workerProcessState(root).signals.outcome, { kind: "exited", code: 0 });
      await exited;
      expect(Atomics.load(cells, 0)).toBe(action === "bind" || action === "run-control" ? 1 : 0);
      expect(Atomics.load(cells, 1)).toBe(action === "bind" || action === "run-control" ? 1 : 0);
      expect(Atomics.load(cells, 3)).toBe(1);
      expect(received).toContainEqual({ phase: "cleaned" });
      if (action === "bind" || action === "cancel" || action === "run-control")
        must(authority.cancelPlan(later.member));
    } finally {
      display.close("disposed");
      if (worker) await worker.terminate();
      descriptors.dispose();
    }
  });

test("async instantiate is cancelled promptly and late completion cannot bind released memory", async () => {
  const connection = createFilesystemConnection();
  const messages: RuntimeWorkerMessage[] = [];
  const entered = Promise.withResolvers<void>();
  const late = Promise.withResolvers<void>();
  let attempted = false,
    rejected = false,
    initialized = false;
  try {
    const pending = bootstrap(
      armingRequest(connection.client),
      {
        ...armingExecutor(() => {
          throw Error("must not enter");
        }),
        async instantiate(_imports, context) {
          entered.resolve();
          context.finish({ code: 23 });
          await late.promise;
          attempted = true;
          try {
            context.bindMemory(new WebAssembly.Memory({ initial: 1 }));
          } catch {
            rejected = true;
          }
          return new WebAssembly.Instance(module);
        },
        initialize() {
          initialized = true;
        },
        run() {
          throw Error("must not run");
        },
      },
      armingHost(messages),
    );
    await entered.promise;
    await pending;
    expect(attempted).toBe(false);
    late.resolve();
    await Bun.sleep(0);
    expect(attempted).toBe(true);
    expect(rejected).toBe(true);
    expect(initialized).toBe(false);
    expect(messages.filter((message) => message.type === "exit")).toMatchObject([{ code: 23 }]);
  } finally {
    late.resolve();
    connection.client.port.close();
    connection.server.port.close();
  }
});

test("instantiate binds ProcessABI before initialization and rejects replacement before WASI mutation", async () => {
  const connection = createFilesystemConnection();
  const messages: RuntimeWorkerMessage[] = [];
  const memory = new WebAssembly.Memory({ initial: 1 });
  let initialized = false;
  try {
    await bootstrap(
      armingRequest(connection.client, { runtimeProcess: createWorkerProcessTransport() }),
      {
        ...armingExecutor(() => {}),
        instantiate(_imports, context) {
          context.bindMemory(memory);
          expect(() => context.bindMemory(new WebAssembly.Memory({ initial: 1 }))).toThrow(
            "cannot replace",
          );
          // A proc ABI call accesses the early memory rather than an uninitialized instance closure.
          new DataView(memory.buffer).setUint32(0, 0x12345678, true);
          return new WebAssembly.Instance(module);
        },
        initialize() {
          initialized = true;
        },
        run() {
          throw Error("mismatched entry memory must not run");
        },
      },
      armingHost(messages),
    );
    expect(initialized).toBe(false);
    expect(messages.some((message) => message.type === "error")).toBe(true);
    expect(new DataView(memory.buffer).getUint32(0, true)).toBe(0x12345678);
  } finally {
    connection.client.port.close();
    connection.server.port.close();
  }
});

test("guest constructor calls the real ProcessABI with bound memory before instance publication", async () => {
  const connection = createFilesystemConnection();
  const messages: RuntimeWorkerMessage[] = [];
  const guest = guestModule({
    namespace: "runtime_proc",
    name: "poll",
    params: [127, 127, 127, 127],
    body: [65, 0, 65, 1, 65, 0, 65, 16, 16, 0, 26],
  });
  let constructorResult: unknown;
  try {
    await bootstrap(
      {
        module: guest,
        args: [],
        env: {},
        filesystem: connection.client,
        runtimeProcess: createWorkerProcessTransport(),
      },
      {
        ...armingExecutor(() => {}),
        instantiate(imports, context) {
          const original = imports.runtime_proc!.poll;
          if (typeof original !== "function") throw Error("missing real ProcessABI");
          imports.runtime_proc!.poll = (...args: number[]) => {
            constructorResult = original(...args);
            return constructorResult;
          };
          const instance = new WebAssembly.Instance(guest, imports);
          const memory = instance.exports.memory;
          if (!(memory instanceof WebAssembly.Memory)) throw Error("missing memory");
          context.bindMemory(memory);
          new DataView(memory.buffer).setUint32(0, 7, true);
          // This guest function stands in for a constructor running before publication.
          const ctor = instance.exports._start;
          if (typeof ctor !== "function") throw Error("missing constructor fixture");
          ctor();
          expect(constructorResult).toBe(-28);
          return instance;
        },
        run({ process }) {
          expect(process).toBeDefined();
          return 0;
        },
      },
      armingHost(messages),
    );
    expect(messages.filter((message) => message.type === "exit")).toMatchObject([{ code: 0 }]);
    expect(messages.some((message) => message.type === "error")).toBe(false);
  } finally {
    connection.client.port.close();
    connection.server.port.close();
  }
});
