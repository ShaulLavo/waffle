import { expect, test } from "bun:test";
import { Wasi } from "../core/wasi.js";
import { MemFS } from "../fs/memory.js";
import { instantiateLinkPlan, prepareLinkPlan } from "../link/index.js";
import { inspectProfile } from "../link/metadata.js";
import { PAGE_BYTES } from "../group/protocol.js";
import { MemoryGroups, type MemberLease } from "../group/state.js";

const leb = (n: number): number[] =>
  n < 128 ? [n] : [(n % 128) + 128].concat(leb(Math.floor(n / 128)));
const name = (s: string) => leb(s.length).concat(Array.from(new TextEncoder().encode(s)));
const vec = (items: readonly number[][]) => leb(items.length).concat(items.flat());
const section = (id: number, bytes: number[]) => [id].concat(leb(bytes.length), bytes);
const imp = (field: string, descriptor: number[]) => name("env").concat(name(field), descriptor);
const globalImp = (module: string, field: string, mutable: boolean) =>
  name(module).concat(name(field), [3, 0x7f, mutable ? 1 : 0]);
const exp = (field: string, kind: number, index: number) => name(field).concat([kind], leb(index));
const sleb = (n: number): number[] => {
  const out: number[] = [];
  for (;;) {
    const byte = n & 0x7f;
    n >>= 7;
    if ((n === 0 && !(byte & 0x40)) || (n === -1 && byte & 0x40)) return out.concat([byte]);
    out.push(byte | 0x80);
  }
};
const body = (ops: number[]) => leb(ops.length + 2).concat([0], ops, [0x0b]);

interface CoreResourceImports {
  readonly memory?: number[] | null;
  readonly table?: number[] | null;
  readonly globals?: readonly number[][];
}

/** A PIE core: imports shared memory, table, bases and stack; exports a const data address. */
function pieCore(
  stackBounds = false,
  foreignStackName = false,
  resources: CoreResourceImports = {},
): Uint8Array<ArrayBuffer> {
  const stackNames = foreignStackName ? ["foreign"] : ["__stack_high", "__stack_low"];
  const importInfo = stackBounds
    ? leb(stackNames.length).concat(
        stackNames.flatMap((field) => name("env").concat(name(field), leb(0x11))),
      )
    : [];
  const dylink = name("dylink.0").concat(
    [1, 4, 16, 2, 0, 0],
    stackBounds ? [4].concat(leb(importInfo.length), importInfo) : [],
  );
  const stackImports = stackBounds
    ? stackNames.map((field) => globalImp("GOT.mem", field, true))
    : [];
  const dataGlobal = 3 + stackImports.length + (resources.globals?.length ?? 0);
  return new Uint8Array(
    [0, 97, 115, 109, 1, 0, 0, 0].concat(
      section(0, dylink),
      section(
        1,
        vec([
          [0x60, 0, 0],
          [0x60, 2, 0x7f, 0x7f, 1, 0x7f],
        ]),
      ),
      section(
        2,
        vec(
          [imp("check", [0, 0])].concat(
            resources.memory === null
              ? []
              : [resources.memory ?? imp("memory", [2, 3, 1].concat(leb(65536)))],
            resources.table === null
              ? []
              : [resources.table ?? imp("__indirect_function_table", [1, 0x70, 0, 1])],
            [
              imp("__stack_pointer", [3, 0x7f, 1]),
              imp("__memory_base", [3, 0x7f, 0]),
              imp("__table_base", [3, 0x7f, 0]),
            ],
            stackImports,
            resources.globals ?? [],
          ),
        ),
      ),
      section(3, vec([[1], [0]])),
      section(6, vec([[0x7f, 0, 0x41, 16, 0x0b]])),
      section(
        7,
        vec([
          exp("check", 0, 0),
          exp("bun_core_alloc", 0, 1),
          exp("_start", 0, 2),
          exp("data_sym", 3, dataGlobal),
        ]),
      ),
      // bun_core_alloc returns page 2; _start calls the checkpoint.
      section(10, vec([body([0x41].concat(sleb(131072))), body([0x10, 0])])),
    ),
  );
}

/** A PIC side reading the core's data symbol through GOT.mem. */
function side(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    [0, 97, 115, 109, 1, 0, 0, 0].concat(
      section(0, name("dylink.0").concat([1, 4, 16, 2, 0, 0])),
      section(
        1,
        vec([
          [0x60, 0, 0],
          [0x60, 0, 1, 0x7f],
        ]),
      ),
      section(
        2,
        vec([
          imp("check", [0, 0]),
          imp("memory", [2, 3, 1].concat(leb(65536))),
          imp("__indirect_function_table", [1, 0x70, 0, 1]),
          imp("__memory_base", [3, 0x7f, 0]),
          imp("__table_base", [3, 0x7f, 0]),
          imp("__stack_pointer", [3, 0x7f, 1]),
          name("GOT.mem").concat(name("data_sym"), [3, 0x7f, 1]),
        ]),
      ),
      section(3, vec([[1]])),
      section(7, vec([exp("read", 0, 1)])),
      section(10, vec([body([0x23, 3])])),
    ),
  );
}

function host(coreImports?: WebAssembly.Imports) {
  const wasi = new Wasi({
    args: [],
    env: {},
    fs: new MemFS(),
    preopens: {},
    stdout() {},
    stderr() {},
    sleep() {},
    namespaces: { env: { check() {} } },
  });
  return { wasi, checkActive() {}, coreImports };
}

const plan = () =>
  prepareLinkPlan({
    core: {
      id: "core",
      source: pieCore(),
      cooperative: true,
      checkpoint: { module: "env", name: "check" },
      initialize: [],
    },
    libraries: [
      {
        id: "engine",
        source: side(),
        cooperative: true,
        checkpoint: { module: "env", name: "check" },
        initialize: [],
      },
    ],
    reserve: "bun_core_alloc",
  });

test("a core with dylink.0 is a PIE image with base-relative constant data exports", () => {
  const profile = inspectProfile(pieCore(), "core", false);
  expect(profile.pie).toBe(true);
  expect(Array.from(profile.relativeExports)).toEqual(["data_sym"]);
  expect(inspectProfile(pieCore(), "core", false).memory?.memorySize).toBe(16);
});

test("a PIE core links only into a supplied group memory and table", async () => {
  const prepared = await plan();
  expect(() => instantiateLinkPlan(prepared, host())).toThrow("PIE core requires a memory group");
  const memory = new WebAssembly.Memory({ initial: 4, maximum: 65536, shared: true });
  const table = new WebAssembly.Table({ element: "anyfunc", initial: 1 });
  const global = (value: number, mutable = false) =>
    new WebAssembly.Global({ value: "i32", mutable }, value);
  const env = {
    check() {},
    memory,
    __indirect_function_table: table,
    __stack_pointer: global(4 * 65536, true),
    __memory_base: global(65536),
    __table_base: global(1),
  };
  const group = instantiateLinkPlan(prepared, host({ env }));
  expect(group.memory).toBe(memory);
  expect(group.table).toBe(table);
  // The core's constant export 16 is relative to its own __memory_base.
  expect((group.libraries[0]!.instance.exports.read as () => number)()).toBe(65536 + 16);
  group.initialize();
  group.dispose();
});

test("a PIE core admits only weak carved stack-bound GOT.mem imports", async () => {
  const source = pieCore(true);
  const profile = inspectProfile(source, "core", false);
  expect(profile.globalImports).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ module: "GOT.mem", name: "__stack_low", mutable: true }),
      expect.objectContaining({ module: "GOT.mem", name: "__stack_high", mutable: true }),
    ]),
  );
  const prepared = await prepareLinkPlan({
    core: {
      id: "core",
      source,
      cooperative: true,
      checkpoint: { module: "env", name: "check" },
      initialize: [],
    },
    libraries: [],
    reserve: "bun_core_alloc",
  });
  const memory = new WebAssembly.Memory({ initial: 4, maximum: 65536, shared: true });
  const table = new WebAssembly.Table({ element: "anyfunc", initial: 1 });
  const global = (value: number, mutable = false) =>
    new WebAssembly.Global({ value: "i32", mutable }, value);
  const group = instantiateLinkPlan(
    prepared,
    host({
      env: {
        check() {},
        memory,
        __indirect_function_table: table,
        __stack_pointer: global(3 * 65536, true),
        __memory_base: global(65536),
        __table_base: global(1),
      },
      "GOT.mem": {
        __stack_low: global(2 * 65536, true),
        __stack_high: global(3 * 65536, true),
      },
    }),
  );
  expect(group.entry.exports.data_sym).toBeInstanceOf(WebAssembly.Global);
  group.dispose();
  await expect(
    prepareLinkPlan({
      core: {
        id: "core",
        source: pieCore(true, true),
        cooperative: true,
        checkpoint: { module: "env", name: "check" },
        initialize: [],
      },
      libraries: [],
      reserve: "bun_core_alloc",
    }),
  ).rejects.toThrow("core GOT.mem.foreign is unsupported");
});

for (const [label, resources] of [
  ["foreign global namespace", { globals: [globalImp("foreign", "unexpected", false)] }],
  [
    "foreign memory namespace",
    { memory: name("foreign").concat(name("memory"), [2, 3, 1], leb(65536)) },
  ],
  [
    "foreign table namespace",
    { table: name("foreign").concat(name("__indirect_function_table"), [1, 0x70, 0, 1]) },
  ],
  ["wrong memory name", { memory: imp("other_memory", [2, 3, 1].concat(leb(65536))) }],
  ["wrong table name", { table: imp("other_table", [1, 0x70, 0, 1]) }],
  ["missing memory", { memory: null }],
  ["missing table", { table: null }],
] satisfies readonly [string, CoreResourceImports][]) {
  test(`PIE core closed shape rejects ${label}`, async () => {
    const source = pieCore(true, false, resources);
    expect(WebAssembly.validate(source)).toBe(true);
    await expect(
      prepareLinkPlan({
        core: {
          id: "core",
          source,
          cooperative: true,
          checkpoint: { module: "env", name: "check" },
          initialize: [],
        },
        libraries: [],
        reserve: "bun_core_alloc",
      }),
    ).rejects.toThrow();
  });
}

function memberReply(worker: Worker): Promise<unknown> {
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }: MessageEvent<unknown>) => resolve(data);
    worker.onerror = reject;
  });
}

function stackObservation(input: unknown) {
  if (!input || typeof input !== "object") throw new Error("missing stack observation");
  if (!("low" in input) || typeof input.low !== "number") throw new Error("missing low");
  if (!("high" in input) || typeof input.high !== "number") throw new Error("missing high");
  if (!("pointer" in input) || typeof input.pointer !== "number")
    throw new Error("missing pointer");
  if (!("mark" in input) || typeof input.mark !== "number") throw new Error("missing mark");
  return { low: input.low, high: input.high, pointer: input.pointer, mark: input.mark };
}

function stackMember(
  groups: MemoryGroups,
  pid: number,
  join: Parameters<MemoryGroups["admit"]>[2],
) {
  const lease = groups.admit(pid, "stack-binding-control", join);
  const worker = new Worker(new URL("./memory-group-stack-worker.ts", import.meta.url).href);
  return { lease, worker };
}

async function stopStackMember(member: { lease: MemberLease; worker: Worker }) {
  try {
    member.worker.postMessage({ kind: "close" });
  } finally {
    await member.worker.terminate();
    member.lease.stopped();
  }
}

test("real members bind nonoverlapping stack bounds and the matching stack pointer", async () => {
  const prepared = await prepareLinkPlan({
    core: {
      id: "core",
      source: pieCore(true),
      cooperative: true,
      checkpoint: { module: "env", name: "check" },
      initialize: [],
    },
    libraries: [],
    reserve: "bun_core_alloc",
  });
  const groups = new MemoryGroups({
    stackBytes: PAGE_BYTES + 16,
    maximumPages: 32,
    budgetBytes: 32 * PAGE_BYTES,
  });
  const first = stackMember(groups, 101, "new");
  const second = stackMember(groups, 102, first.lease.group);
  const launch = async (member: typeof first, mark: number) => {
    const response = memberReply(member.worker);
    const started = member.lease.launch();
    member.worker.postMessage(
      {
        kind: "launch",
        request: started.request,
        source: prepared.toSource(),
        mark,
      },
      started.transfer,
    );
    return stackObservation(await response);
  };
  try {
    const a = await launch(first, 111);
    const b = await launch(second, 222);
    expect(a.high - a.low).toBe(2 * PAGE_BYTES);
    expect(b.high - b.low).toBe(2 * PAGE_BYTES);
    expect(a.pointer).toBe(a.high);
    expect(b.pointer).toBe(b.high);
    expect(a.high <= b.low || b.high <= a.low).toBe(true);
    expect(a.mark).toBe(111);
    expect(b.mark).toBe(222);
    const reread = memberReply(first.worker);
    first.worker.postMessage({ kind: "read" });
    expect(stackObservation(await reread)).toEqual(a);
  } finally {
    await Promise.all([stopStackMember(first), stopStackMember(second)]);
    expect(groups.snapshot()).toEqual([]);
    expect(groups.budget.committed).toBe(0);
  }
});
