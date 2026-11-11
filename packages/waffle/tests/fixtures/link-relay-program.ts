import type { LinkPlanSource } from "../../link/index.js";
import { leb, text, section } from "./publication-wasm.js";

const list = (items: number[][]) => leb(items.length).concat(items.flat());
const signature = (args: number[], returns: number[] = []) =>
  [0x60].concat(leb(args.length), args, leb(returns.length), returns);
const imported = (name: string, kind: number[]) => text("env").concat(text(name), kind);
const exported = (name: string, kind: number, index: number) =>
  text(name).concat([kind], leb(index));
const instructions = (ops: number[]) => leb(ops.length + 2).concat([0], ops, [0x0b]);
const wasm = (parts: number[][]) =>
  Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0].concat(parts.flat()));

/** Original ordinary core plus a side whose imported f resolves through its own typed relay. */
export function relayProgram(): LinkPlanSource {
  const core = wasm([
    section(1, list([signature([]), signature([0x7f, 0x7f], [0x7f])])),
    section(2, list([imported("check", [0, 0])])),
    section(3, [2, 1, 0]),
    section(4, [1, 0x70, 1, 1, 32]),
    section(5, [1, 1, 2, 128, 1]),
    section(6, [1, 0x7f, 1, 0x41, 0x80, 0x80, 4, 0x0b]),
    section(
      7,
      list([
        exported("check", 0, 0),
        exported("reserve", 0, 1),
        exported("_start", 0, 2),
        exported("memory", 2, 0),
        exported("__indirect_function_table", 1, 0),
        exported("__stack_pointer", 3, 0),
      ]),
    ),
    section(10, list([instructions([0x41, 0x80, 8]), instructions([])])),
  ]);
  const side = wasm([
    section(0, text("dylink.0").concat([1, 4, 0, 0, 1, 0])),
    section(1, list([signature([]), signature([0x7f], [0x7f])])),
    section(
      2,
      list([
        imported("check", [0, 0]),
        imported("f", [0, 1]),
        imported("memory", [2, 1, 1, 128, 1]),
        imported("__indirect_function_table", [1, 0x70, 1, 0, 32]),
        imported("__memory_base", [3, 0x7f, 0]),
        imported("__table_base", [3, 0x7f, 0]),
        imported("__stack_pointer", [3, 0x7f, 1]),
      ]),
    ),
    section(3, [3, 1, 1, 0]),
    section(7, list([exported("f", 0, 2), exported("entry", 0, 3), exported("init", 0, 4)])),
    section(9, [1, 0, 0x23, 1, 0x0b, 1, 1]),
    section(
      10,
      list([
        instructions([0x20, 0, 0x41, 1, 0x6a]),
        instructions([0x20, 0, 0x10, 1]),
        instructions([]),
      ]),
    ),
  ]);
  const member = (id: string, source: Uint8Array, initialize: string[]) => ({
    id,
    source,
    cooperative: true as const,
    checkpoint: { module: "env", name: "check" },
    initializeMemory: [],
    initialize,
  });
  return {
    core: member("core", core, []),
    libraries: [member("self", side, ["init"])],
    reserve: "reserve",
  };
}
