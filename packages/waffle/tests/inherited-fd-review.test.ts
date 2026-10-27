import { expect, test } from "bun:test";
import { bootstrap, preview1Executor } from "../browser/worker.js";
import { DescriptorTable, type Stream } from "../core/descriptors.js";
import { Wasi } from "../core/wasi.js";
import { createFilesystemConnection, FilesystemService, MemoryBackend } from "../fs/index.js";
import { MemFS } from "../fs/memory.js";
import { createFilesystemIdentity } from "../fs/protocol.js";
import { PipeController } from "../proc/pipes.js";
import { createWorkerProcessTransport, workerProcessState } from "../proc/worker-client.js";
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
function opts(stdio: object) {
  return {
    args: [],
    env: {},
    fs: new MemFS(),
    preopens: { "/": "/" },
    stdout() {},
    stderr() {},
    sleep() {},
    stdio,
  };
}

test("new nullable stdio keeps explicitly closed fd1 absent", () => {
  let bytesToStderr = 0;
  const wasi = new Wasi({
    ...opts({ 1: null }),
    stderr(data: Uint8Array) {
      bytesToStderr += data.length;
    },
  });
  try {
    const resource = wasi.descriptors.get(1)?.resource;
    if (resource?.kind === "terminal") resource.write([new Uint8Array([65])]);
    expect(wasi.descriptors.get(1)).toBeUndefined();
    expect(wasi.descriptors.get(2)?.resource.kind).toBe("terminal");
    expect(bytesToStderr).toBe(0);
  } finally {
    wasi.descriptors.dispose();
  }
});

for (let closedMask = 0; closedMask < 8; closedMask++)
  test(`nullable stdio keeps every named slot for mask ${closedMask}`, () => {
    const stdio: Partial<Record<0 | 1 | 2, null>> = {};
    for (const fd of [0, 1, 2] as const) {
      if (closedMask & (1 << fd)) stdio[fd] = null;
    }
    const wasi = new Wasi({ ...opts(stdio) });
    try {
      for (const fd of [0, 1, 2] as const)
        expect(wasi.descriptors.get(fd) !== undefined).toBe(!(closedMask & (1 << fd)));
    } finally {
      wasi.descriptors.dispose();
    }
  });

async function launch(transport: any, hooks: any = {}) {
  const service = new FilesystemService(new MemoryBackend());
  const conn = createFilesystemConnection();
  service.connect(conn.server);
  transport.data = { ...transport.data, filesystem: createFilesystemIdentity() };
  const messages: any[] = [];
  try {
    await bootstrap(
      { module, args: [], env: {}, filesystem: conn.client, runtimeProcess: transport },
      {
        ...preview1Executor,
        ...hooks,
        setup({ fs }: any) {
          fs.preopen = () => 1;
          fs.retain = () => {};
          fs.release = () => {};
        },
      },
      {
        crossOriginIsolated: true,
        postMessage(m: any) {
          messages.push(m);
        },
      },
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
    instantiated({ process, instance }: any) {
      expect([0, 1, 2, 3].map((i) => instance.exports.inherited(i))).toEqual([0, 1, 2, -44]);
      const request = new TextEncoder().encode(
        JSON.stringify({ executable: "/probe", argv: [], env: {}, cwd: "/", job: -1, fds }),
      );
      new Uint8Array(instance.exports.memory.buffer, 2048, request.length).set(request);
      expect(process.imports.spawn(2048, request.length)).toBeGreaterThan(0);
    },
  });
  const message = messages.find((m) => m.type === "runtime-proc" && m.operation === "spawn");
  if (!message) throw new Error("no actual ProcessABI child spawn");
  expect(workerProcessState(message.transport).parentPid).toBe(parent.pid);
  return message.transport;
}

test("real ProcessABI child with bindings 0,2 and sparse high fds has closed stdout and stable snapshot", async () => {
  const transport = await spawn([
    { child: 0, parent: 0 },
    { child: 2, parent: 2 },
    { child: 7, parent: 2 },
    { child: 3, parent: 2 },
    { child: 2147483647, parent: 2 },
  ]);
  let called = false;
  let inherited: any;
  const messages = await launch(transport, {
    instantiated({ instance, wasi }: any) {
      called = true;
      const e = instance.exports;
      inherited = e.inherited;
      expect([0, 1, 2, 3, 4, 5, -1].map((i) => e.inherited(i))).toEqual([
        0, 2, 3, 7, 2147483647, -44, -44,
      ]);
      expect(e.kind(1)).toBe(-8);
      expect(e.stat(1, 64)).toBe(8);
      const view = new DataView(e.memory.buffer);
      view.setUint32(16, 32, true);
      view.setUint32(20, 1, true);
      new Uint8Array(e.memory.buffer)[32] = 65;
      expect(e.write(1, 16, 1, 24)).toBe(8);
      expect(wasi.descriptors.get(4)?.preopen).toBe("/");
      wasi.descriptors.close(3);
      wasi.descriptors.dup(2);
      expect([0, 1, 2, 3, 4, 5].map((i) => e.inherited(i))).toEqual([0, 2, 3, 7, 2147483647, -44]);
    },
  });
  expect(called).toBe(true);
  expect(messages.filter((m) => m.type === "exit")).toMatchObject([{ code: 0 }]);
  expect(messages.some((m) => m.type === "stdout")).toBe(false);
  expect(() => inherited(0)).toThrow();
});

test("real ProcessABI child with empty bindings leaves all stdio closed", async () => {
  const transport = await spawn([]);
  let called = false;
  await launch(transport, {
    instantiated({ instance }: any) {
      called = true;
      const e = instance.exports;
      expect(e.inherited(0)).toBe(-44);
      for (const fd of [0, 1, 2]) expect(e.stat(fd, 64)).toBe(8);
    },
  });
  expect(called).toBe(true);
});

for (let closedMask = 0; closedMask < 8; closedMask++)
  test(`child releases every supplied stream for partial stdio mask ${closedMask}`, async () => {
    const transport = await spawn([]);
    let closed = 0;
    const stdio: Partial<Record<0 | 1 | 2, Stream>> = {};
    for (const fd of [0, 1, 2] as const) {
      if (closedMask & (1 << fd)) continue;
      stdio[fd] = {
        kind: "pipe",
        read: () => 0,
        write: () => 0,
        readiness: () => ({ readable: true, writable: true, hangup: false }),
        close() {
          closed++;
        },
      };
    }
    const messages = await launch(transport, {
      stdio,
      instantiated({ instance }: any) {
        for (const fd of [0, 1, 2]) expect(instance.exports.stat(fd, 64)).toBe(8);
      },
    });
    expect(messages.filter((message) => message.type === "exit")).toMatchObject([{ code: 0 }]);
    expect(closed).toBe(3 - [0, 1, 2].filter((fd) => closedMask & (1 << fd)).length);
  });

test("child executor-owned pipe writer is released so reader reaches EOF", async () => {
  const transport = await spawn([]);
  const controller = new PipeController({ capacity: 8, relay: "manual" });
  const reader = controller.retain(999, "read");
  const writer = controller.retain(transport.pid, "write");
  try {
    const messages = await launch(transport, { stdio: { 1: writer } });
    expect(messages.filter((m) => m.type === "exit")).toMatchObject([{ code: 0 }]);
    expect(reader.readiness().hangup).toBe(true);
    expect(reader.tryRead([new Uint8Array(1)])).toBe(0);
  } finally {
    writer.close();
    reader.close();
    controller.dispose();
  }
});

test("inherited directory stays listed without retaining or widening its rights", () => {
  const table = new DescriptorTable();
  const rights = 2n;
  try {
    table.openAt(4, { kind: "directory", handle: 1 }, rights, 0n, undefined, "/");
    table.inherit(7, table.get(4)!);
    const before = table.get(7)!.description.references;
    expect(table.inheritable()).toEqual([7]);
    expect(table.get(7)!.rightsBase).toBe(rights);
    expect(table.get(7)!.description.references).toBe(before);
  } finally {
    table.dispose();
  }
});
