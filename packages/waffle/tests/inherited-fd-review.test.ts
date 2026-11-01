import { standaloneRuntimeProcess } from "./fixtures/standalone-runtime-process.js";
import { expect, test } from "bun:test";
import {
  bootstrap,
  preview1Executor,
  type WorkerExecutor,
  type RuntimeWorkerMessage,
} from "../browser/worker.js";
import { DescriptorTable, type Stream } from "../core/descriptors.js";
import { Wasi, type WasiOptions } from "../core/wasi.js";
import { createFilesystemConnection, FilesystemService, MemoryBackend } from "../fs/index.js";
import { MemFS } from "../fs/memory.js";
import { createFilesystemIdentity } from "../fs/protocol.js";
import { PipeController } from "../proc/pipes.js";
import {
  createWorkerProcessTransport,
  workerProcessState,
  type WorkerProcessTransport,
} from "../proc/worker-client.js";
const u = (n: number): number[] =>
  n < 128 ? [n] : [(n % 128) + 128].concat(u(Math.floor(n / 128)));
const sec = (id: number, bytes: number[]) => [id].concat(u(bytes.length), bytes);
const name = (s: string) => u(s.length).concat(Array.from(new TextEncoder().encode(s)));
const ty = (n: number, result = true) =>
  [0x60, n].concat(Array(n).fill(0x7f), result ? [1, 0x7f] : [0]);
const raw = new Uint8Array(
  [0, 97, 115, 109, 1, 0, 0, 0].concat(
    sec(1, [4].concat(ty(1), ty(4), ty(2), ty(0, false))),
    sec(
      2,
      [4].concat(
        name("runtime_proc"),
        name("inherited_fd"),
        [0, 0],
        name("wasi_snapshot_preview1"),
        name("fd_write"),
        [0, 1],
        name("wasi_snapshot_preview1"),
        name("fd_fdstat_get"),
        [0, 2],
        name("runtime_proc"),
        name("fd_kind"),
        [0, 0],
      ),
    ),
    sec(3, [1, 3]),
    sec(5, [1, 0, 1]),
    sec(
      7,
      [6].concat(
        name("memory"),
        [2, 0],
        name("_start"),
        [0, 4],
        name("inherited"),
        [0, 0],
        name("write"),
        [0, 1],
        name("stat"),
        [0, 2],
        name("kind"),
        [0, 3],
      ),
    ),
    sec(10, [1, 2, 0, 11]),
  ),
);
const module = new WebAssembly.Module(raw);
function guest(instance: WebAssembly.Instance) {
  const memory = instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw Error("missing guest memory");
  function call(name: string, ...args: number[]): number {
    const method = instance.exports[name];
    if (typeof method !== "function") throw Error(`missing guest export ${name}`);
    return method(...args);
  }
  const view = new DataView(memory.buffer);
  view.setUint32(16, 32, true);
  view.setUint32(20, 1, true);
  new Uint8Array(memory.buffer)[32] = 65;
  return { memory, call, view };
}

async function launch(transport: WorkerProcessTransport, hooks: Partial<WorkerExecutor> = {}) {
  const service = new FilesystemService(new MemoryBackend());
  const conn = createFilesystemConnection();
  service.connect(conn.server);
  transport.data = { filesystem: createFilesystemIdentity() };
  const messages: RuntimeWorkerMessage[] = [];
  try {
    await bootstrap(
      {
        controlGrant: { kind: "unbounded" },
        module,
        args: [],
        env: {},
        filesystem: conn.client,
        runtimeProcess: standaloneRuntimeProcess(transport),
      },
      {
        ...preview1Executor,
        ...hooks,
        setup(context) {
          context.fs.preopen = () => 1;
          context.fs.retain = () => {};
          context.fs.release = () => {};
          hooks.setup?.(context);
        },
      },
      { crossOriginIsolated: true, postMessage: (message) => messages.push(message) },
    );
    return messages;
  } finally {
    conn.client.port.close();
    conn.server.port.close();
    service.dispose();
  }
}

async function spawn(fds: { child: number; parent: number }[]) {
  const parent = createWorkerProcessTransport();
  const messages = await launch(parent, {
    instantiated({ process, instance }) {
      const e = guest(instance);
      expect([0, 1, 2, 3].map((i) => e.call("inherited", i))).toEqual([0, 1, 2, -44]);
      const request = new TextEncoder().encode(
        JSON.stringify({ executable: "/probe", argv: [], env: {}, cwd: "/", job: -1, fds }),
      );
      new Uint8Array(e.memory.buffer, 2048, request.length).set(request);
      if (!process) throw Error("missing ProcessABI");
      expect(process.imports.spawn!(2048, request.length)).toBeGreaterThan(0);
    },
  });
  const message = messages.find((m) => m.type === "runtime-proc" && m.operation === "spawn");
  if (message?.type !== "runtime-proc" || message.operation !== "spawn")
    throw Error("no actual ProcessABI child spawn");
  expect(workerProcessState(message.transport).parentPid).toBe(parent.pid);
  return message.transport;
}

for (let closedMask = 0; closedMask < 8; closedMask++) {
  test(`nullable stdio preserves exact slots and callbacks for mask ${closedMask}`, () => {
    const stdio: WasiOptions["stdio"] = {};
    for (const fd of [0, 1, 2] as const) {
      if (closedMask & (1 << fd)) stdio[fd] = null;
    }
    const output: string[] = [];
    const wasi = new Wasi({
      args: [],
      env: {},
      fs: new MemFS(),
      preopens: { "/": "/" },
      stdio,
      namespaces: { runtime_proc: { inherited_fd: () => -44, fd_kind: () => 0 } },
      stdout: () => output.push("stdout"),
      stderr: () => output.push("stderr"),
      sleep() {},
    });
    const instance = new WebAssembly.Instance(module, {
      runtime_proc: {
        inherited_fd: () => -44,
        fd_kind: (fd: number) => wasi.descriptors.kind(fd),
      },
      wasi_snapshot_preview1: wasi.imports(module).wasi_snapshot_preview1!,
    });
    wasi.bindMemory(guest(instance).memory);
    const e = guest(instance);
    try {
      for (const fd of [0, 1, 2]) {
        const closed = Boolean(closedMask & (1 << fd));
        expect(e.call("stat", fd, 64)).toBe(closed ? 8 : 0);
        expect(e.call("write", fd, 16, 1, 24)).toBe(closed ? 8 : 0);
      }
      expect(wasi.descriptors.get(3)?.preopen).toBe("/");
      expect(output).toEqual(
        [0, 1, 2]
          .filter((fd) => !(closedMask & (1 << fd)))
          .map((fd) => (fd === 2 ? "stderr" : "stdout")),
      );
    } finally {
      wasi.descriptors.dispose();
    }
  });

  test(`real child bindings preserve stdio and sparse preopens for mask ${closedMask}`, async () => {
    const bound = [0, 1, 2].filter((fd) => !(closedMask & (1 << fd)));
    const fds = bound
      .map((fd) => ({ child: fd, parent: fd }))
      .concat([
        { child: 3, parent: 2 },
        { child: 7, parent: 2 },
        { child: 2147483647, parent: 2 },
      ]);
    const transport = await spawn(fds);
    let entered = false;
    let inherited: (() => number) | undefined;
    const messages = await launch(transport, {
      instantiated({ instance, wasi }) {
        entered = true;
        const e = guest(instance);
        inherited = () => e.call("inherited", 0);
        const expected = bound.concat([3, 7, 2147483647, -44]);
        expect(expected.map((_, i) => e.call("inherited", i))).toEqual(expected);
        expect(e.call("inherited", -1)).toBe(-44);
        for (const fd of [0, 1, 2]) {
          const closed = Boolean(closedMask & (1 << fd));
          expect(e.call("stat", fd, 64)).toBe(closed ? 8 : 0);
          expect(e.call("write", fd, 16, 1, 24)).toBe(closed ? 8 : 0);
        }
        expect(wasi.descriptors.get(4)?.preopen).toBe("/");
        wasi.descriptors.close(3);
        wasi.descriptors.dup(7);
        expect(expected.map((_, i) => e.call("inherited", i))).toEqual(expected);
      },
    });
    expect(entered).toBe(true);
    expect(messages.filter((m) => m.type === "exit")).toMatchObject([{ code: 0 }]);
    expect(() => inherited?.()).toThrow();
    expect(messages.filter((m) => m.type === "stdout")).toHaveLength(
      bound.filter((fd) => fd !== 2).length,
    );
  });
}

test("empty child bindings leave every stdio fd closed", async () => {
  let entered = false;
  await launch(await spawn([]), {
    instantiated({ instance }) {
      entered = true;
      const e = guest(instance);
      expect(e.call("inherited", 0)).toBe(-44);
      for (const fd of [0, 1, 2]) expect(e.call("stat", fd, 64)).toBe(8);
    },
  });
  expect(entered).toBe(true);
});

for (const phase of ["normal", "setup-failure", "binding-failure", "fatal", "dispose"] as const)
  test(`discarded executor pipe closes once and reaches EOF after ${phase}`, async () => {
    const transport = await spawn([{ child: 2, parent: 2 }]);
    const pipe = new PipeController({ capacity: 8, relay: "manual" });
    const reader = pipe.retain(999, "read");
    const writer = pipe.retain(transport.pid, "write");
    const close = writer.close.bind(writer);
    let closed = 0;
    writer.close = () => {
      closed++;
      close();
    };
    try {
      const messages = await launch(transport, {
        stdio: { 0: writer, 1: writer, 2: writer },
        setup() {
          if (phase === "setup-failure") throw Error("setup failed");
        },
        beforeBindings(context) {
          if (phase === "binding-failure") throw Error("binding failed");
          if (phase === "dispose") context.finish({ code: 0 });
        },
        run(context) {
          if (phase === "fatal") context.defaultSignal(2);
          return 0;
        },
      });
      expect(messages.some((m) => m.type === "cleanup-error")).toBe(false);
      if (phase === "fatal")
        expect(messages.filter((m) => m.type === "exit")).toMatchObject([{ code: 130, signal: 2 }]);
      expect(closed).toBe(1);
      expect(reader.readiness().hangup).toBe(true);
      expect(reader.tryRead([new Uint8Array(1)])).toBe(0);
    } finally {
      close();
      reader.close();
      pipe.dispose();
    }
  });

test("a resolved inherited stream is not closed again as discarded stdio", async () => {
  const transport = await spawn([{ child: 7, parent: 2 }]);
  let closed = 0;
  const stream: Stream = {
    kind: "pipe",
    read: () => 0,
    write: () => 0,
    readiness: () => ({ readable: true, writable: true, hangup: false }),
    close() {
      closed++;
    },
  };
  const messages = await launch(transport, {
    stdio: { 1: stream, 2: stream },
    resolveTerminal: () => stream,
    instantiated({ wasi }) {
      expect(closed).toBe(0);
      wasi.descriptors.close(7);
      expect(closed).toBe(1);
    },
  });
  expect(closed).toBe(1);
  expect(messages.filter((m) => m.type === "exit")).toMatchObject([{ code: 0 }]);
});

test("executor hooks can transfer omitted stdio into another descriptor", async () => {
  const transport = await spawn([]);
  let closed = 0;
  const stream: Stream = {
    kind: "pipe",
    read: () => 0,
    write: () => 0,
    readiness: () => ({ readable: true, writable: true, hangup: false }),
    close() {
      closed++;
    },
  };
  const messages = await launch(transport, {
    stdio: { 1: stream },
    beforeBindings({ wasi }) {
      wasi.descriptors.openAt(7, stream, 0n, 0n);
    },
    run({ wasi }) {
      wasi.descriptors.close(7);
      return 0;
    },
  });
  expect(closed).toBe(1);
  expect(messages.filter((m) => m.type === "exit")).toMatchObject([{ code: 0 }]);
});

test("discarded close failures remain cleanup errors and suppress safe acknowledgement", async () => {
  const transport = await spawn([]);
  let closed = 0;
  const stream: Stream = {
    kind: "pipe",
    read: () => 0,
    write: () => 0,
    readiness: () => ({ readable: true, writable: true, hangup: false }),
    close() {
      closed++;
      throw Error("discarded close failed");
    },
  };
  const messages = await launch(transport, { stdio: { 1: stream, 2: stream } });
  expect(closed).toBe(1);
  expect(messages.filter((m) => m.type === "cleanup-error")).toMatchObject([
    { cleanupErrors: [expect.stringContaining("discarded close failed")] },
  ]);
  expect(messages.some((m) => m.type === "exit")).toBe(false);
});

test("inherited directories keep their rights and reference count", () => {
  const table = new DescriptorTable();
  try {
    table.openAt(4, { kind: "directory", handle: 1 }, 2n, 0n, undefined, "/");
    table.inherit(7, table.get(4)!);
    const before = table.get(7)!.description.references;
    expect(table.inheritable()).toEqual([7]);
    expect(table.get(7)!.rightsBase).toBe(2n);
    expect(table.get(7)!.description.references).toBe(before);
  } finally {
    table.dispose();
  }
});
