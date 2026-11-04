const leb = (n: number): number[] =>
  n < 128 ? [n] : [(n % 128) + 128].concat(leb(Math.floor(n / 128)));
const name = (s: string) => leb(s.length).concat(Array.from(new TextEncoder().encode(s)));
const vec = (items: readonly number[][]) => leb(items.length).concat(items.flat());
const section = (id: number, bytes: number[]) => [id].concat(leb(bytes.length), bytes);
const body = (ops: number[]) => leb(ops.length + 2).concat([0], ops, [0x0b]);
const binary = (...sections: number[][]) =>
  new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0].concat(sections.flat()));

/** A PIE core whose _start body is `ops`; optionally re-exports the imported memory. */
export function pieCore(ops: number[], exportMemory = false): Uint8Array<ArrayBuffer> {
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
