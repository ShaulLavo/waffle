import { expect, spyOn, test } from "bun:test";
import { DescriptorTable } from "../core/descriptors";
import { MemFS } from "../fs/memory";
import { ProcessABI } from "../proc/abi";
import { ExecutableRegistry } from "../proc/registry";
import { ProcessSupervisor } from "../proc/supervisor";
import { WorkerProcessBroker } from "../proc/worker-broker";
import { WorkerProcessClient, createWorkerProcessTransport, workerProcessState, type WorkerProcessMessage } from "../proc/worker-client";

function gate() { return Promise.withResolvers<void>(); }
function fixture() {
  const fs = new MemFS(); fs.mkdirp("/bin/dir"); fs.writeFile("/bin/guest", new Uint8Array()); fs.writeFile("/bin/plain", new Uint8Array());
  let lookup: ReturnType<typeof gate> | undefined;
  const started = gate();
  const registry = new ExecutableRegistry(async path => {
    if (lookup) { started.resolve(); await lookup.promise; }
    const components = path.split("/").filter(Boolean), current: string[] = [];
    for (const component of components) {
      if (fs.lookup(`/${current.join("/")}`)?.kind !== "dir") throw { errno: 54 };
      if (component === "..") current.pop(); else if (component !== ".") current.push(component);
      if (!fs.lookup(`/${current.join("/")}`)) return undefined;
    }
    const absolute = `/${current.join("/")}`, entry = fs.lookup(absolute);
    return entry && { path: absolute, kind: entry.kind };
  });
  registry.register("/bin/guest", { adapter: "test", module: () => { throw new Error("queries never load modules"); } });
  const supervisor = new ProcessSupervisor({ registry, launch() { throw new Error("queries never launch"); } });
  const transport = createWorkerProcessTransport(), state = workerProcessState(transport);
  supervisor.createRoot({ pid: state.pid, job: state.job, ...state.signals });
  const descriptors = new DescriptorTable(), messages: WorkerProcessMessage[] = [];
  const codec = { export() { throw new Error("unexpected descriptor"); }, import() { throw new Error("unexpected descriptor"); }, discard() {} };
  const broker = new WorkerProcessBroker({ supervisor: () => Promise.resolve(supervisor), codec }); broker.adoptRoot(transport);
  const client = new WorkerProcessClient({ transport, descriptors, codec, postMessage: message => messages.push(structuredClone(message)) });
  const memory = new WebAssembly.Memory({ initial: 1 }), bytes = new Uint8Array(memory.buffer), encode = new TextEncoder();
  const abi = new ProcessABI({ memory, fs, descriptors, service: client, pid: client.pid, wake: client.wake, signals: client.signals });
  const put = (text: string, ptr: number) => { const value = encode.encode(text); bytes.set(value, ptr); return value.length; };
  return { supervisor, broker, client, abi, transport, messages, registry, fs,
    defer() { lookup = gate(); return { release: lookup.resolve, started: started.promise }; },
    start: (path = "guest", cwd = "/bin") => abi.imports.access_start!(1024, put(path, 1024), 2048, put(cwd, 2048), 1),
    deliver: () => Promise.all(messages.splice(0).map(message => broker.handle(message, client.pid))),
    poll(id: number) { const view = new DataView(memory.buffer); view.setUint32(256, 5, true); view.setUint32(260, id, true); view.setBigUint64(264, 42n, true); return abi.imports.poll!(256, 1, 0, 512); },
    close() { lookup?.resolve(); broker.dispose(); supervisor.dispose(); descriptors.dispose(); },
  };
}

for (const [path, expected] of [["guest", 0], ["/bin/guest", 0], ["missing", -44], ["plain", -2], ["dir", -2], ["/bin/guest/../guest", -54], ["/missing/../bin/guest", -44]] as const) {
  test(`generic worker executable query ${path} returns ${expected}`, async () => {
    const f = fixture();
    try {
      const id = f.start(path); expect(id).toBeGreaterThan(0); expect(f.abi.imports.access_take!(id)).toBe(-6);
      const sequence = Atomics.load(f.client.wake, 0);
      await f.deliver(); expect(Atomics.load(f.client.wake, 0)).toBeGreaterThan(sequence);
      expect(f.poll(id)).toBe(1); expect(f.abi.imports.access_take!(id)).toBe(expected);
      expect(f.abi.imports.access_take!(id)).toBe(-8); expect(f.abi.imports.access_cancel!(id)).toBe(-8); expect(f.poll(id)).toBe(-8);
      expect(Array.from(f.supervisor.table.values())).toHaveLength(1);
    } finally { f.close(); }
  });
}

test("generic worker bounds untaken requests, keeps IDs monotonic and rechecks live metadata", async () => {
  const f = fixture();
  try {
    const ids = Array.from({ length: 64 }, () => f.start()); expect(f.start()).toBe(-6);
    await f.deliver(); expect(f.start()).toBe(-6);
    expect(f.abi.imports.access_take!(ids[0]!)).toBe(0);
    f.registry.unregister("/bin/guest"); const next = f.start(); expect(next).toBeGreaterThan(ids.at(-1)!);
    await f.deliver(); expect(f.abi.imports.access_take!(next)).toBe(-2);
    f.fs.remove("/bin/guest"); const missing = f.start(); await f.deliver(); expect(f.abi.imports.access_take!(missing)).toBe(-44);
    expect(f.abi.imports.access_take!(next + 100)).toBe(-8);
  } finally { f.close(); }
});

for (const ending of ["cancel", "exit", "signal", "dispose"] as const) test(`generic worker ${ending} ends a pending wait without a lookup deadline`, async () => {
  const f = fixture(), deferred = f.defer();
  const asyncAtomics = Atomics as typeof Atomics & { waitAsync(array: Int32Array, index: number, value: number): { async: boolean; value: string | Promise<string> } };
  const original = asyncAtomics.waitAsync, pending = new Set<Promise<string>>();
  const wait = spyOn(asyncAtomics, "waitAsync").mockImplementation((array, index, value) => {
    const result = original(array, index, value);
    if (!result.async) return result;
    const completion = (result.value as Promise<string>).finally(() => pending.delete(completion)); pending.add(completion);
    return { async: true, value: completion };
  });
  let delivery: Promise<unknown> | undefined;
  try {
    const id = f.start(), message = f.messages[0]!;
    if (message.operation !== "access") throw new Error("missing query");
    const cells = new Int32Array(message.request.completion);
    delivery = f.deliver(); await deferred.started;
    await new Promise<void>(resolve => setTimeout(resolve, 0)); expect(pending.size).toBe(1);
    expect(f.poll(id)).toBe(0);
    if (ending === "cancel") { expect(f.abi.imports.access_cancel!(id)).toBe(0); await f.deliver(); }
    else if (ending === "exit") f.supervisor.exit(f.client.pid, 0);
    else if (ending === "signal") f.supervisor.kill(f.client.pid, 9);
    else f.broker.dispose();
    await delivery;
    expect(pending.size).toBe(0); expect(Atomics.load(cells, 0)).toBe(2);
    const sequence = Atomics.load(f.client.wake, 0);
    deferred.release(); await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(Atomics.load(cells, 0)).toBe(2); expect(Atomics.load(f.client.wake, 0)).toBe(sequence);
  } finally { deferred.release(); try { await delivery; } finally { wait.mockRestore(); f.close(); } }
});

for (const foreign of ["sender", "directory"] as const) test(`generic worker rejects a foreign ${foreign} before lookup`, async () => {
  const f = fixture();
  try {
    const id = f.start(), message = f.messages.shift()!;
    if (foreign === "directory") message.transport = createWorkerProcessTransport({ pid: f.client.pid });
    await f.broker.handle(message, foreign === "sender" ? f.client.pid + 1 : f.client.pid);
    expect(f.abi.imports.access_take!(id)).toBe(-71);
    expect(f.abi.imports.access_take!(id)).toBe(-8);
  } finally { f.close(); }
});

test("cancel before its notification retires the supervisor query when lookup completes first", async () => {
  const f = fixture(), deferred = f.defer();
  let delivery: Promise<unknown> | undefined;
  try {
    const id = f.start(); delivery = f.deliver(); await deferred.started;
    expect(f.abi.imports.access_cancel!(id)).toBe(0);
    // Deliberately delay the cancellation message until the completion wake runs.
    deferred.release(); await delivery; await f.deliver();
    const ids = Array.from({ length: 64 }, () => f.supervisor.accessStart(f.client.pid, "/bin/guest", "/"));
    expect(ids.every(id => id > 0)).toBe(true);
    expect(f.supervisor.accessStart(f.client.pid, "/bin/guest", "/")).toBe(-6);
    for (const request of ids) f.supervisor.accessCancel(f.client.pid, request);
  } finally { deferred.release(); try { await delivery; } finally { f.close(); } }
});

test("cancel bypasses unrelated pending spawn admission and wakes its waiter", async () => {
  const f = fixture(), deferred = f.defer(), admission = gate();
  let delivery: Promise<unknown> | undefined;
  try {
    const id = f.start(); delivery = f.deliver(); await deferred.started;
    // Model an unrelated spawn held at its asynchronous admission/cleanup fence.
    (f.broker as unknown as { admission: Promise<void> }).admission = admission.promise;
    expect(f.abi.imports.access_cancel!(id)).toBe(0);
    await f.deliver(); await delivery;
    expect(f.abi.imports.access_take!(id)).toBe(-8);
    const requests = (f.supervisor as unknown as { accesses: Map<number, { requests: Map<number, unknown> }> }).accesses.get(f.client.pid)!.requests;
    expect(requests.size).toBe(0);
  } finally { admission.resolve(); deferred.release(); try { await delivery; } finally { f.close(); } }
});

test("a rejected duplicate cannot replace an already-published access result", async () => {
  const f = fixture();
  try {
    const id = f.start(), duplicate = structuredClone(f.messages[0]!);
    await f.deliver();
    await f.broker.handle(duplicate, f.client.pid + 1);
    expect(f.abi.imports.access_take!(id)).toBe(0);
  } finally { f.close(); }
});
