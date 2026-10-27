import { expect, test } from "bun:test";
import { Wasi } from "../core/wasi.js";
import { MemFS } from "../fs/memory.js";
import {
  instantiateLinkPlan,
  linkedWorkerHooks,
  prepareLinkPlan,
  type LinkPlanSource,
} from "../link/index.js";
import { compileInterruptible } from "../interrupt/loader.js";
import { bootstrap } from "../browser/worker.js";
import { createFilesystemConnection } from "../fs/protocol.js";
import { inspectProfile } from "../link/metadata.js";

const u32 = (n: number): number[] =>
  n < 128 ? [n] : [(n % 128) + 128].concat(u32(Math.floor(n / 128)));
const text = (s: string) =>
  u32(new TextEncoder().encode(s).length).concat(Array.from(new TextEncoder().encode(s)));
const vector = (items: readonly number[][]) => u32(items.length).concat(items.flat());
const section = (id: number, bytes: number[]) => [id].concat(u32(bytes.length), bytes);
const binary = (...sections: number[][]) =>
  new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0].concat(sections.flat()));
const type = (args: number[], result: number[] = []) =>
  [0x60].concat(vector(args.map((x) => [x])), vector(result.map((x) => [x])));
const exp = (name: string, kind: number, index: number) => text(name).concat([kind], u32(index));
const imp = (ns: string, name: string, descriptor: number[]) =>
  text(ns).concat(text(name), descriptor);
const body = (ops: number[], locals: number[] = [0]) => {
  const bytes = locals.concat(ops, [0x0b]);
  return u32(bytes.length).concat(bytes);
};
const global = (mutable: boolean, value: number) =>
  [0x7f, Number(mutable), 0x41].concat(u32(value), [0x0b]);

function core(
  options: {
    pages?: number;
    reserve?: number[];
    aliases?: readonly [string, number][];
    addParameter?: 0x7f | 0x7e;
    addResult?: 0x7f | 0x7e;
    stackMutable?: boolean;
    stackBounds?: readonly [number, number];
  } = {},
): Uint8Array<ArrayBuffer> {
  const bounds = options.stackBounds ?? [0, 65536];
  return binary(
    section(
      1,
      vector([
        type([]),
        type([0x7f, 0x7f], [0x7f]),
        type([options.addParameter ?? 0x7f], [options.addResult ?? 0x7f]),
      ]),
    ),
    section(2, vector([imp("env", "check", [0, 0])])),
    section(3, vector([[1], [2], [0], [0], [2]])),
    section(4, [1, 0x70, 1, 1, 32]),
    section(5, [1, 1].concat(u32(options.pages ?? 2), u32(128))),
    section(
      6,
      vector([
        global(options.stackMutable ?? true, 65536),
        global(true, 1024),
        global(false, 32),
        global(false, 40),
        global(false, 48),
        global(true, 0),
        global(false, bounds[0]),
        global(false, bounds[1]),
      ]),
    ),
    section(
      7,
      vector(
        [
          exp("check", 0, 0),
          exp("memory", 2, 0),
          exp("__indirect_function_table", 1, 0),
          exp("__stack_pointer", 3, 0),
          exp("stdout", 3, 2),
          exp("_CLOCK_MONOTONIC", 3, 3),
          exp("errno", 3, 4),
          exp("initialized", 3, 5),
          exp("__stack_low", 3, 6),
          exp("__stack_high", 3, 7),
          exp("bun_core_alloc", 0, 1),
          exp("add", 0, 2),
          exp("_start", 0, 3),
          exp("init", 0, 4),
          exp("invoke", 0, 5),
        ].concat((options.aliases ?? []).map(([name, index]) => exp(name, 0, index))),
      ),
    ),
    section(
      10,
      vector([
        // Round core's bump up to align, advance by size, return the reserved pointer.
        body(
          options.reserve ?? [
            0x23, 1, 0x20, 1, 0x6a, 0x41, 1, 0x6b, 0x20, 1, 0x41, 1, 0x6b, 0x41, 0x7f, 0x73, 0x71,
            0x22, 2, 0x20, 0, 0x6a, 0x24, 1, 0x20, 2,
          ],
          [1, 1, 0x7f],
        ),
        body(
          [0x10, 0, 0x20, 0].concat(
            options.addParameter === 0x7e ? [0xa7] : [],
            [0x41, 7, 0x6a],
            options.addResult === 0x7e ? [0xac] : [],
          ),
        ),
        body([0x10, 0]),
        body([0x23, 5, 0x41, 1, 0x6a, 0x24, 5]),
        body([0x20, 0, 0x41, 1, 0x11, 2, 0]),
      ]),
    ),
  );
}
function side(
  got = "errno",
  namespace = "GOT.mem",
  alignment = 4,
  options: {
    relocationCheck?: boolean;
    aliases?: readonly [string, number][];
    dylink?: number[];
    addName?: string;
    addModule?: string;
    gotDescriptor?: number[];
    baseMutable?: boolean;
    globalInitializer?: number[];
    dataSegments?: number[][];
  } = {},
): Uint8Array<ArrayBuffer> {
  return binary(
    section(0, text("dylink.0").concat([1, 4, 16, alignment, 1, 0], options.dylink ?? [])),
    section(1, vector([type([]), type([0x7f], [0x7f])])),
    section(
      2,
      vector([
        imp("env", "check", [0, 0]),
        imp(options.addModule ?? "env", options.addName ?? "add", [0, 1]),
        imp("env", "memory", [2, 1, 1].concat(u32(128))),
        imp("env", "__indirect_function_table", [1, 0x70, 1, 0, 32]),
        imp("env", "__memory_base", [3, 0x7f, Number(options.baseMutable ?? false)]),
        imp("env", "__table_base", [3, 0x7f, 0]),
        imp("env", "__stack_pointer", [3, 0x7f, 1]),
        imp(namespace, got, options.gotDescriptor ?? [3, 0x7f, 1]),
      ]),
    ),
    section(3, vector([[1], [0], [0]])),
    ...(options.globalInitializer
      ? [section(6, vector([[0x7f, 0].concat(options.globalInitializer)]))]
      : []),
    section(
      7,
      vector(
        [
          exp("run", 0, 2),
          exp("init", 0, 3),
          exp("__wasm_apply_data_relocs", 0, 4),
          exp("stack", 3, 2),
          exp("got", 3, 3),
        ].concat((options.aliases ?? []).map(([name, index]) => exp(name, 0, index))),
      ),
    ),
    section(9, [1, 0, 0x23, 1, 0x0b, 1, 2]),
    section(
      10,
      vector([
        body([
          0x10, 0, 0x23, 2, 0x41, 16, 0x6b, 0x24, 2, 0x20, 0, 0x10, 1, 0x23, 2, 0x41, 16, 0x6a,
          0x24, 2,
        ]),
        body([0x10, 0, 0x23, 0, 0x41, 4, 0x6a, 0x41, 0xe3, 0, 0x36, 2, 0]),
        body(
          (options.relocationCheck ? [0x10, 0] : []).concat([
            0x23, 0, 0x41, 8, 0x6a, 0x23, 1, 0x36, 2, 0,
          ]),
        ),
      ]),
    ),
    section(11, vector(options.dataSegments ?? [[0, 0x23, 0, 0x0b, 3, 1, 2, 3]])),
  );
}
function source(): LinkPlanSource {
  const member = (id: string, bytes: Uint8Array) => ({
    id,
    source: bytes,
    cooperative: true as const,
    checkpoint: { module: "env", name: "check" },
    initialize: ["init"],
  });
  return {
    core: member("core", core()),
    libraries: [member("engine", side())],
    reserve: "bun_core_alloc",
  };
}
function host(checkActive = () => {}, namespaces: WebAssembly.Imports = {}) {
  const wasi = new Wasi({
    args: [],
    env: {},
    fs: new MemFS(),
    preopens: {},
    stdout() {},
    stderr() {},
    sleep() {},
    namespaces: { env: { check: checkActive }, ...namespaces },
  });
  return { wasi, checkActive };
}

const importRecord = (module: string, field: string, flags = 0x11) =>
  text(module).concat(text(field), u32(flags));
const importInfo = (...records: number[][]) => section(4, vector(records));

test("weak import metadata binds an exact real core provider and survives readmission", async () => {
  const input = source();
  const dylink = importInfo(importRecord("env", "add"));
  const plan = await prepareLinkPlan({
    ...input,
    libraries: [{ ...input.libraries[0]!, source: side("errno", "GOT.mem", 4, { dylink }) }],
  });
  const group = instantiateLinkPlan(plan, host());
  try {
    expect(call(group.entry, "invoke", 5)).toBe(12);
  } finally {
    group.dispose();
  }
  const restored = await prepareLinkPlan(structuredClone(plan.toSource()));
  const readmitted = instantiateLinkPlan(restored, host());
  try {
    expect(call(readmitted.entry, "invoke", 5)).toBe(12);
  } finally {
    readmitted.dispose();
  }
});

for (const options of [{ addParameter: 0x7e }, { addResult: 0x7e }] satisfies Parameters<
  typeof core
>[0][]) {
  test(`same-arity core providers with different Wasm types ${JSON.stringify(options)} fail preparation`, async () => {
    const input = source();
    await expect(
      prepareLinkPlan({ ...input, core: { ...input.core, source: core(options) } }),
    ).rejects.toThrow("env.add has an incompatible core function signature");
  });
}

for (const weak of [false, true]) {
  test(`missing ${weak ? "weak direct" : "required"} provider fails preparation`, async () => {
    const input = source();
    const dylink = weak ? importInfo(importRecord("env", "absent")) : [];
    await expect(
      prepareLinkPlan({
        ...input,
        libraries: [
          {
            ...input.libraries[0]!,
            source: side("errno", "GOT.mem", 4, { dylink, addName: "absent" }),
          },
        ],
      }),
    ).rejects.toThrow(`unresolved ${weak ? "weak direct" : "required"} function env.absent`);
  });
}

test("profile retains qualified function bindings and complete global types", () => {
  const profile = inspectProfile(
    side("errno", "GOT.mem", 4, { dylink: importInfo(importRecord("env", "add")) }),
    "engine",
    true,
  );
  expect(profile.importInfo).toEqual([{ module: "env", name: "add", flags: 0x11 }]);
  expect(profile.functionImports.find((entry) => entry.name === "add")).toEqual({
    module: "env",
    name: "add",
    index: 1,
    binding: "weak",
    params: [0x7f],
    results: [0x7f],
  });
  expect(profile.functionImports.find((entry) => entry.name === "check")?.binding).toBe("required");
  expect(profile.globalImports.find((entry) => entry.module === "GOT.mem")).toEqual({
    module: "GOT.mem",
    name: "errno",
    index: 3,
    value: 0x7f,
    mutable: true,
  });
  const owner = inspectProfile(core(), "core", false);
  expect(owner.globalExports.get("__stack_pointer")).toEqual({ value: 0x7f, mutable: true });
  expect(owner.globalExports.get("errno")).toEqual({ value: 0x7f, mutable: false });
});

for (const flags of [0, 1, 0x10, 0x12, 0x15, 0x31, 0x111, 0x80000011]) {
  test(`unsupported import-info flags ${flags} fail closed`, async () => {
    const input = source();
    await expect(
      prepareLinkPlan({
        ...input,
        libraries: [
          {
            ...input.libraries[0]!,
            source: side("errno", "GOT.mem", 4, {
              dylink: importInfo(importRecord("env", "add", flags)),
            }),
          },
        ],
      }),
    ).rejects.toThrow("unsupported import-info flags");
  });
}

for (const record of [
  importRecord("env", "absent"),
  importRecord("env", "__stack_pointer"),
  importRecord("GOT.mem", "errno"),
  importRecord("foreign", "add"),
  importRecord("env.part", "add"),
]) {
  test(`unmatched or wrong-kind/module import-info ${record.join()} fails closed`, () => {
    expect(() =>
      inspectProfile(side("errno", "GOT.mem", 4, { dylink: importInfo(record) }), "engine", true),
    ).toThrow("must name an imported env function");
  });
}

for (const flags of [0x11, 0x10]) {
  test(`duplicate/conflicting qualified import-info ${flags} fails closed`, () => {
    const dylink = importInfo(importRecord("env", "add")).concat(
      importInfo(importRecord("env", "add", flags)),
    );
    expect(() => inspectProfile(side("errno", "GOT.mem", 4, { dylink }), "engine", true)).toThrow(
      "duplicate or conflicting import-info env.add",
    );
  });
}

const malformedInfo = [
  { bytes: [1], error: "truncated binary" },
  { bytes: [1, 3, 0x65], error: "truncated section" },
  { bytes: [1].concat(text("env"), [1, 0xff, 0x11]), error: "invalid UTF-8" },
  { bytes: [1, 2, 0xef, 0xbb].concat(text("add"), [0x11]), error: "invalid UTF-8" },
  { bytes: [1].concat(text("env"), text("add"), [0x80]), error: "truncated binary" },
  {
    bytes: [1].concat(text("env"), text("add"), [0x80, 0x80, 0x80, 0x80, 0x10]),
    error: "u32 overflow",
  },
  { bytes: vector([importRecord("env", "add")]).concat([0]), error: "unexpected trailing bytes" },
  { bytes: [2].concat(importRecord("env", "add")), error: "truncated binary" },
];
for (const [index, fixture] of malformedInfo.entries()) {
  test(`malformed import-info record ${index} fails within its payload`, () => {
    expect(() =>
      inspectProfile(
        side("errno", "GOT.mem", 4, { dylink: section(4, fixture.bytes) }),
        "engine",
        true,
      ),
    ).toThrow(fixture.error);
  });
}

test("wrong-kind function provider and immutable core stack fail preparation", async () => {
  const input = source();
  await expect(
    prepareLinkPlan({
      ...input,
      libraries: [
        { ...input.libraries[0]!, source: side("errno", "GOT.mem", 4, { addName: "stdout" }) },
      ],
    }),
  ).rejects.toThrow("core export env.stdout must be a function");
  await expect(
    prepareLinkPlan({ ...input, core: { ...input.core, source: core({ stackMutable: false }) } }),
  ).rejects.toThrow("env.__stack_pointer requires");
});

test("GOT type and base/segment restrictions remain explicit", () => {
  expect(() =>
    inspectProfile(side("errno", "GOT.mem", 4, { gotDescriptor: [3, 0x7e, 1] }), "engine", true),
  ).toThrow("only i32 global imports");
  expect(() =>
    inspectProfile(side("errno", "GOT.mem", 4, { gotDescriptor: [3, 0x7f, 0] }), "engine", true),
  ).toThrow("GOT.mem requires mutable i32");
  expect(() =>
    inspectProfile(side("errno", "GOT.mem", 4, { baseMutable: true }), "engine", true),
  ).toThrow("side bases must be immutable i32");
  const profile = (options: Parameters<typeof side>[3]) =>
    inspectProfile(side("errno", "GOT.mem", 4, options), "engine", true);
  // Extended-const base plus offset, the form wasm-ld emits for PIC data and table addresses.
  expect(() => profile({ globalInitializer: [0x23, 0, 0x41, 1, 0x6a, 0x0b] })).not.toThrow();
  expect(() => profile({ globalInitializer: [0x23, 1, 0x41, 1, 0x6a, 0x0b] })).not.toThrow();
  expect(() => profile({ globalInitializer: [0x23, 2, 0x41, 1, 0x6a, 0x0b] })).toThrow(
    "imported-base relative initializers",
  );
  expect(() => profile({ globalInitializer: [0x23, 0, 0x41, 1, 0x6b, 0x0b] })).toThrow(
    "imported-base relative initializers",
  );
  const segments = (...dataSegments: number[][]) => profile({ dataSegments });
  expect(() =>
    segments([0, 0x23, 0, 0x0b, 1, 1], [0, 0x23, 0, 0x41, 8, 0x6a, 0x0b, 1, 2]),
  ).not.toThrow();
  expect(() =>
    segments([0, 0x23, 0, 0x0b, 4, 1, 2, 3, 4], [0, 0x23, 0, 0x41, 2, 0x6a, 0x0b, 1, 2]),
  ).toThrow("overlapping active side segments");
  expect(() => segments([0, 0x23, 0, 0x41, 15, 0x6a, 0x0b, 2, 1, 2])).toThrow(
    "active segment exceeds dylink.0 reservation",
  );
  expect(() => segments([0, 0x23, 0, 0x41, 0x7f, 0x6a, 0x0b, 1, 1])).toThrow(
    "active segment exceeds dylink.0 reservation",
  );
  expect(() => segments([0, 0x23, 2, 0x0b, 1, 1])).toThrow("imported base global");
});
function call(instance: WebAssembly.Instance, name: string, ...args: number[]): number {
  const fn = instance.exports[name];
  if (typeof fn !== "function") throw new Error(`missing ${name}`);
  return fn(...args);
}

test("actual core and PIC share memory, table, stack and data GOT; init is explicit", async () => {
  const plan = await prepareLinkPlan(source());
  const h = host();
  const group = instantiateLinkPlan(plan, h);
  try {
    const lib = group.libraries[0]!;
    expect(lib.memoryBase).toBe(1024);
    expect(lib.tableBase).toBe(1);
    expect(lib.instance.exports.stack).toBe(group.entry.exports.__stack_pointer);
    expect(new Uint8Array(group.memory.buffer, lib.memoryBase, 4)).toEqual(
      new Uint8Array([1, 2, 3, 0]),
    );
    expect(new DataView(group.memory.buffer).getUint32(lib.memoryBase + 8, true)).toBe(1);
    expect(group.entry.exports.initialized).toBeInstanceOf(WebAssembly.Global);
    expect(call(group.entry, "invoke", 5)).toBe(12);
    group.initialize();
    group.initialize();
    expect((group.entry.exports.initialized as WebAssembly.Global).value).toBe(1);
    expect(new DataView(group.memory.buffer).getUint32(lib.memoryBase + 4, true)).toBe(99);
    expect((lib.instance.exports.got as WebAssembly.Global).value).toBe(48);
    expect((lib.instance.exports.stack as WebAssembly.Global).value).toBe(65536);
  } finally {
    group.dispose();
  }
  expect(group.table.get(1)).toBeNull();
});

test("same compiled code has fresh process instances, all source/config bytes are snapshotted", async () => {
  const input = source();
  const pending = prepareLinkPlan(input);
  input.core.source.fill(0);
  input.libraries[0]!.source.fill(0);
  const plan = await pending;
  const first = instantiateLinkPlan(plan, host()),
    second = instantiateLinkPlan(plan, host());
  try {
    expect(first.memory).not.toBe(second.memory);
    expect(first.table).not.toBe(second.table);
    expect(first.entry.exports.__stack_pointer).not.toBe(second.entry.exports.__stack_pointer);
    first.initialize();
    expect((second.entry.exports.initialized as WebAssembly.Global).value).toBe(0);
  } finally {
    first.dispose();
    second.dispose();
  }
});

test("side ranges are nonzero/nonoverlapping and GOT cells are shared across libraries", async () => {
  const input = source();
  const plan = await prepareLinkPlan({
    ...input,
    libraries: input.libraries.concat([{ ...input.libraries[0]!, id: "second" }]),
  });
  const group = instantiateLinkPlan(plan, host());
  try {
    const [a, b] = group.libraries;
    expect(b!.memoryBase).toBeGreaterThanOrEqual(a!.memoryBase + a!.memorySize);
    expect(b!.tableBase).toBeGreaterThanOrEqual(a!.tableBase + a!.tableSize);
    expect(a!.instance.exports.got).toBe(b!.instance.exports.got);
  } finally {
    group.dispose();
  }
});

test("cooperative trust, checkpoint import and narrow GOT admission fail closed", async () => {
  const input = source();
  await expect(
    prepareLinkPlan({ ...input, core: { ...input.core, cooperative: false as true } }),
  ).rejects.toThrow("cooperative");
  await expect(
    prepareLinkPlan({
      ...input,
      core: { ...input.core, checkpoint: { module: "env", name: "absent" } },
    }),
  ).rejects.toThrow("checkpoint");
  await expect(
    prepareLinkPlan({ ...input, libraries: [{ ...input.libraries[0]!, source: side("other") }] }),
  ).rejects.toThrow("GOT.mem.other requires a core immutable i32 global export");
  await expect(compileInterruptible(side())).rejects.toThrow();
});

test("cancelled initialization poisons group and never calls later initializer", async () => {
  let active = true;
  const h = host(() => {
    if (!active) throw new Error("cancelled");
  });
  const group = instantiateLinkPlan(await prepareLinkPlan(source()), h);
  active = false;
  expect(() => group.initialize()).toThrow("cancelled");
  expect(() => group.initialize()).toThrow("poisoned");
  expect((group.entry.exports.initialized as WebAssembly.Global).value).toBe(0);
  group.dispose();
});

test("structured-cloned exact source is re-admitted, not a cloned opaque prepared object", async () => {
  const plan = await prepareLinkPlan(structuredClone(source()));
  const group = instantiateLinkPlan(plan, host());
  try {
    group.initialize();
    expect(call(group.entry, "invoke", 3)).toBe(10);
  } finally {
    group.dispose();
  }
  expect(() => instantiateLinkPlan(structuredClone(plan), host())).toThrow("local prepared plan");
});

test("normal worker structured-clones exact source, re-admits it, links and executes", async () => {
  const { Worker } = await import("node:worker_threads");
  const plan = await prepareLinkPlan(source());
  const url = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  const script = `const {parentPort,workerData}=require('node:worker_threads');
(async()=>{
 const {bootstrap}=await import(${url("../browser/worker.ts")});
 const {linkedWorkerHooks}=await import(${url("../link/index.ts")});
 const {createFilesystemConnection}=await import(${url("../fs/protocol.ts")});
 const connection=createFilesystemConnection(), hooks=linkedWorkerHooks();
 let initialized=false;
 try {
 await bootstrap({...workerData,filesystem:connection.client,args:[],env:{}},{...hooks,
 setup({fs}){fs.preopen=()=>1;fs.retain=()=>{};fs.release=()=>{}},
 namespaces(){return {env:{check(){}}}},
 instantiated({instance}){if(instance.exports.initialized.value!==0)throw Error('eager initializer')},
 initialize(context){hooks.initialize(context);initialized=true},
 run({instance}){if(!initialized)throw Error('missing initializer');return instance.exports.invoke(5)}
 },{crossOriginIsolated:true,postMessage:message=>parentPort.postMessage(message)});
 } finally{connection.client.port.close();connection.server.port.close();parentPort.close()}
})().catch(error=>{parentPort.postMessage({error:String(error)});parentPort.close()});`;
  const worker = new Worker(script, {
    eval: true,
    workerData: { module: plan.entryModule, linkPlan: plan.toSource() },
  });
  const messages: unknown[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      worker.on("message", (message) => messages.push(message));
      worker.once("error", reject);
      worker.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`worker exit ${code}`)),
      );
    });
    expect(messages).toContainEqual({
      type: "exit",
      code: 12,
      signal: undefined,
      sleep: "atomics",
    });
    expect(
      messages.some(
        (message) => typeof message === "object" && message !== null && "error" in message,
      ),
    ).toBe(false);
  } finally {
    await worker.terminate();
  }
});

test("transport snapshots cannot mutate admitted configuration or bytes", async () => {
  const plan = await prepareLinkPlan(source());
  const transfer = plan.toSource();
  transfer.core.source.fill(0);
  const group = instantiateLinkPlan(plan, host());
  try {
    group.initialize();
    expect(call(group.entry, "invoke", 1)).toBe(8);
  } finally {
    group.dispose();
  }
  const restored = await prepareLinkPlan(structuredClone(plan.toSource()));
  expect(restored.entryModule).toBe(plan.entryModule);
});

for (const symbol of ["stdout", "_CLOCK_MONOTONIC", "errno"]) {
  test(`observed data GOT ${symbol} resolves to core's actual data address`, async () => {
    const input = source();
    const plan = await prepareLinkPlan({
      ...input,
      libraries: [{ ...input.libraries[0]!, source: side(symbol) }],
    });
    const group = instantiateLinkPlan(plan, host());
    try {
      const coreSymbol = group.entry.exports[symbol];
      const imported = group.libraries[0]!.instance.exports.got;
      expect(coreSymbol).toBeInstanceOf(WebAssembly.Global);
      expect(imported).toBeInstanceOf(WebAssembly.Global);
      expect((imported as WebAssembly.Global).value).toBe((coreSymbol as WebAssembly.Global).value);
    } finally {
      group.dispose();
    }
  });
}

test("core reserves a real nonzero four-MiB aligned static range", async () => {
  const input = source();
  const plan = await prepareLinkPlan({
    ...input,
    core: { ...input.core, source: core({ pages: 128 }) },
    libraries: [{ ...input.libraries[0]!, source: side("errno", "GOT.mem", 22) }],
  });
  const group = instantiateLinkPlan(plan, host());
  try {
    expect(group.libraries[0]!.memoryBase).toBe(4 * 1024 * 1024);
    group.initialize();
  } finally {
    group.dispose();
  }
});

for (const [pointer, message] of [
  [0, "reservation failed"],
  [1025, "unaligned"],
  [1048576, "out of bounds"],
] as const) {
  test(`invalid core reservation ${pointer} fails before side initialization`, async () => {
    const input = source();
    const plan = await prepareLinkPlan({
      ...input,
      core: { ...input.core, source: core({ reserve: [0x41].concat(u32(pointer)) }) },
    });
    expect(() => instantiateLinkPlan(plan, host())).toThrow(message);
  });
}

test("overlapping core reservations reject the second library and clear table slots", async () => {
  const input = source();
  const plan = await prepareLinkPlan({
    ...input,
    core: { ...input.core, source: core({ reserve: [0x41].concat(u32(1024)) }) },
    libraries: input.libraries.concat([{ ...input.libraries[0]!, id: "second" }]),
  });
  expect(() => instantiateLinkPlan(plan, host())).toThrow("overlaps engine");
});

test("GOT.func without a function provider and true Wasm start fail before any instance", async () => {
  const input = source();
  await expect(
    prepareLinkPlan({
      ...input,
      libraries: [{ ...input.libraries[0]!, source: side("errno", "GOT.func") }],
    }),
  ).rejects.toThrow("GOT.func.errno requires a core or same-side function export");
  await expect(
    prepareLinkPlan({
      ...input,
      libraries: [{ ...input.libraries[0]!, source: side("errno", "GOT.other") }],
    }),
  ).rejects.toThrow("unsupported GOT.other.errno");
  await expect(
    prepareLinkPlan({
      ...input,
      core: {
        ...input.core,
        source: new Uint8Array(Array.from(input.core.source).concat(section(8, [3]))),
      },
    }),
  ).rejects.toThrow("true Wasm start");
});

for (const member of ["core", "engine"]) {
  test(`duplicate ${member} initializers reject during preparation and readmission`, async () => {
    const input = source();
    const plan = await prepareLinkPlan(input);
    const transfer = plan.toSource();
    const target = member === "core" ? transfer.core : transfer.libraries[0]!;
    const repeated = { ...target, initialize: ["init", "init"] };
    const changed =
      member === "core" ? { ...transfer, core: repeated } : { ...transfer, libraries: [repeated] };
    await expect(prepareLinkPlan(changed)).rejects.toThrow("duplicate initializer");
    await expect(prepareLinkPlan(structuredClone(changed))).rejects.toThrow(
      "duplicate initializer",
    );
  });
}

for (const name of ["_start", "entry_alias"]) {
  test(`command entry ${name} cannot be scheduled as an initializer`, async () => {
    const input = source();
    await expect(
      prepareLinkPlan({
        ...input,
        core: {
          ...input.core,
          source: core({ aliases: [["entry_alias", 3]] }),
          initialize: [name],
        },
      }),
    ).rejects.toThrow("command entry");
  });
}

for (const name of ["__wasm_apply_data_relocs", "reloc_alias"]) {
  test(`automatic relocation ${name} cannot be manually scheduled`, async () => {
    const input = source();
    await expect(
      prepareLinkPlan({
        ...input,
        libraries: [
          {
            ...input.libraries[0]!,
            source: side("errno", "GOT.mem", 4, { aliases: [["reloc_alias", 4]] }),
            initialize: [name],
          },
        ],
      }),
    ).rejects.toThrow("automatic relocation");
  });
}

test("constructor aliases cannot schedule the same function twice", async () => {
  const input = source();
  await expect(
    prepareLinkPlan({
      ...input,
      core: {
        ...input.core,
        source: core({ aliases: [["init_alias", 4]] }),
        initialize: ["init", "init_alias"],
      },
    }),
  ).rejects.toThrow("duplicate initializer");
});

test("finish reentered by the final relocation clears linked table slots", async () => {
  const input = source();
  const plan = await prepareLinkPlan({
    ...input,
    libraries: [
      { ...input.libraries[0]!, source: side("errno", "GOT.mem", 4, { relocationCheck: true }) },
    ],
  });
  const connection = createFilesystemConnection();
  const hooks = linkedWorkerHooks();
  const messages: unknown[] = [];
  let table: WebAssembly.Table | undefined;
  try {
    await bootstrap(
      {
        module: plan.entryModule,
        linkPlan: plan.toSource(),
        args: [],
        env: {},
        filesystem: connection.client,
      },
      {
        ...hooks,
        setup({ fs }) {
          fs.preopen = () => 1;
          fs.retain = () => {};
          fs.release = () => {};
        },
        namespaces(context) {
          return {
            env: {
              check() {
                context.finish({ code: 23 });
              },
            },
          };
        },
        instantiate(imports, context) {
          const original = context.wasi.imports.bind(context.wasi);
          context.wasi.imports = (module, bindings) => {
            const resolved = original(module, bindings);
            const candidate = resolved.env?.__indirect_function_table;
            if (candidate instanceof WebAssembly.Table) table = candidate;
            return resolved;
          };
          return hooks.instantiate!(imports, context);
        },
        run() {
          throw new Error("must not enter a finished group");
        },
      },
      {
        crossOriginIsolated: true,
        postMessage(message) {
          messages.push(message);
        },
      },
    );
    expect(messages).toContainEqual({
      type: "exit",
      code: 23,
      signal: undefined,
      sleep: "atomics",
    });
    expect(table).toBeInstanceOf(WebAssembly.Table);
    expect(table?.get(1)).toBeNull();
    expect(
      messages.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "exit",
      ),
    ).toHaveLength(1);
  } finally {
    hooks.beforeFinish!();
    connection.client.port.close();
    connection.server.port.close();
  }
});

test("qualified bindings do not collide when module and field contain dots", () => {
  const dylink = importInfo(importRecord("env", "part.add"));
  expect(() =>
    inspectProfile(
      side("errno", "GOT.mem", 4, {
        addModule: "env.part",
        dylink,
      }),
      "engine",
      true,
    ),
  ).toThrow("must name an imported env function");
});

test("foreign function imports retain their host namespace instead of binding to core", async () => {
  const input = source();
  const bytes = side("errno", "GOT.mem", 4, { addModule: "foreign" });
  const profile = inspectProfile(bytes, "engine", true);
  expect(profile.functionImports.find((entry) => entry.name === "add")?.module).toBe("foreign");
  await prepareLinkPlan({ ...input, libraries: [{ ...input.libraries[0]!, source: bytes }] });
});

test("oversized import-info subsection cannot read the following sections", () => {
  const dylink = [4].concat(u32(1000000), [1]);
  expect(() => inspectProfile(side("errno", "GOT.mem", 4, { dylink }), "engine", true)).toThrow(
    "truncated section",
  );
});

test("weak binding never bypasses exact provider signature checks", async () => {
  const input = source();
  await expect(
    prepareLinkPlan({
      ...input,
      core: { ...input.core, source: core({ addParameter: 0x7e }) },
      libraries: [
        {
          ...input.libraries[0]!,
          source: side("errno", "GOT.mem", 4, {
            dylink: importInfo(importRecord("env", "add")),
          }),
        },
      ],
    }),
  ).rejects.toThrow("env.add has an incompatible core function signature");
});

test("data GOT accepts any typed core address export; absent providers fail", async () => {
  const input = source();
  const prepare = (symbol: string) =>
    prepareLinkPlan({ ...input, libraries: [{ ...input.libraries[0]!, source: side(symbol) }] });
  await expect(prepare("stderr")).rejects.toThrow(
    "GOT.mem.stderr requires a core immutable i32 global export",
  );
  await expect(prepare("initialized")).rejects.toThrow(
    "GOT.mem.initialized requires a core immutable i32 global export",
  );
});

for (const [symbol, bounds, ok] of [
  ["__stack_low", [0, 65536], true],
  ["__stack_high", [0, 131072], true],
  ["__stack_high", [0, 131073], false],
  ["stdout", [0, 65536], true],
] as const) {
  test(`stack bound GOT ${symbol} ${bounds.join("..")} may sit on a memory edge`, async () => {
    const input = source();
    const plan = await prepareLinkPlan({
      ...input,
      core: { ...input.core, source: core({ stackBounds: bounds }) },
      libraries: [{ ...input.libraries[0]!, source: side(symbol) }],
    });
    if (!ok) {
      expect(() => instantiateLinkPlan(plan, host())).toThrow("outside core memory");
      return;
    }
    const group = instantiateLinkPlan(plan, host());
    const expected = symbol === "stdout" ? 32 : symbol === "__stack_low" ? bounds[0] : bounds[1];
    expect((group.libraries[0]!.instance.exports.got as WebAssembly.Global).value).toBe(expected);
    group.dispose();
  });
}

for (const field of ["hostOnly", "\uFEFFhostOnly"]) {
  test(`leading BOM in a foreign Wasm namespace/field stays exact: ${JSON.stringify(field)}`, async () => {
    const input = source();
    const namespace = "\uFEFFenv";
    const bytes = side("errno", "GOT.mem", 4, { addModule: namespace, addName: field });
    const actual = WebAssembly.Module.imports(new WebAssembly.Module(bytes)).find(
      (entry) => entry.module === namespace && entry.name === field,
    );
    expect(actual).toEqual({ module: namespace, name: field, kind: "function" });
    const plan = await prepareLinkPlan({
      ...input,
      libraries: [{ ...input.libraries[0]!, source: bytes }],
    });
    const profile = inspectProfile(bytes, "engine", true);
    const imported = profile.functionImports.find((entry) => entry.name === field);
    expect(imported?.module).toBe(actual?.module);
    expect(imported?.name).toBe(actual?.name);
    const group = instantiateLinkPlan(
      plan,
      host(undefined, {
        [namespace]: { [field]: (value: number) => value + 11 },
      }),
    );
    try {
      expect(call(group.entry, "invoke", 7)).toBe(18);
    } finally {
      group.dispose();
    }
  });
}

for (const [module, field] of [
  ["\uFEFFenv", "add"],
  ["env", "\uFEFFadd"],
] satisfies readonly [string, string][]) {
  test(`weak metadata must preserve leading BOM identity: ${JSON.stringify([module, field])}`, () => {
    const bytes = side("errno", "GOT.mem", 4, { dylink: importInfo(importRecord(module, field)) });
    expect(WebAssembly.Module.imports(new WebAssembly.Module(bytes))).toContainEqual({
      module: "env",
      name: "add",
      kind: "function",
    });
    expect(() => inspectProfile(bytes, "engine", true)).toThrow(
      "must name an imported env function",
    );
  });
}

for (const field of ["add", "\uFEFFadd"]) {
  test(`matching weak Wasm field and provider preserve every character: ${JSON.stringify(field)}`, async () => {
    const input = source();
    const owner = core({ aliases: field === "add" ? [] : [[field, 2]] });
    const bytes = side("errno", "GOT.mem", 4, {
      addName: field,
      dylink: importInfo(importRecord("env", field)),
    });
    expect(WebAssembly.Module.exports(new WebAssembly.Module(owner))).toContainEqual({
      name: field,
      kind: "function",
    });
    const profile = inspectProfile(bytes, "engine", true);
    expect(profile.functionImports.find((entry) => entry.name === field)?.binding).toBe("weak");
    expect(profile.importInfo).toEqual([{ module: "env", name: field, flags: 0x11 }]);
    expect(inspectProfile(owner, "core", false).functions.has(field)).toBe(true);
    const plan = await prepareLinkPlan({
      ...input,
      core: { ...input.core, source: owner },
      libraries: [{ ...input.libraries[0]!, source: bytes }],
    });
    const group = instantiateLinkPlan(plan, host());
    try {
      expect(call(group.entry, "invoke", 5)).toBe(12);
    } finally {
      group.dispose();
    }
  });
}

// A side whose `env.<field>` import is also its own defined export, as wasm-ld emits for
// preemptible definitions. Its element segment holds the imported (relayed) function.
function selfSide(
  options: {
    field?: string;
    increment?: number;
    exportIndex?: number;
    got?: boolean;
  } = {},
): Uint8Array<ArrayBuffer> {
  const field = options.field ?? "f";
  return binary(
    section(0, text("dylink.0").concat([1, 4, 0, 0, 1, 0])),
    section(1, vector([type([]), type([0x7f], [0x7f])])),
    section(
      2,
      vector(
        [
          imp("env", "check", [0, 0]),
          imp("env", field, [0, 1]),
          imp("env", "memory", [2, 1, 1].concat(u32(128))),
          imp("env", "__indirect_function_table", [1, 0x70, 1, 0, 32]),
          imp("env", "__memory_base", [3, 0x7f, 0]),
          imp("env", "__table_base", [3, 0x7f, 0]),
          imp("env", "__stack_pointer", [3, 0x7f, 1]),
        ].concat(options.got ? [imp("GOT.func", field, [3, 0x7f, 1])] : []),
      ),
    ),
    section(3, vector([[1], [1], [0]])),
    section(
      7,
      vector(
        [exp(field, 0, options.exportIndex ?? 2), exp("entry", 0, 3), exp("init", 0, 4)].concat(
          options.got ? [exp("got", 3, 3)] : [],
        ),
      ),
    ),
    section(9, [1, 0, 0x23, 1, 0x0b, 1, 1]),
    section(
      10,
      vector([
        body([0x20, 0, 0x41, options.increment ?? 1, 0x6a]),
        body([0x20, 0, 0x10, 1]),
        body([]),
      ]),
    ),
  );
}

function selfSource(...libraries: Uint8Array[]): LinkPlanSource {
  const input = source();
  return {
    ...input,
    libraries: libraries.map((bytes, index) => ({
      ...input.libraries[0]!,
      id: `side${index}`,
      source: bytes,
    })),
  };
}

test("a side binds its own defined export through a typed relay when core lacks it", async () => {
  const group = instantiateLinkPlan(await prepareLinkPlan(selfSource(selfSide())), host());
  try {
    const lib = group.libraries[0]!;
    expect(call(lib.instance, "entry", 7)).toBe(8);
    // The emitted element holds the relayed import; the target slot holds the definition.
    const relay = group.table.get(lib.tableBase);
    expect(relay).not.toBe(lib.instance.exports.f);
    const target = Array.from({ length: group.table.length }, (_, i) => group.table.get(i));
    expect(target.indexOf(lib.instance.exports.f as Function)).toBeGreaterThan(lib.tableBase);
    expect((relay as (value: number) => number)(1)).toBe(2);
  } finally {
    group.dispose();
  }
});

test("core preempts a same-side definition of the same symbol", async () => {
  const group = instantiateLinkPlan(
    await prepareLinkPlan(selfSource(selfSide({ field: "add" }))),
    host(),
  );
  try {
    const lib = group.libraries[0]!;
    expect(call(lib.instance, "entry", 7)).toBe(14);
    expect(call(lib.instance, "add", 7)).toBe(8);
  } finally {
    group.dispose();
  }
});

test("a same-side export of an import or of another type is not a definition", async () => {
  await expect(prepareLinkPlan(selfSource(selfSide({ exportIndex: 1 })))).rejects.toThrow(
    "env.f same-side export re-exports an import, not a definition",
  );
  await expect(prepareLinkPlan(selfSource(selfSide({ exportIndex: 4 })))).rejects.toThrow(
    "env.f has an incompatible same-side function signature",
  );
  await expect(
    prepareLinkPlan(selfSource(selfSide({ field: "add", exportIndex: 4 }))),
  ).resolves.toBeDefined();
});

test("function GOT cells address the selected provider in the shared table", async () => {
  const group = instantiateLinkPlan(
    await prepareLinkPlan(
      selfSource(selfSide({ got: true }), selfSide({ field: "add", got: true })),
    ),
    host(),
  );
  try {
    const [own, preempted] = group.libraries;
    const cell = (lib: typeof own) => (lib!.instance.exports.got as WebAssembly.Global).value;
    expect(group.table.get(cell(own))).toBe(own!.instance.exports.f);
    expect(group.table.get(cell(preempted))).toBe(group.entry.exports.add);
  } finally {
    group.dispose();
  }
});

test("two sides keep independent same-side definitions and clear their slots", async () => {
  const group = instantiateLinkPlan(
    await prepareLinkPlan(
      selfSource(selfSide({ got: true }), selfSide({ increment: 2, got: true })),
    ),
    host(),
  );
  const [a, b] = group.libraries;
  const cells = [a, b].map((lib) => (lib!.instance.exports.got as WebAssembly.Global).value);
  expect(call(a!.instance, "entry", 7)).toBe(8);
  expect(call(b!.instance, "entry", 7)).toBe(9);
  expect(cells[0]).not.toBe(cells[1]);
  group.dispose();
  for (const index of cells) expect(group.table.get(index)).toBeNull();
});
