import { testReservations } from "./fixtures/shared-memory-platform.js";
import { afterEach, expect, test } from "bun:test";
import { DescriptorTable } from "../core/descriptors.js";
import { MemFS } from "../fs/memory.js";
import { ProcessABI } from "../proc/abi.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { ProcessSupervisor } from "../proc/supervisor.js";
import { checkedProcessCwd, type SpawnRequest } from "../proc/types.js";
import { WorkerProcessBroker } from "../proc/worker-broker.js";
import { BrowserProcessBroker } from "../browser/process-broker.js";
import { createFilesystemIdentity, revokeFilesystem } from "../fs/protocol.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  workerProcessState,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const encoder = new TextEncoder();
const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const codec = {
  export(): never {
    throw new Error("unexpected descriptor export");
  },
  import(): never {
    throw new Error("unexpected descriptor import");
  },
  discard() {},
};
function fixture(cwd = "/tmp/spec") {
  const registry = new ExecutableRegistry();
  registry.register("fixture", { module, adapter: "fixture" });
  const supervisor = new ProcessSupervisor({ registry, launch: () => ({ terminate() {} }) });
  cleanups.push(() => supervisor.dispose());
  const options = { cwd };
  const pid = supervisor.createRoot(options);
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
  function abi(caller = pid, getMemory: WebAssembly.Memory | (() => WebAssembly.Memory) = memory) {
    return new ProcessABI({
      memory: getMemory,
      fs: new MemFS(),
      descriptors: supervisor.get(caller)!.descriptors,
      service: supervisor,
      pid: caller,
      signals: supervisor.get(caller)!,
    });
  }
  return { supervisor, options, pid, memory, abi };
}
function request(cwd: string): SpawnRequest {
  return { executable: "fixture", argv: [], env: { PWD: "/different" }, cwd, job: 0, fds: [] };
}
test("cwd reports exact UTF-8 root/child snapshots without reading PWD", () => {
  const f = fixture("/tmp/日本/🧇//./spec");
  const expected = encoder.encode(f.options.cwd);
  f.options.cwd = "/changed";
  const root = f.abi();
  const bytes = new Uint8Array(f.memory.buffer).fill(0xa5);
  expect(root.imports.cwd!(0, 0)).toBe(expected.length);
  expect(root.imports.cwd!(16, expected.length - 1)).toBe(expected.length);
  expect(bytes.slice(0, 64)).toEqual(new Uint8Array(64).fill(0xa5));
  expect(root.imports.cwd!(16, expected.length)).toBe(expected.length);
  expect(bytes.slice(16, 16 + expected.length)).toEqual(expected);
  expect(bytes[16 + expected.length]).toBe(0xa5);
  const spec = request("/child/cwd");
  const child = f.supervisor.reserveSpawn(f.pid, spec);
  spec.cwd = "/mutated";
  expect(f.abi(child).imports.cwd!(128, 32)).toBe(10);
  expect(new TextDecoder().decode(bytes.slice(128, 138))).toBe("/child/cwd");
  expect(f.supervisor.cwd(f.pid)).toBe("/tmp/日本/🧇//./spec");
});
test("cwd validates the whole output span on query, short-buffer and write paths", () => {
  const f = fixture();
  const query = f.abi().imports.cwd!;
  expect(query(65536, 0)).toBe(9);
  expect(query(65537, 0)).toBe(-21);
  expect(query(65536, 1)).toBe(-21);
  expect(query(65530, 20)).toBe(-21);
  expect(query(-1, 0)).toBe(-21);
  expect(query(0, -1)).toBe(-21);
  expect(query(0.5, 0)).toBe(-28);
  expect(query(0, NaN)).toBe(-28);
  expect(query(0x100000000, 0)).toBe(-28);
});
test("cwd acquires current memory after growth and rechecks caller liveness before copying", () => {
  const f = fixture();
  const query = f.abi(f.pid, () => {
    if (f.memory.buffer.byteLength === 65536) f.memory.grow(1);
    return f.memory;
  }).imports.cwd!;
  expect(query(65536, 9)).toBe(9);
  expect(new TextDecoder().decode(new Uint8Array(f.memory.buffer, 65536, 9))).toBe("/tmp/spec");
  const dying = f.abi(f.pid, () => {
    f.supervisor.dispose();
    return f.memory;
  }).imports.cwd!;
  expect(dying(0, 32)).toBe(-71);
  expect(new Uint8Array(f.memory.buffer, 0, 32)).toEqual(new Uint8Array(32));
  expect(query(0, 0)).toBe(-71);
});
for (const cwd of ["", "relative", "/bad\0path", "/bad\ud800", "/bad\udc00", null])
  test(`invalid process cwd is rejected before root/child admission: ${JSON.stringify(cwd)}`, () => {
    expect(() => checkedProcessCwd(cwd)).toThrow();
    if (typeof cwd !== "string") return;
    const f = fixture();
    expect(() => f.supervisor.createRoot({ cwd })).toThrow();
    expect(() => f.supervisor.reserveSpawn(f.pid, request(cwd))).toThrow();
    expect(() => createWorkerProcessTransport({ cwd })).toThrow();
  });
test("root cwd defaults explicitly to /", () => {
  const f = fixture();
  expect(f.supervisor.cwd(f.supervisor.createRoot())).toBe("/");
  expect(createWorkerProcessTransport().cwd).toBe("/");
});
test("shared worker root and spawned child retain their own cwd through broker admission", async () => {
  const f = fixture();
  const transport = createWorkerProcessTransport({ pid: 100, job: 100, cwd: "/root/🧇" });
  const state = workerProcessState(transport);
  f.supervisor.createRoot({ pid: state.pid, job: state.job, cwd: transport.cwd, ...state.signals });
  const descriptors = new DescriptorTable();
  cleanups.push(() => descriptors.dispose());
  const messages: WorkerProcessMessage[] = [];
  const client = new WorkerProcessClient({
    transport,
    descriptors,
    codec,
    postMessage: (m) => messages.push(m),
  });
  const broker = new WorkerProcessBroker({ supervisor: async () => f.supervisor, codec });
  broker.adoptRoot(transport);
  cleanups.push(() => broker.dispose());
  expect(client.cwd(client.pid)).toBe("/root/🧇");
  expect(() => client.cwd(f.pid)).toThrow(/querying process/);
  const spec = request("/worker/child");
  const pid = client.spawn(client.pid, spec);
  spec.cwd = "/mutated";
  const notice = messages.shift()!;
  if (notice.operation !== "spawn") throw new Error("expected spawn notice");
  expect(notice.transport.cwd).toBe("/worker/child");
  await broker.handle(notice, client.pid);
  await f.supervisor.start(pid);
  const child = new WorkerProcessClient({
    transport: notice.transport,
    descriptors,
    codec,
    postMessage() {},
  });
  expect(child.cwd(pid)).toBe("/worker/child");
  expect(f.supervisor.cwd(pid)).toBe("/worker/child");
  const childABI = new ProcessABI({
    memory: f.memory,
    fs: new MemFS(),
    descriptors,
    service: child,
    pid,
    signals: child.signals,
  });
  expect(childABI.imports.cwd!(0, 32)).toBe(13);
  expect(new TextDecoder().decode(new Uint8Array(f.memory.buffer, 0, 13))).toBe("/worker/child");
  const foreignABI = new ProcessABI({
    memory: f.memory,
    fs: new MemFS(),
    descriptors,
    service: child,
    pid: client.pid,
    signals: child.signals,
  });
  expect(foreignABI.imports.cwd!(0, 0)).toBe(-71);
  f.supervisor.exit(pid, 0);
  await f.supervisor.waitForExit(client.pid, pid);
  f.supervisor.reap(client.pid, pid);
  const next = client.spawn(client.pid, request("/replacement"));
  const replacementNotice = messages.shift()!;
  if (replacementNotice.operation !== "spawn") throw new Error("expected spawn notice");
  await broker.handle(replacementNotice, client.pid);
  await f.supervisor.start(next);
  expect(replacementNotice.transport.slot).toBe(notice.transport.slot);
  const replacement = new WorkerProcessClient({
    transport: replacementNotice.transport,
    descriptors,
    codec,
    postMessage() {},
  });
  expect(replacement.cwd(next)).toBe("/replacement");
  expect(childABI.imports.cwd!(0, 0)).toBe(-71);
  client.exit(0);
  expect(() => client.cwd(client.pid)).toThrow(/exited/);
  expect(replacement.cwd(next)).toBe("/replacement");
});

test("browser root adoption preserves explicit cwd across lazy activation", async () => {
  const f = fixture();
  const identities = f.supervisor.table.identities;
  const broker = new BrowserProcessBroker({
    reservations: testReservations(),
    identities,
    table: f.supervisor.table,
    registry: new ExecutableRegistry(),
    filesystem: {
      connect(): never {
        throw new Error("cwd must not connect to a filesystem");
      },
      revoke: revokeFilesystem,
      reap: revokeFilesystem,
      async quiesce() {},
    },
    launch: () => ({ terminate() {} }),
  });
  cleanups.push(() => broker.dispose());
  const transport = createWorkerProcessTransport({
    identity: identities.buffer,
    pid: identities.pid(),
    job: identities.job(),
    cwd: "/shell/root",
  });
  transport.data = { filesystem: createFilesystemIdentity() };
  await broker.adoptRuntimeRoot(transport, { memory: [] });
  const supervisor = await broker.ready();
  expect(supervisor.cwd(transport.pid)).toBe("/shell/root");
  const nativeRoot = { cwd: "/external/root" };
  const pid = broker.reserveRoot(nativeRoot);
  nativeRoot.cwd = "/changed";
  expect(supervisor.cwd(pid)).toBe("/external/root");
});
