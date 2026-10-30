import { expect, test } from "bun:test";
import { Wasi } from "../core/wasi.js";
import { MemFS } from "../fs/memory.js";
import { instantiateLinkPlan, prepareLinkPlan, type LinkPlanSource } from "../link/index.js";

const u32 = (n: number): number[] =>
  n < 128 ? [n] : [(n % 128) + 128].concat(u32(Math.floor(n / 128)));
const text = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  return u32(bytes.length).concat(Array.from(bytes));
};
const vector = (items: readonly number[][]) => u32(items.length).concat(items.flat());
const section = (id: number, bytes: number[]) => [id].concat(u32(bytes.length), bytes);
const binary = (...sections: number[][]) =>
  new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0].concat(sections.flat()));
const type = (params: number[], results: number[] = []) =>
  [0x60].concat(vector(params.map((value) => [value])), vector(results.map((value) => [value])));
const imp = (module: string, name: string, descriptor: number[]) =>
  text(module).concat(text(name), descriptor);
const exp = (name: string, kind: number, index: number) => text(name).concat([kind], u32(index));
const body = (ops: number[]) => u32(ops.length + 2).concat([0], ops, [0x0b]);

function coreSource(writeSentinel: boolean): Uint8Array<ArrayBuffer> {
  const memoryStage = writeSentinel
    ? [0x41, 0, 0x41, 42, 0x36, 2, 0, 0x41, 1, 0x10, 1]
    : [0x41, 1, 0x10, 1];
  return binary(
    section(0, text("dylink.0").concat([1, 4, 16, 2, 0, 0])),
    section(1, vector([type([]), type([0x7f]), type([0x7f, 0x7f], [0x7f]), type([], [0x7f])])),
    section(
      2,
      vector([
        imp("env", "check", [0, 0]),
        imp("env", "trace", [0, 1]),
        imp("env", "memory", [2, 3, 1, 1]),
        imp("env", "__indirect_function_table", [1, 0x70, 0, 1]),
        imp("env", "__stack_pointer", [3, 0x7f, 1]),
        imp("env", "__memory_base", [3, 0x7f, 0]),
        imp("env", "__table_base", [3, 0x7f, 0]),
      ]),
    ),
    section(3, vector([[0], [0], [2], [0], [3]])),
    section(
      7,
      vector([
        exp("check", 0, 0),
        exp("trace", 0, 1),
        exp("core_initialize_memory", 0, 2),
        exp("__wasm_call_ctors", 0, 3),
        exp("bun_core_alloc", 0, 4),
        exp("_start", 0, 5),
        exp("read", 0, 6),
      ]),
    ),
    section(
      10,
      vector([
        body(memoryStage),
        body([0x41, 2, 0x10, 1]),
        body([0x41, 3, 0x10, 1, 0x41].concat(u32(1024))),
        body([0x41, 9, 0x10, 1]),
        body([0x41, 0, 0x28, 2, 0]),
      ]),
    ),
  );
}

function sideSource(): Uint8Array<ArrayBuffer> {
  return binary(
    section(0, text("dylink.0").concat([1, 4, 16, 4, 1, 0])),
    section(1, vector([type([]), type([0x7f])])),
    section(
      2,
      vector([
        imp("env", "check", [0, 0]),
        imp("env", "trace", [0, 1]),
        imp("env", "memory", [2, 3, 1, 1]),
        imp("env", "__indirect_function_table", [1, 0x70, 0, 1]),
        imp("env", "__memory_base", [3, 0x7f, 0]),
        imp("env", "__table_base", [3, 0x7f, 0]),
        imp("env", "__stack_pointer", [3, 0x7f, 1]),
      ]),
    ),
    section(3, vector([[0], [0]])),
    section(
      7,
      vector([exp("side_initialize_memory", 0, 2), exp("side_initialize", 0, 3)]),
    ),
    section(10, vector([body([0x41, 4, 0x10, 1]), body([0x41, 5, 0x10, 1])])),
  );
}

function source(writeSentinel = false): LinkPlanSource {
  return {
    core: {
      id: "core",
      source: coreSource(writeSentinel),
      cooperative: true,
      checkpoint: { module: "env", name: "check" },
      initializeMemory: ["core_initialize_memory"],
      initialize: ["__wasm_call_ctors"],
    },
    libraries: [
      {
        id: "side",
        source: sideSource(),
        cooperative: true,
        checkpoint: { module: "env", name: "check" },
        initializeMemory: ["side_initialize_memory"],
        initialize: ["side_initialize"],
      },
    ],
    reserve: "bun_core_alloc",
  };
}

function host(trace: number[], memory: WebAssembly.Memory, table: WebAssembly.Table) {
  const wasi = new Wasi({
    args: [],
    env: {},
    fs: new MemFS(),
    preopens: {},
    stdout() {},
    stderr() {},
    sleep() {},
    namespaces: { env: { check() {}, trace(value: number) { trace.push(value); } } },
  });
  const stack = new WebAssembly.Global({ value: "i32", mutable: true }, 65536);
  return {
    wasi,
    coreImports: {
      env: {
        check() {},
        trace(value: number) { trace.push(value); },
        memory,
        __indirect_function_table: table,
        __stack_pointer: stack,
        __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, 0),
        __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, 0),
      },
    },
    checkActive() {},
  };
}

function freshResources(): { memory: WebAssembly.Memory; table: WebAssembly.Table } {
  return {
    memory: new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }),
    table: new WebAssembly.Table({ element: "anyfunc", initial: 1 }),
  };
}

test("initialization order keeps core memory before escape and side linking after constructors", async () => {
  const trace: number[] = [];
  const resources = freshResources();
  const group = instantiateLinkPlan(await prepareLinkPlan(source()), host(trace, resources.memory, resources.table));
  try {
    expect(trace).toEqual([1]);
    expect(group.libraries).toEqual([]);
    group.initialize();
    expect(trace).toEqual([1, 2, 3, 4, 5]);
    expect(group.libraries).toHaveLength(1);
    expect(trace).not.toContain(9);
  } finally {
    group.dispose();
  }
});

test("core memory stages make initialized data visible before initialize", async () => {
  const resources = freshResources();
  const group = instantiateLinkPlan(
    await prepareLinkPlan(source(true)),
    host([], resources.memory, resources.table),
  );
  try {
    expect((group.entry.exports.read as () => number)()).toBe(42);
    expect(group.libraries).toEqual([]);
  } finally {
    group.dispose();
  }
});

test("a carved core binding is single-use", async () => {
  const resources = freshResources();
  const plan = await prepareLinkPlan({ ...source(), libraries: [] });
  const imports = host([], resources.memory, resources.table).coreImports;
  const first = instantiateLinkPlan(plan, { ...host([], resources.memory, resources.table), coreImports: imports });
  try {
    expect(() =>
      instantiateLinkPlan(plan, { ...host([], resources.memory, resources.table), coreImports: imports }),
    ).toThrow("member bindings were already instantiated");
  } finally {
    first.dispose();
  }
});
