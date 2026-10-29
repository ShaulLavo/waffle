import { expect, test } from "bun:test";
import { Wasi } from "../core/wasi.js";
import { MemFS } from "../fs/memory.js";
import { instantiateLinkPlan, prepareLinkPlan } from "../link/index.js";
import { inspectProfile } from "../link/metadata.js";

const leb = (n: number): number[] =>
  n < 128 ? [n] : [(n % 128) + 128].concat(leb(Math.floor(n / 128)));
const name = (s: string) => leb(s.length).concat(Array.from(new TextEncoder().encode(s)));
const vec = (items: readonly number[][]) => leb(items.length).concat(items.flat());
const section = (id: number, bytes: number[]) => [id].concat(leb(bytes.length), bytes);
const imp = (field: string, descriptor: number[]) => name("env").concat(name(field), descriptor);
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

/** A PIE core: imports shared memory, table, bases and stack; exports a const data address. */
function pieCore(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    [0, 97, 115, 109, 1, 0, 0, 0].concat(
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
          imp("check", [0, 0]),
          imp("memory", [2, 3, 1].concat(leb(65536))),
          imp("__indirect_function_table", [1, 0x70, 0, 1]),
          imp("__stack_pointer", [3, 0x7f, 1]),
          imp("__memory_base", [3, 0x7f, 0]),
          imp("__table_base", [3, 0x7f, 0]),
        ]),
      ),
      section(3, vec([[1], [0]])),
      section(6, vec([[0x7f, 0, 0x41, 16, 0x0b]])),
      section(
        7,
        vec([
          exp("check", 0, 0),
          exp("bun_core_alloc", 0, 1),
          exp("_start", 0, 2),
          exp("data_sym", 3, 3),
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
