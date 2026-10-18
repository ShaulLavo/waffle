import { expect, spyOn, test } from "bun:test";
import { BrowserProcessBroker } from "../browser/process-broker";
import { DescriptorTable } from "../core/descriptors";
import { MemoryBackend } from "../fs/backend";
import { createFilesystemIdentity } from "../fs/protocol";
import { ProcessABI } from "../proc/abi";
import { ProcessIdentityAllocator } from "../proc/identity";
import { ExecutableRegistry } from "../proc/registry";
import { ProcessSupervisor } from "../proc/supervisor";
import { ProcessTable } from "../proc/table";
import { MAX_ACCESS_REQUESTS, WorkerProcessClient, createWorkerProcessTransport, workerProcessSlots, workerProcessState, type WorkerProcessMessage } from "../proc/worker-client";

const encoder = new TextEncoder();
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function fixture() {
  const backend = new MemoryBackend(), fs = backend.fs;
  fs.writeFile("/bin/guest", new Uint8Array());
  fs.writeFile("/bin/plain", new Uint8Array());
  fs.mkdirp("/bin/sub");
  let deferred: ReturnType<typeof gate> | undefined;
  let lookupStarted: ReturnType<typeof gate> | undefined;
  let loads = 0, activations = 0, launches = 0, transfers = 0, waits = 0;
  const lookups: string[] = [];
  const registry = new ExecutableRegistry(async path => {
    lookups.push(path);
    if (deferred) { lookupStarted?.release(); await deferred.promise; }
    return backend.execute("resolvePath", [path], new Uint8Array()) as { path: string; kind: "file" | "dir" } | undefined;
  });
  const register = () => registry.register("/bin/guest", { adapter: "test", module: () => { loads++; throw new Error("query must not load modules"); } });
  register();
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities);
  const broker = new BrowserProcessBroker({ identities, table, registry,
    activate: async () => { activations++; return import("../proc"); },
    filesystem: { connect() { throw new Error("query must not allocate connections"); }, revoke() {}, reap() {}, async quiesce() {} },
    launch() { launches++; throw new Error("query must not launch processes"); },
  });
  const transport = createWorkerProcessTransport({ pid: identities.pid(), job: identities.job(), identity: identities.buffer });
  transport.data = { filesystem: createFilesystemIdentity() };
  await broker.adoptRuntimeRoot(transport);
  const descriptors = new DescriptorTable(), messages: WorkerProcessMessage[] = [];
  const codec = { export() { transfers++; throw new Error("query must not export descriptors"); }, import() { transfers++; throw new Error("query must not import descriptors"); }, discard() { transfers++; } };
  const client = new WorkerProcessClient({ transport, descriptors, codec,
    postMessage(message) { messages.push(structuredClone(message)); },
  });
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 2 });
  const abi = new ProcessABI({ memory, fs, descriptors, pid: client.pid, service: client, signals: client.signals, wake: client.wake,
    wait() { waits++; throw new Error("nonblocking executable query slept"); },
  });
  const put = (value: string, offset: number) => { const bytes = encoder.encode(value); new Uint8Array(memory.buffer).set(bytes, offset); return bytes.length; };
  const start = (path = "./guest", cwd = "/bin", mode = 1) => abi.imports.access_start!(1024, put(path, 1024), 2048, put(cwd, 2048), mode);
  const poll = (id: number) => {
    const view = new DataView(memory.buffer);
    view.setUint32(256, 5, true); view.setUint32(260, id, true); view.setBigUint64(264, 99n, true);
    return abi.imports.poll!(256, 1, 0, 512);
  };
  const deliver = () => messages.splice(0).map(message => broker.runtimeMessage(message, client.pid));
  return { fs, registry, register, broker, transport, table, client, memory, abi, put, start, poll, deliver, messages, lookups,
    defer() { deferred = gate(); lookupStarted = gate(); return { ...deferred, started: lookupStarted.promise }; },
    counts: () => ({ loads, activations, launches, transfers, waits }),
    async close() { deferred?.release(); await broker.dispose(); descriptors.dispose(); },
  };
}

test("deferred executable query returns through Wasm while the guest scheduler stays live", async () => {
  const f = await fixture(), gate = f.defer();
  const wait = spyOn(Atomics, "wait").mockImplementation(() => { throw new Error("access called Atomics.wait"); });
  let pending: Promise<void>[] = [];
  try {
    const guest = new WebAssembly.Instance(accessModule(), { runtime_proc: f.abi.imports });
    const calls = guest.exports as Record<string, (...args: number[]) => number>;
    const id = calls.access_start!(1024, f.put("guest", 1024), 2048, f.put("/bin", 2048), 1);
    expect(id).toBeGreaterThan(0);
    pending = f.deliver();
    await gate.started;
    expect(calls.access_take!(id)).toBe(-6);
    expect(f.poll(id)).toBe(0);
    // An async guest's scheduler can run a real task while the page lookup is pending.
    let scheduled = false;
    await new Promise<void>(resolve => setTimeout(() => { scheduled = true; resolve(); }, 0));
    expect(scheduled).toBe(true);
    expect(calls.getpid!()).toBe(f.client.pid);
    expect(f.counts()).toEqual({ loads: 0, activations: 0, launches: 0, transfers: 0, waits: 0 });
    gate.release(); await Promise.all(pending);
    expect(calls.access_take!(id)).toBe(0);
  } finally { wait.mockRestore(); gate.release(); await Promise.all(pending); await f.close(); }
});

test("completion before poll is visible with its result and common wake; take consumes exactly once", async () => {
  const f = await fixture();
  try {
    const before = Atomics.load(f.client.wake, 0), id = f.start();
    await Promise.all(f.deliver());
    expect(Atomics.load(f.client.wake, 0)).toBeGreaterThan(before);
    expect(f.poll(id)).toBe(1);
    const view = new DataView(f.memory.buffer);
    expect(view.getBigUint64(512, true)).toBe(99n);
    expect(view.getUint32(520, true)).toBe(5);
    expect(f.abi.imports.access_take!(id)).toBe(0);
    expect(f.abi.imports.access_take!(id)).toBe(-8);
    expect(f.poll(id)).toBe(-8);
    expect(workerProcessSlots(f.transport)).toEqual([f.transport.slot]);
    expect(Array.from(f.table.values())).toHaveLength(0);
    expect(f.client.options.descriptors.get(0)).toBeUndefined();
    expect(f.counts()).toEqual({ loads: 0, activations: 0, launches: 0, transfers: 0, waits: 0 });
  } finally { await f.close(); }
});

test("cancel retires ownership across structured clones and discards a late completion", async () => {
  const f = await fixture(), gate = f.defer();
  let pending: Promise<void>[] = [];
  try {
    const id = f.start(); pending = f.deliver(); await gate.started;
    expect(f.abi.imports.access_cancel!(id)).toBe(0);
    await Promise.all(f.deliver());
    const sequence = Atomics.load(f.client.wake, 0);
    expect(f.abi.imports.access_take!(id)).toBe(-8);
    expect(f.abi.imports.access_cancel!(id)).toBe(-8);
    gate.release(); await Promise.all(pending);
    expect(Atomics.load(f.client.wake, 0)).toBe(sequence);
    const next = f.start(); expect(next).toBeGreaterThan(id);
    await Promise.all(f.deliver()); expect(f.abi.imports.access_take!(next)).toBe(0);
  } finally { gate.release(); await Promise.all(pending); await f.close(); }
});

for (const death of ["exit", "signal", "dispose"] as const) test(`${death} retires pending executable queries without waiting for lookup`, async () => {
  const f = await fixture(), gate = f.defer();
  let pending: Promise<void>[] = [];
  try {
    const id = f.start();
    const message = f.messages[0]!;
    if (message.operation !== "access") throw new Error("missing query");
    const cells = new Int32Array(message.request.completion);
    pending = f.deliver(); await gate.started;
    if (death === "exit") { f.client.exit(0); await f.broker.rootExit(f.client.pid, 0); }
    else if (death === "signal") { f.client.defaultSignal(f.client.pid, 9); f.broker.revokeRuntimeProcess(f.client.pid); }
    else await f.broker.dispose();
    expect(Atomics.load(cells, 0)).toBe(2);
    const sequence = Atomics.load(f.client.wake, 0);
    gate.release(); await Promise.all(pending);
    expect(Atomics.load(cells, 0)).toBe(2);
    expect(Atomics.load(f.client.wake, 0)).toBe(sequence);
    expect(f.abi.imports.access_take!(id)).toBe(-71);
    expect(f.counts()).toEqual({ loads: 0, activations: 0, launches: 0, transfers: 0, waits: 0 });
  } finally { gate.release(); await Promise.all(pending); await f.close(); }
});

test("submission copies path and absolute cwd before guest memory changes", async () => {
  const f = await fixture();
  try {
    const id = f.start("../guest", "/bin/sub");
    new Uint8Array(f.memory.buffer).fill(0, 1024, 4096);
    f.memory.grow(1);
    await Promise.all(f.deliver());
    expect(f.abi.imports.access_take!(id)).toBe(0);
    expect(f.messages).toHaveLength(0);
    expect(f.lookups).toContain("/bin/sub/../guest");
  } finally { await f.close(); }
});

for (const [path, cwd, expected] of [
  ["guest", "/bin", 0], ["./guest", "/bin", 0], ["../guest", "/bin/sub", 0],
  ["﻿guest", "/bin", -44],
  ["/bin/guest", "/no-such-cwd", 0], ["/bin/guest/../guest", "/", -54],
  ["/absent/../bin/guest", "/", -44], ["missing", "/bin", -44],
  ["plain", "/bin", -2], ["sub", "/bin", -2],
] as const) test(`query ${path} from ${cwd} returns ${expected} without loading or spawning`, async () => {
  const f = await fixture();
  try {
    const id = f.start(path, cwd); expect(id).toBeGreaterThan(0);
    await Promise.all(f.deliver()); expect(f.abi.imports.access_take!(id)).toBe(expected);
    expect(f.counts()).toEqual({ loads: 0, activations: 0, launches: 0, transfers: 0, waits: 0 });
  } finally { await f.close(); }
});

for (const change of ["unregister", "unlink"] as const) test(`query and spawn revalidate ${change} after an earlier success`, async () => {
  const f = await fixture();
  const supervisor = new ProcessSupervisor({ registry: f.registry, launch() { throw new Error("must reject before launch"); } });
  try {
    const first = f.start(); await Promise.all(f.deliver()); expect(f.abi.imports.access_take!(first)).toBe(0);
    if (change === "unregister") f.registry.unregister("/bin/guest"); else f.fs.remove("/bin/guest");
    const second = f.start(); await Promise.all(f.deliver()); expect(f.abi.imports.access_take!(second)).toBe(change === "unlink" ? -44 : -2);
    const root = supervisor.createRoot();
    const child = supervisor.reserveSpawn(root, { executable: "./guest", argv: [], env: {}, cwd: "/bin", job: 0, fds: [] });
    await supervisor.start(child);
    expect(await supervisor.waitForExit(root, child)).toMatchObject({ kind: "start-failed", error: change === "unlink" ? "ENOENT" : "EACCES" });
    expect(f.counts().loads).toBe(0);
  } finally { supervisor.dispose(); await f.close(); }
});

test("live requests are bounded and take/cancel release capacity without recycling IDs", async () => {
  const f = await fixture();
  try {
    const ids = Array.from({ length: MAX_ACCESS_REQUESTS }, () => f.start());
    expect(ids.every(id => id > 0)).toBe(true);
    expect(f.start()).toBe(-6);
    expect(f.abi.imports.access_cancel!(ids[0]!)).toBe(0);
    const extra = f.start(); expect(extra).toBeGreaterThan(ids.at(-1)!);
    await Promise.all(f.deliver());
    expect(f.start()).toBe(-6); // Completed but untaken requests still own their slots.
    expect(f.abi.imports.access_take!(ids[1]!)).toBe(0);
    const next = f.start(); expect(next).toBeGreaterThan(extra);
    expect(f.abi.imports.access_cancel!(next)).toBe(0);
    await Promise.all(f.deliver());
  } finally { await f.close(); }
});

test("invalid mode, encoding, empty/NUL paths, relative cwd and memory faults never submit requests", async () => {
  const f = await fixture();
  try {
    for (const mode of [0, 2, 3, 4, 5, -1]) expect(f.start("guest", "/bin", mode)).toBe(-28);
    for (const [path, cwd] of [["", "/bin"], ["a\0b", "/bin"], ["guest", "bin"], ["guest", ""], ["guest", "/bin\0"]]) expect(f.start(path, cwd)).toBe(-28);
    new Uint8Array(f.memory.buffer)[1024] = 255;
    expect(f.abi.imports.access_start!(1024, 1, 2048, f.put("/bin", 2048), 1)).toBe(-28);
    expect(f.abi.imports.access_start!(65536, 1, 2048, 4, 1)).toBe(-21);
    expect(f.abi.imports.access_start!(1024, f.put("guest", 1024), 65536, 1, 1)).toBe(-21);
    expect(f.messages).toHaveLength(0);
    expect(f.abi.imports.access_take!(1)).toBe(-8);
    expect(f.abi.imports.access_cancel!(1)).toBe(-8);
  } finally { await f.close(); }
});

function accessModule(): WebAssembly.Module {
  const names = ["access_start", "access_take", "access_cancel", "getpid"];
  const string = (text: string) => { const bytes = Array.from(encoder.encode(text)); return [bytes.length].concat(bytes); };
  const section = (id: number, bytes: number[]) => [id, bytes.length].concat(bytes);
  const types = [3, 0x60, 5, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f, 0x60, 1, 0x7f, 1, 0x7f, 0x60, 0, 1, 0x7f];
  const imports = [4].concat(names.flatMap((name, i) => string("runtime_proc").concat(string(name), [0, i === 0 ? 0 : i === 3 ? 2 : 1])));
  const exports = [4].concat(names.flatMap((name, i) => string(name).concat([0, i])));
  return new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0].concat(section(1, types), section(2, imports), section(7, exports))));
}

async function parityFixture(kind: "worker" | "cooperative") {
  const f = await fixture();
  const supervisor = new ProcessSupervisor({ registry: f.registry, launch() { throw new Error("queries must not launch"); } });
  const root = supervisor.createRoot();
  const descriptors = supervisor.get(root)!.descriptors;
  const abi = kind === "worker" ? f.abi : new ProcessABI({ memory: f.memory, fs: f.fs, descriptors, pid: root,
    service: supervisor, signals: supervisor.get(root)!, wake: f.client.wake,
    wait() { throw new Error("nonblocking query slept"); },
  });
  return { ...f, abi, supervisor, root, descriptors,
    start(path = "./guest", cwd = "/bin", mode = 1) {
      return abi.imports.access_start!(1024, f.put(path, 1024), 2048, f.put(cwd, 2048), mode);
    },
    poll(id: number) {
      const view = new DataView(f.memory.buffer);
      view.setUint32(256, 5, true); view.setUint32(260, id, true); view.setBigUint64(264, 99n, true);
      return abi.imports.poll!(256, 1, 0, 512);
    },
    settle: () => kind === "worker" ? Promise.all(f.deliver()) : new Promise<void>(resolve => setTimeout(resolve, 0)),
    die() { if (kind === "worker") f.client.defaultSignal(f.client.pid, 9); else supervisor.kill(root, 9); },
    async close() { supervisor.dispose(); await f.close(); },
  };
}

for (const kind of ["worker", "cooperative"] as const) {
  for (const [path, cwd, expected] of [
    ["guest", "/bin", 0], ["./guest", "/bin", 0], ["../guest", "/bin/sub", 0],
    ["/bin/guest", "/missing-cwd", 0], ["/../bin/guest", "/", 0], ["../bin/guest", "/", 0],
    ["/bin/../../bin/guest", "/", 0], ["missing", "/bin", -44], ["plain", "/bin", -2],
    ["sub", "/bin", -2], ["/bin/guest/", "/", -54], ["/bin/guest/../guest", "/", -54],
    ["/missing/../bin/guest", "/", -44], ["﻿guest", "/bin", -44],
  ] as const) test(`${kind} access parity: ${path} from ${cwd} gives ${expected}`, async () => {
    const f = await parityFixture(kind);
    try {
      const before = Atomics.load(f.client.wake, 0), id = f.start(path, cwd);
      expect(id).toBeGreaterThan(0);
      await f.settle();
      expect(Atomics.load(f.client.wake, 0)).toBeGreaterThan(before);
      expect(f.poll(id)).toBe(1);
      expect(f.abi.imports.access_take!(id)).toBe(expected);
      expect(f.abi.imports.access_take!(id)).toBe(-8);
      expect(Array.from(f.supervisor.table.values())).toHaveLength(1);
      expect(f.descriptors.get(0)).toBeUndefined();
      expect(f.counts()).toEqual({ loads: 0, activations: 0, launches: 0, transfers: 0, waits: 0 });
    } finally { await f.close(); }
  });

  test(`${kind} access parity: pending queries keep scheduler live and cancellation drops late completion`, async () => {
    const f = await parityFixture(kind), deferred = f.defer();
    let pending: Promise<unknown> | undefined;
    try {
      const id = f.start(); expect(id).toBeGreaterThan(0);
      pending = f.settle(); await deferred.started;
      expect(f.abi.imports.access_take!(id)).toBe(-6);
      expect(f.poll(id)).toBe(0);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(f.abi.imports.getpid!()).toBe(kind === "worker" ? f.client.pid : f.root);
      expect(f.abi.imports.access_cancel!(id)).toBe(0);
      const sequence = Atomics.load(f.client.wake, 0);
      deferred.release(); await pending; await f.settle();
      expect(f.abi.imports.access_take!(id)).toBe(-8);
      expect(Atomics.load(f.client.wake, 0)).toBe(sequence);
      expect(f.counts()).toEqual({ loads: 0, activations: 0, launches: 0, transfers: 0, waits: 0 });
    } finally { deferred.release(); await pending; await f.close(); }
  });

  test(`${kind} access parity: bounds, live registration checks and death retirement`, async () => {
    const f = await parityFixture(kind);
    try {
      const ids = Array.from({ length: MAX_ACCESS_REQUESTS }, () => f.start());
      expect(ids.every(id => id > 0)).toBe(true);
      expect(f.start()).toBe(-6);
      await f.settle(); expect(f.start()).toBe(-6);
      expect(f.abi.imports.access_take!(ids[0]!)).toBe(0);
      f.registry.unregister("/bin/guest");
      const missingRegistration = f.start(); await f.settle();
      expect(f.abi.imports.access_take!(missingRegistration)).toBe(-2);
      f.register(); f.fs.remove("/bin/guest");
      const missingFile = f.start(); await f.settle();
      expect(f.abi.imports.access_take!(missingFile)).toBe(-44);
      f.die();
      expect(f.abi.imports.access_take!(ids[1]!)).toBe(-71);
      expect(f.abi.imports.access_cancel!(ids[2]!)).toBe(-71);
      expect(f.start()).toBe(-71);
      expect(f.counts()).toEqual({ loads: 0, activations: 0, launches: 0, transfers: 0, waits: 0 });
    } finally { await f.close(); }
  });
}

for (const kind of ["worker", "cooperative"] as const) test(`${kind} access parity: death discards a pending lookup without a late wake`, async () => {
  const f = await parityFixture(kind), deferred = f.defer();
  let pending: Promise<unknown> | undefined;
  try {
    const id = f.start(); expect(id).toBeGreaterThan(0);
    pending = f.settle(); await deferred.started;
    f.die();
    const sequence = Atomics.load(f.client.wake, 0);
    expect(f.abi.imports.access_take!(id)).toBe(-71);
    deferred.release(); await pending; await f.settle();
    expect(Atomics.load(f.client.wake, 0)).toBe(sequence);
    expect(f.abi.imports.access_cancel!(id)).toBe(-71);
  } finally { deferred.release(); await pending; await f.close(); }
});

for (const kind of ["worker", "cooperative"] as const) test(`${kind} access parity: copied inputs, invalid modes and request ownership`, async () => {
  const f = await parityFixture(kind);
  try {
    for (const mode of [0, 2, 3, -1]) expect(f.start("guest", "/bin", mode)).toBe(-28);
    for (const [path, cwd] of [["", "/bin"], ["guest", "bin"], ["a\0b", "/bin"]]) expect(f.start(path, cwd)).toBe(-28);
    const id = f.start("../guest", "/bin/sub"); expect(id).toBeGreaterThan(0);
    new Uint8Array(f.memory.buffer).fill(0, 1024, 4096); f.memory.grow(1);
    await f.settle(); expect(f.abi.imports.access_take!(id)).toBe(0);
    expect(f.abi.imports.access_cancel!(id)).toBe(-8);
    expect(f.lookups).toEqual(["/bin/sub/../guest"]);
    expect(f.counts()).toEqual({ loads: 0, activations: 0, launches: 0, transfers: 0, waits: 0 });
  } finally { await f.close(); }
});
