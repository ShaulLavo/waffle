import { expect, test } from "bun:test";
import { Wasi } from "../core/wasi.js";
import { MemFS } from "../fs/memory.js";
import { instantiateLinkPlan, prepareLinkPlan } from "../link/index.js";

import { source, coreSource, sideSource } from "./fixtures/link-initialization.js";

function host(trace: number[], memory: WebAssembly.Memory, table: WebAssembly.Table) {
  const wasi = new Wasi({
    args: [],
    env: {},
    fs: new MemFS(),
    preopens: {},
    stdout() {},
    stderr() {},
    sleep() {},
    namespaces: {
      env: {
        check() {},
        trace(value: number) {
          trace.push(value);
        },
      },
    },
  });
  const stack = new WebAssembly.Global({ value: "i32", mutable: true }, 65536);
  return {
    wasi,
    coreImports: {
      env: {
        check() {},
        trace(value: number) {
          trace.push(value);
        },
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
  const group = instantiateLinkPlan(
    await prepareLinkPlan(source()),
    host(trace, resources.memory, resources.table),
  );
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
  const first = instantiateLinkPlan(plan, {
    ...host([], resources.memory, resources.table),
    coreImports: imports,
  });
  try {
    expect(() =>
      instantiateLinkPlan(plan, {
        ...host([], resources.memory, resources.table),
        coreImports: imports,
      }),
    ).toThrow("member bindings were already instantiated");
  } finally {
    first.dispose();
  }
});

function globalValue(instance: WebAssembly.Instance, name: string): number {
  const value = instance.exports[name];
  if (!(value instanceof WebAssembly.Global) || typeof value.value !== "number")
    throw new Error(`missing i32 global ${name}`);
  return value.value;
}

test("passive core declares generic relocation after memory initialization by identity", async () => {
  const input = source();
  const passive = {
    ...input.core,
    source: coreSource(true, true),
    initializeMemory: ["core_initialize_memory", "reloc_alias"],
  };
  const plan = await prepareLinkPlan({ ...input, core: passive });
  const resources = freshResources();
  const group = instantiateLinkPlan(plan, host([], resources.memory, resources.table));
  try {
    expect(globalValue(group.entry, "relocations")).toBe(1);
    group.initialize();
    group.initialize();
    expect(globalValue(group.entry, "relocations")).toBe(1);
  } finally {
    group.dispose();
  }
  for (const initializeMemory of [
    ["core_initialize_memory"],
    ["reloc_alias", "core_initialize_memory"],
    ["", "core_initialize_memory"],
    ["core_initialize_memory", "reloc_alias", "__wasm_apply_data_relocs"],
  ])
    await expect(
      prepareLinkPlan({ ...input, core: { ...passive, initializeMemory } }),
    ).rejects.toThrow();
});

for (const declared of [false, true]) {
  test(`active side relocation runs once ${declared ? "when declared" : "automatically"}`, async () => {
    const input = source();
    const side = input.libraries[0]!;
    const plan = await prepareLinkPlan({
      ...input,
      libraries: [
        {
          ...side,
          source: sideSource(true),
          initializeMemory: declared
            ? ["__wasm_apply_data_relocs", "side_initialize_memory"]
            : side.initializeMemory,
        },
      ],
    });
    const trace: number[] = [];
    const resources = freshResources();
    const group = instantiateLinkPlan(plan, host(trace, resources.memory, resources.table));
    try {
      expect(trace).toEqual([1]);
      group.initialize();
      expect(trace).toEqual([1, 2, 3, 6, 4, 5]);
      expect(globalValue(group.libraries[0]!.instance, "relocations")).toBe(1);
      group.initialize();
      expect(trace).toEqual([1, 2, 3, 6, 4, 5]);
    } finally {
      group.dispose();
    }
  });
}

test("both ordered lists survive clone readmission and missing lists fail closed", async () => {
  const input = source();
  const plan = await prepareLinkPlan(input);
  const copy = structuredClone(plan.toSource());
  expect(copy.core.initializeMemory).toEqual(input.core.initializeMemory);
  expect(copy.core.initialize).toEqual(input.core.initialize);
  expect(copy.libraries[0]!.initializeMemory).toEqual(input.libraries[0]!.initializeMemory);
  const restored = await prepareLinkPlan(copy);
  expect(restored.toSource()).toEqual(copy);
  for (const field of ["initializeMemory", "initialize"] as const) {
    const missing = structuredClone(copy);
    Reflect.deleteProperty(missing.core, field);
    await expect(prepareLinkPlan(missing)).rejects.toThrow(`${field} must list export names`);
  }
});

for (const field of ["initializeMemory", "initialize"] as const) {
  test(`${field} rejects non-arrays, non-string names and sparse lists`, async () => {
    for (const value of ["core_initialize_memory", [0], Array(1)]) {
      const input = source();
      Reflect.set(input.core, field, value);
      await expect(prepareLinkPlan(input)).rejects.toThrow(`${field} must list export names`);
    }
  });
}

test("cancellation at every check stops the trace and poisons initialization", async () => {
  const plan = await prepareLinkPlan(source());
  const snapshots: number[][] = [];
  const trace: number[] = [];
  const resources = freshResources();
  const h = host(trace, resources.memory, resources.table);
  const group = instantiateLinkPlan(plan, {
    ...h,
    checkActive() {
      snapshots.push(trace.slice());
    },
  });
  group.initialize();
  group.dispose();
  for (let stop = 0; stop < snapshots.length; stop++) {
    const observed: number[] = [];
    const resources = freshResources();
    const h = host(observed, resources.memory, resources.table);
    let calls = 0;
    let linked: ReturnType<typeof instantiateLinkPlan> | undefined;
    const execute = () => {
      linked = instantiateLinkPlan(plan, {
        ...h,
        checkActive() {
          if (calls++ === stop) throw new Error("cancelled");
        },
      });
      linked.initialize();
    };
    expect(execute).toThrow("cancelled");
    expect(observed).toEqual(snapshots[stop]!);
    const poisoned = linked;
    if (poisoned) expect(() => poisoned.initialize()).toThrow("poisoned");
    linked?.dispose();
    for (let slot = 1; slot < resources.table.length; slot++)
      expect(resources.table.get(slot)).toBeNull();
    h.wasi.descriptors.dispose();
  }
});

for (const stage of [2, 3, 4, 5]) {
  test(`reentrant dispose from stage ${stage} stops later work and clears slots`, async () => {
    const resources = freshResources();
    const trace: number[] = [];
    const h = host(trace, resources.memory, resources.table);
    const original = h.coreImports.env.trace;
    h.coreImports.env.trace = (value: number) => {
      original(value);
      if (value === stage) group.dispose();
    };
    const group = instantiateLinkPlan(await prepareLinkPlan(source()), h);
    expect(() => group.initialize()).toThrow("disposed");
    expect(trace).toEqual([1, 2, 3, 4, 5].slice(0, stage));
    expect(group.libraries).toEqual([]);
    for (let slot = 1; slot < resources.table.length; slot++)
      expect(resources.table.get(slot)).toBeNull();
    group.dispose();
  });
}

interface MemberObservation {
  coreTls: number;
  sideTls: number;
  coreBase: number;
  sideBase: number;
  low: number;
  high: number;
  pointer: number;
  sameStack: boolean;
  coreMark: number;
  sideMark: number;
  memoryCoreMark: number;
  memorySideMark: number;
}
function memberReply(worker: Worker): Promise<MemberObservation> {
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => (data.error ? reject(new Error(data.error)) : resolve(data));
    worker.onerror = reject;
  });
}

test("two real members initialize their own core and side TLS and retain carved stacks", async () => {
  const { MemoryGroups } = await import("../group/state.js");
  const groups = new MemoryGroups({ stackBytes: 65536, maximumPages: 32, budgetBytes: 32 * 65536 });
  const first = groups.admit(101, "ordered-memory-stages", "new");
  const second = groups.admit(102, "ordered-memory-stages", first.group);
  const entries = [first, second].map((lease) => ({
    lease,
    worker: new Worker(new URL("./fixtures/link-initialization-worker.ts", import.meta.url).href),
  }));
  try {
    const observed: MemberObservation[] = [];
    for (const [index, entry] of entries.entries()) {
      const response = memberReply(entry.worker);
      const launch = entry.lease.launch();
      entry.worker.postMessage(
        { kind: "launch", request: launch.request, mark: 111 + index * 111 },
        launch.transfer,
      );
      observed.push(await response);
    }
    for (const value of observed) {
      expect(value.coreTls).toBe(value.coreBase);
      expect(value.sideTls).toBe(value.sideBase);
      expect(value.memoryCoreMark).toBe(42);
      expect(value.memorySideMark).toBe(22);
      expect(value.sameStack).toBe(true);
      expect(value.high - value.low).toBe(65536);
      expect(value.pointer).toBe(value.high);
    }
    expect(observed[0]!.coreTls).not.toBe(observed[1]!.coreTls);
    expect(observed[0]!.sideTls).not.toBe(observed[1]!.sideTls);
    const response = memberReply(entries[0]!.worker);
    entries[0]!.worker.postMessage({ kind: "read" });
    expect(await response).toEqual(observed[0]!);
    expect(observed.map((value) => value.coreMark)).toEqual([111, 222]);
    expect(observed.map((value) => value.sideMark)).toEqual([112, 223]);
  } finally {
    for (const entry of entries) entry.worker.postMessage({ kind: "close" });
    for (const entry of entries) {
      await entry.worker.terminate();
      entry.lease.stopped();
    }
    expect(groups.snapshot()).toEqual([]);
    expect(groups.budget.committed).toBe(0);
  }
});
