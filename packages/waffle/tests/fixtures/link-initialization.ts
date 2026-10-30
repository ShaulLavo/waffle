import type { LinkPlanSource } from "../../link/index.js";

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

export function coreSource(
  writeSentinel: boolean,
  passive = false,
  bounds = false,
): Uint8Array<ArrayBuffer> {
  const counter = bounds ? 5 : 3;
  const tls = counter + 1;
  const info = vector(
    ["__stack_low", "__stack_high"].map((name) => text("env").concat(text(name), [17])),
  );
  const memoryStage = [0x23, 1, 0x24, tls].concat(
    writeSentinel ? [0x23, tls, 0x41, 42, 0x36, 2, 0, 0x41, 1, 0x10, 1] : [0x41, 1, 0x10, 1],
  );
  return binary(
    section(0, text("dylink.0").concat([1, 4, 16, 2, 0, 0], bounds ? section(4, info) : [])),
    section(1, vector([type([]), type([0x7f]), type([0x7f, 0x7f], [0x7f]), type([], [0x7f])])),
    section(
      2,
      vector(
        [
          imp("env", "check", [0, 0]),
          imp("env", "trace", [0, 1]),
          imp("env", "memory", [2, 3, 1].concat(u32(65536))),
          imp("env", "__indirect_function_table", [1, 0x70, 0, 1]),
          imp("env", "__stack_pointer", [3, 0x7f, 1]),
          imp("env", "__memory_base", [3, 0x7f, 0]),
          imp("env", "__table_base", [3, 0x7f, 0]),
        ].concat(
          bounds
            ? [
                imp("GOT.mem", "__stack_low", [3, 0x7f, 1]),
                imp("GOT.mem", "__stack_high", [3, 0x7f, 1]),
              ]
            : [],
        ),
      ),
    ),
    section(3, vector([[0], [0], [2], [0], [3], [0]])),
    section(
      6,
      vector([
        [0x7f, 1, 0x41, 0, 0x0b],
        [0x7f, 1, 0x41, 0, 0x0b],
      ]),
    ),
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
        exp("__wasm_apply_data_relocs", 0, 7),
        exp("reloc_alias", 0, 7),
        exp("", 0, 7),
        exp("relocations", 3, counter),
        exp("tls", 3, tls),
        exp("stack", 3, 0),
      ]),
    ),
    section(
      10,
      vector([
        body(memoryStage),
        body([0x41, 2, 0x10, 1]),
        body([0x41, 3, 0x10, 1, 0x23, 1, 0x41, 32, 0x6a]),
        body([0x41, 9, 0x10, 1]),
        body([0x23, tls, 0x28, 2, 0]),
        body([0x23, counter, 0x41, 1, 0x6a, 0x24, counter]),
      ]),
    ),
    ...(passive ? [section(11, vector([[1, 1, 42]]))] : []),
  );
}

export function sideSource(relocation = false): Uint8Array<ArrayBuffer> {
  return binary(
    section(0, text("dylink.0").concat([1, 4, 16, 4, 1, 0])),
    section(1, vector([type([]), type([0x7f]), type([], [0x7f])])),
    section(
      2,
      vector([
        imp("env", "check", [0, 0]),
        imp("env", "trace", [0, 1]),
        imp("env", "memory", [2, 3, 1].concat(u32(65536))),
        imp("env", "__indirect_function_table", [1, 0x70, 0, 1]),
        imp("env", "__memory_base", [3, 0x7f, 0]),
        imp("env", "__table_base", [3, 0x7f, 0]),
        imp("env", "__stack_pointer", [3, 0x7f, 1]),
      ]),
    ),
    section(3, vector([[0], [0], [0], [2]])),
    section(
      6,
      vector([
        [0x7f, 1, 0x41, 0, 0x0b],
        [0x7f, 1, 0x41, 0, 0x0b],
      ]),
    ),
    section(
      7,
      vector(
        [
          exp("side_initialize_memory", 0, 2),
          exp("side_initialize", 0, 3),
          exp("relocations", 3, 3),
          exp("tls", 3, 4),
          exp("stack", 3, 2),
          exp("read", 0, 5),
        ].concat(relocation ? [exp("__wasm_apply_data_relocs", 0, 4)] : []),
      ),
    ),
    section(
      10,
      vector([
        body([0x23, 0, 0x24, 4, 0x23, 4, 0x41, 22, 0x36, 2, 0, 0x41, 4, 0x10, 1]),
        body([0x41, 5, 0x10, 1]),
        body([0x41, 6, 0x10, 1, 0x23, 3, 0x41, 1, 0x6a, 0x24, 3]),
        body([0x23, 4, 0x28, 2, 0]),
      ]),
    ),
  );
}

export function source(writeSentinel = false, bounds = false): LinkPlanSource {
  return {
    core: {
      id: "core",
      source: coreSource(writeSentinel, false, bounds),
      cooperative: true,
      checkpoint: { module: "env", name: "check" },
      initializeMemory: ["core_initialize_memory", "__wasm_apply_data_relocs"],
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
