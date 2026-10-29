import { expect, test } from "bun:test";
import { createGroupMember } from "../group/member.js";
import { GroupOp, PAGE_BYTES } from "../group/protocol.js";
import { MemoryGroups } from "../group/state.js";
import { growthFree } from "../link/code.js";
import { prepareLinkPlan } from "../link/index.js";
import { BrowserProcessBroker } from "../browser/process-broker.js";
import { ProcessIdentityAllocator } from "../proc/identity.js";
import { ProcessTable } from "../proc/table.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { createWorkerProcessTransport } from "../proc/worker-client.js";
import { createFilesystemIdentity } from "../fs/protocol.js";

// Regressions for the PR207 review: budget bypass, wake-one starvation, failed output spans
// and settled root leases. The probes follow the reviewer's retained cases.

const leb = (n: number): number[] =>
  n < 128 ? [n] : [(n % 128) + 128].concat(leb(Math.floor(n / 128)));
const name = (s: string) => leb(s.length).concat(Array.from(new TextEncoder().encode(s)));
const vec = (items: readonly number[][]) => leb(items.length).concat(items.flat());
const section = (id: number, bytes: number[]) => [id].concat(leb(bytes.length), bytes);
const body = (ops: number[]) => leb(ops.length + 2).concat([0], ops, [0x0b]);
const binary = (...sections: number[][]) =>
  new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0].concat(sections.flat()));

/** A PIE core whose _start body is `ops`; optionally re-exports the imported memory. */
function pieCore(ops: number[], exportMemory = false): Uint8Array<ArrayBuffer> {
  const exports = [
    name("check").concat([0, 0]),
    name("reserve").concat([0, 1]),
    name("_start").concat([0, 2]),
  ].concat(exportMemory ? [name("memory").concat([2, 0])] : []);
  const env = (field: string, descriptor: number[]) => name("env").concat(name(field), descriptor);
  return binary(
    section(0, name("dylink.0").concat([1, 4, 16, 2, 0, 0])),
    section(
      1,
      vec([
        [0x60, 0, 0],
        [0x60, 2, 0x7f, 0x7f, 1, 0x7f],
      ]),
    ),
    section(
      2,
      vec([
        env("check", [0, 0]),
        env("memory", [2, 3, 1].concat(leb(65536))),
        env("__indirect_function_table", [1, 0x70, 0, 1]),
        env("__stack_pointer", [3, 0x7f, 1]),
        env("__memory_base", [3, 0x7f, 0]),
        env("__table_base", [3, 0x7f, 0]),
      ]),
    ),
    section(3, vec([[1], [0]])),
    section(7, vec(exports)),
    section(10, vec([body([0x41, 0]), body(ops)])),
  );
}
const plan = (source: Uint8Array) =>
  prepareLinkPlan({
    core: {
      id: "core",
      source,
      cooperative: true,
      checkpoint: { module: "env", name: "check" },
      initialize: [],
    },
    libraries: [],
    reserve: "reserve",
  });

test("group images that grow or export the shared memory are refused at admission", async () => {
  await plan(pieCore([0x10, 0]));
  // i32.const 3; memory.grow 0; drop
  await expect(plan(pieCore([0x41, 3, 0x40, 0, 0x1a]))).rejects.toThrow("memory.grow");
  await expect(plan(pieCore([0x10, 0], true))).rejects.toThrow("export the shared memory");
});

test("the scan decodes immediates instead of matching a 0x40 byte", () => {
  const code = (ops: number[]) => binary(section(10, vec([body(ops)])));
  // block (void 0x40), i32.const 64, br_table, SIMD v128.const, atomic add, memory.fill, try_table
  const decoded = [0x02, 0x40, 0x41, 0xc0, 0x00, 0x1a, 0x0b];
  const table = [0x41, 0, 0x0e, 2, 0, 0, 0];
  const simd = [0xfd, 12].concat(Array(16).fill(0x40), [0x1a]);
  const atomic = [0x41, 0, 0x41, 1, 0xfe, 0x1e, 2, 0, 0x1a];
  const fill = [0x41, 0, 0x41, 0, 0x41, 0, 0xfc, 11, 0];
  const tryTable = [0x1f, 0x40, 1, 2, 0, 0x0b];
  expect(growthFree(code(decoded.concat(table, simd, atomic, fill, tryTable)), "probe")).toBe(true);
  expect(growthFree(code([0x41, 1, 0x40, 0, 0x1a]), "probe")).toBe(false);
  expect(() => growthFree(code([0xfb, 0]), "probe")).toThrow("unsupported opcode");
});

test("reference instructions without immediates cannot hide a following memory.grow", () => {
  // (func (param externref) local.get 0 ref.as_non_null ref.is_null memory.grow drop): valid
  // Wasm whose grow is at most one page. 0xd4 has no immediate, so the grow must be seen.
  const asNonNull = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 1, 111, 0, 3, 2, 1, 0, 5, 4, 1, 3, 1, 8, 10, 11, 1, 9,
    0, 32, 0, 212, 209, 64, 0, 26, 11,
  ]);
  expect(WebAssembly.validate(asNonNull)).toBe(true);
  expect(growthFree(asNonNull, "reference")).toBe(false);
  // Without the grow, the same reference sequence decodes as growth-free.
  const benign = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 1, 111, 0, 3, 2, 1, 0, 10, 9, 1, 7, 0, 32, 0, 212,
    209, 26, 11,
  ]);
  expect(WebAssembly.validate(benign)).toBe(true);
  expect(growthFree(benign, "reference")).toBe(true);
});

test("growth around the owner is charged truthfully and closes the group to growth", () => {
  const groups = new MemoryGroups({ budgetBytes: 2 * PAGE_BYTES, maximumPages: 8 });
  const lease = groups.admit(1, "d", "new");
  const { request } = lease.launch();
  request.port.close();
  const owner = groups.owner(lease.group)!;
  // A trusted executor holds the Memory object; Waffle loaders never admit such an image.
  expect(request.memory.grow(3)).toBe(1);
  expect(owner.snapshot()).toMatchObject({ committedBytes: 4 * PAGE_BYTES, bypassed: true });
  expect(groups.budget.committed).toBe(4 * PAGE_BYTES);
  expect(owner.request(lease, GroupOp.GROW, 1)[0]).toBe(-48);
  expect(() => groups.admit(2, "d", lease.group)).toThrow("grew outside its owner");
  lease.stopped();
  expect(groups.budget.committed).toBe(0);
  expect(groups.snapshot()).toEqual([]);
});

test("the page handle exposes shared bytes, not a growable Memory", () => {
  const groups = new MemoryGroups();
  const lease = groups.admit(1, "d", "new");
  expect(lease.group.buffer()).toBeInstanceOf(SharedArrayBuffer);
  expect("memory" in lease.group).toBe(false);
  lease.abort();
});

function member(watches = 4) {
  const channel = new MessageChannel();
  const shared = createGroupMember(
    {
      memory: new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true }),
      control: new SharedArrayBuffer(16 + watches * 16),
      reply: new SharedArrayBuffer(20),
      port: channel.port2,
      index: 0,
      watches,
      parallelism: 1,
      stackBytes: PAGE_BYTES,
    },
    { checkActive() {} },
  );
  return {
    shm: shared.imports,
    ready: (id: number) => shared.watchReady(id),
    dispose() {
      shared.dispose();
      channel.port1.close();
    },
  };
}

test("successive wake-one calls ready distinct watches and never reselect a hit", () => {
  const { shm, ready, dispose } = member();
  try {
    expect(shm.futex_watch!(0, 0, 16)).toBe(0);
    expect(shm.futex_watch!(0, 0, 20)).toBe(0);
    expect(shm.futex_wake!(0, 1)).toBe(1);
    expect([ready(1), ready(2)]).toEqual([true, false]);
    expect(shm.futex_wake!(0, 1)).toBe(1);
    expect([ready(1), ready(2)]).toEqual([true, true]);
    expect(shm.futex_wake!(0, 1)).toBe(0);
    // Unwatch and reuse a slot: the new registration is pending again.
    expect(shm.futex_unwatch!(1)).toBe(0);
    expect(shm.futex_watch!(0, 0, 24)).toBe(0);
    expect(ready(1)).toBe(false);
    expect(shm.futex_wake!(0, 0xffffffff)).toBe(1);
    expect(ready(1)).toBe(true);
  } finally {
    dispose();
  }
});

test("concurrent wakers claim each pending watch once", async () => {
  const groups = new MemoryGroups({ watches: 64 });
  const lease = groups.admit(1, "d", "new");
  const { request } = lease.launch();
  request.port.close();
  const shared = createGroupMember(request, { checkActive() {} });
  try {
    for (let index = 0; index < 40; index++) expect(shared.imports.futex_watch!(64, 0, 0)).toBe(0);
    const entry = new URL("./fixtures/memory-group-wake-worker.ts", import.meta.url).href;
    const workers = [new Worker(entry), new Worker(entry)];
    const totals = await Promise.all(
      workers.map(
        (worker) =>
          new Promise<number>((resolve, reject) => {
            worker.onmessage = ({ data }) => resolve(data);
            worker.onerror = reject;
            const channel = new MessageChannel();
            const copy = { ...request, port: channel.port2 };
            worker.postMessage({ request: copy, addr: 64, count: 40 }, [channel.port2]);
          }),
      ),
    );
    await Promise.all(workers.map((worker) => worker.terminate()));
    expect(totals[0]! + totals[1]!).toBe(40);
    for (let id = 1; id <= 40; id++) expect(shared.watchReady(id)).toBe(true);
  } finally {
    shared.dispose();
    lease.stopped();
  }
});

test("invalid output spans leave regions, holds and pins unchanged", async () => {
  const groups = new MemoryGroups({ regions: 1, budgetBytes: 8 * PAGE_BYTES });
  const lease = groups.admit(1, "d", "new");
  const worker = new Worker(new URL("./fixtures/memory-group-abi-worker.ts", import.meta.url).href);
  try {
    const result = new Promise<Record<string, number[]>>((resolve, reject) => {
      worker.onmessage = ({ data }) => resolve(data);
      worker.onerror = reject;
    });
    const launched = lease.launch();
    worker.postMessage({ request: launched.request, mode: "outputs" }, launched.transfer);
    expect(await result).toEqual({
      create: [-28, -28, -28],
      valid: [0],
      attach: [-28, -28, -28],
      pin: [-28, -28, -28],
      pinned: [0],
      accept: [-28, -28, -28],
      accepted: [0],
    });
    // One region, the creator's hold plus the accepted pin's hold, no pin left.
    expect(groups.owner(lease.group)!.snapshot()).toMatchObject({ regions: 1, pins: 0, holds: 2 });
  } finally {
    await worker.terminate();
    lease.stopped();
  }
});

test("a settled external root no longer retains its group lease", async () => {
  const identities = new ProcessIdentityAllocator();
  const refuse = (): never => {
    throw new Error("unused");
  };
  const quiet = () => {};
  const filesystem = { connect: refuse, revoke: quiet, reap: quiet, quiesce: async () => {} };
  const table = new ProcessTable(identities);
  const registry = new ExecutableRegistry();
  const broker = new BrowserProcessBroker({
    identities,
    table,
    registry,
    filesystem,
    launch: refuse,
  });
  try {
    const root = createWorkerProcessTransport({
      pid: identities.pid(),
      job: identities.job(),
      identity: identities.buffer,
    });
    root.data = { filesystem: createFilesystemIdentity() };
    await broker.adoptRuntimeRoot(root);
    const first = broker.admitRootMemoryGroup(root.pid);
    first.request.port.close();
    first.stopped();
    first.stopped();
    expect(broker.memoryGroups()).toEqual([]);
    expect((Reflect.get(broker, "rootGroups") as Map<number, unknown>).size).toBe(0);
    // A later admission for the same root starts a fresh group.
    const second = broker.admitRootMemoryGroup(root.pid);
    second.request.port.close();
    expect(broker.memoryGroups()).toHaveLength(1);
    second.stopped();
  } finally {
    await broker.dispose();
  }
});
