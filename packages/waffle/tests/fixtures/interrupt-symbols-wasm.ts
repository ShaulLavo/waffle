import { sha256Hex } from "../../interrupt/admitted-store.js";
import type { LinkPlanSource } from "../../link/index.js";

const utf8 = new TextEncoder();

function encodeLebU32(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    const next = v >>> 7;
    out.push((v & 0x7f) | (next ? 0x80 : 0));
    v = next;
  } while (v);
  return out;
}

function encodeSleb(n: number): number[] {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const byte = v & 0x7f;
    v >>= 7;
    const done = (v === 0 && (byte & 0x40) === 0) || (v === -1 && (byte & 0x40) !== 0);
    out.push(done ? byte : byte | 0x80);
    if (done) return out;
  }
}

function strVec(text: string): number[] {
  const raw = Array.from(utf8.encode(text));
  return encodeLebU32(raw.length).concat(raw);
}

function sec(id: number, payload: number[]): number[] {
  return [id].concat(encodeLebU32(payload.length), payload);
}

function vec(items: readonly number[][]): number[] {
  return encodeLebU32(items.length).concat(items.flat());
}

function sig(params: readonly number[], results: readonly number[] = []): number[] {
  return [0x60].concat(encodeLebU32(params.length), params, encodeLebU32(results.length), results);
}

function fnImport(mod: string, field: string, typeIdx: number): number[] {
  return strVec(mod).concat(strVec(field), [0], encodeLebU32(typeIdx));
}

function exp(field: string, kind: number, idx: number): number[] {
  return strVec(field).concat([kind], encodeLebU32(idx));
}

function body(ops: readonly number[]): number[] {
  const inner = [0].concat(ops, [0x0b]);
  return encodeLebU32(inner.length).concat(inner);
}

function assemble(sections: readonly number[][]): Uint8Array<ArrayBuffer> {
  return Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0].concat(sections.flat()));
}

export interface FixtureNameSpec {
  readonly moduleName?: string;
  readonly functionNames?: readonly (readonly [number, string])[];
}

/** Appends a standard Wasm `name` custom section (subsection 0 and/or subsection 1) for test fixtures. */
export function appendFixtureNameSection(
  wasm: Uint8Array,
  spec: FixtureNameSpec,
): Uint8Array<ArrayBuffer> {
  const subs: number[] = [];
  if (spec.moduleName !== undefined) {
    const payload = strVec(spec.moduleName);
    subs.push(0, ...encodeLebU32(payload.length), ...payload);
  }
  if (spec.functionNames !== undefined) {
    const sorted = Array.from(spec.functionNames).toSorted((a, b) => a[0] - b[0]);
    const payload = encodeLebU32(sorted.length).concat(
      sorted.flatMap(([idx, fnName]) => encodeLebU32(idx).concat(strVec(fnName))),
    );
    subs.push(1, ...encodeLebU32(payload.length), ...payload);
  }
  const custom = sec(0, strVec("name").concat(subs));
  const out = new Uint8Array(wasm.byteLength + custom.length);
  out.set(wasm, 0);
  out.set(custom, wasm.byteLength);
  return out;
}

/**
 * Stripped WASI-like guest with 2 imports (proc_exit, host_bridge) and 6 defined functions:
 *   pre-rewrite:       2=_start, 3=outer, 4=inner_trap, 5=call_bridge, 6=trap_div0, 7=recurse
 *   ordinary (+1):     3=_start, 4=outer, 5=inner_trap, 6=call_bridge, 7=trap_div0, 8=recurse
 */
export function trapGuestModule(salt = 1): Uint8Array<ArrayBuffer> {
  const types = sec(1, vec([sig([]), sig([0x7f])]));
  const imports = sec(
    2,
    vec([fnImport("wasi_snapshot_preview1", "proc_exit", 1), fnImport("env", "host_bridge", 0)]),
  );
  const functions = sec(3, [6, 0, 0, 0, 0, 0, 1]);
  const memory = sec(5, [1, 1, 1, 16]);
  const exports = sec(
    7,
    vec([
      exp("memory", 2, 0),
      exp("_start", 0, 2),
      exp("outer", 0, 3),
      exp("call_bridge", 0, 5),
      exp("trap_div0", 0, 6),
      exp("recurse", 0, 7),
    ]),
  );
  const code = sec(
    10,
    vec([
      body([0x10, 3]),
      body([0x41, ...encodeSleb(salt), 0x1a, 0x10, 4]),
      body([0x00]),
      body([0x10, 1]),
      body([0x41, 1, 0x41, 0, 0x6d, 0x1a]),
      body([0x20, 0, 0x45, 0x04, 0x40, 0x00, 0x0b, 0x20, 0, 0x41, 1, 0x6b, 0x10, 7]),
    ]),
  );
  return assemble([types, imports, functions, memory, exports, code]);
}

/** Minimal helper module with 1 import (`env.cb`) and 3 defined functions: 1=helper_outer, 2=helper_trap, 3=helper_call_cb. */
export function helperGuestModule(salt = 101): Uint8Array<ArrayBuffer> {
  const types = sec(1, vec([sig([])]));
  const imports = sec(2, vec([fnImport("env", "cb", 0)]));
  const functions = sec(3, [3, 0, 0, 0]);
  const exports = sec(7, vec([exp("helper_outer", 0, 1), exp("helper_call_cb", 0, 3)]));
  const code = sec(
    10,
    vec([body([0x41, ...encodeSleb(salt), 0x1a, 0x10, 2]), body([0x00]), body([0x10, 0])]),
  );
  return assemble([types, imports, functions, exports, code]);
}

/** Module with native function names (and optional subsection-0 module name). */
export function alreadyNamedGuestModule(moduleName?: string): Uint8Array<ArrayBuffer> {
  const types = sec(1, vec([sig([])]));
  const functions = sec(3, [3, 0, 0, 0]);
  const exports = sec(7, vec([exp("run", 0, 0)]));
  const code = sec(10, vec([body([0x10, 1]), body([0x10, 2]), body([0x00])]));
  return appendFixtureNameSection(assemble([types, functions, exports, code]), {
    moduleName,
    functionNames: [
      [0, "named_entry"],
      [1, "_ZN4echo4main17h0123456789abcdefE"],
      [2, "weird:trap (inner)"],
    ],
  });
}

/** Shared-memory guest for supervised-thread (+3 shift): 1 import, 2 defs (1=_start, 2=inner_trap -> 4, 5). */
export function supervisedTrapGuestModule(): Uint8Array<ArrayBuffer> {
  const types = sec(1, vec([sig([]), sig([0x7f])]));
  const imports = sec(
    2,
    vec([
      fnImport("wasi_snapshot_preview1", "proc_exit", 1),
      strVec("env").concat(strVec("memory"), [2, 3, 1, 4]),
    ]),
  );
  const functions = sec(3, [2, 0, 0]);
  const exports = sec(7, vec([exp("_start", 0, 1)]));
  const code = sec(10, vec([body([0x10, 2]), body([0x00])]));
  return assemble([types, imports, functions, exports, code]);
}

/** Cooperative linked group: core -> side -> relay -> side (4 Wasm frames across 3 modules). */
export function linkedGroupTrapSource(): LinkPlanSource {
  const imported = (field: string, kind: number[]) => strVec("env").concat(strVec(field), kind);
  const core = appendFixtureNameSection(
    assemble([
      sec(1, vec([sig([]), sig([0x7f, 0x7f], [0x7f]), sig([0x7f], [0x7f])])),
      sec(2, vec([imported("check", [0, 0])])),
      sec(3, [3, 1, 0, 2]),
      sec(4, [1, 0x70, 1, 1, 32]),
      sec(5, [1, 1, 2, 128, 1]),
      sec(6, [1, 0x7f, 1, 0x41, 0x80, 0x80, 4, 0x0b]),
      sec(
        7,
        vec([
          exp("check", 0, 0),
          exp("reserve", 0, 1),
          exp("_start", 0, 2),
          exp("call_side", 0, 3),
          exp("memory", 2, 0),
          exp("__indirect_function_table", 1, 0),
          exp("__stack_pointer", 3, 0),
        ]),
      ),
      sec(10, vec([body([0x41, 0x80, 8]), body([]), body([0x41, 7, 0x20, 0, 0x11, 2, 0])])),
    ]),
    { moduleName: "wlink_core_01" },
  );
  const sideImports: ReadonlyArray<readonly [string, readonly number[]]> = [
    ["check", [0, 0]],
    ["f", [0, 1]],
    ["memory", [2, 1, 1, 128, 1]],
    ["__indirect_function_table", [1, 0x70, 1, 0, 32]],
    ["__memory_base", [3, 0x7f, 0]],
    ["__table_base", [3, 0x7f, 0]],
    ["__stack_pointer", [3, 0x7f, 1]],
  ];
  const side = appendFixtureNameSection(
    assemble([
      sec(0, strVec("dylink.0").concat([1, 4, 0, 0, 1, 0])),
      sec(1, vec([sig([]), sig([0x7f], [0x7f])])),
      sec(2, vec(sideImports.map(([field, kind]) => imported(field, Array.from(kind))))),
      sec(3, [3, 1, 1, 0]),
      sec(7, vec([exp("f", 0, 2), exp("entry", 0, 3), exp("init", 0, 4)])),
      sec(9, [1, 0, 0x23, 1, 0x0b, 1, 3]),
      sec(10, vec([body([0x00]), body([0x20, 0, 0x10, 1]), body([])])),
    ]),
    { moduleName: "wlink_side_02" },
  );
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
    libraries: [member("side", side, ["init"])],
    reserve: "reserve",
  };
}

/** Echo-sized fixture (16 imports, 868 definitions) for measuring realistic ~80 KiB sidecar lookup overhead. */
export function echoSizedGuestFixture(): {
  readonly wasm: Uint8Array<ArrayBuffer>;
  readonly importedFunctions: number;
  readonly names: readonly (string | null)[];
} {
  const importedFunctions = 16;
  const definitions = 868;
  const types = sec(1, vec([sig([])]));
  const imports = sec(
    2,
    vec(Array.from({ length: importedFunctions }, (_, idx) => fnImport("env", `imp_${idx}`, 0))),
  );
  const functions = sec(
    3,
    encodeLebU32(definitions).concat(Array.from({ length: definitions }, () => 0)),
  );
  const memory = sec(5, [1, 1, 1, 16]);
  // _start is def 1 (pre-rewrite index 17, admitted index 18), calling def 2 (admitted 19) which traps.
  const exports = sec(7, vec([exp("memory", 2, 0), exp("_start", 0, importedFunctions + 1)]));
  const bodies: number[][] = [];
  for (let i = 0; i < definitions; i++) {
    if (i === 1) bodies.push(body([0x10, ...encodeLebU32(importedFunctions + 2)]));
    else if (i === 2) bodies.push(body([0x00]));
    else bodies.push(body([]));
  }
  const code = sec(10, vec(bodies));
  const names: Array<string | null> = Array.from({ length: definitions }, (_, idx) => {
    if (idx === 1) return "_start";
    if (idx === 2) return "echo_trap_unreachable";
    if (idx < 9) return null;
    const tag = String(idx).padStart(4, "0");
    return `_ZN8coreutils4echo12symbol_table25realistic_mangled_entry_${tag}17h0123456789abcdefE`;
  });
  return {
    wasm: assemble([types, imports, functions, memory, exports, code]),
    importedFunctions,
    names,
  };
}

export interface FixtureSidecarBundle {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly sha256: string;
}

/** Build a compact canonical sidecar matching #608's exact key order: version, source, named, importedFunctions, names. */
export async function buildFixtureSidecar(
  source: Uint8Array<ArrayBuffer>,
  importedFunctions: number,
  names: readonly (string | null)[],
): Promise<FixtureSidecarBundle> {
  const sourceSha256 = await sha256Hex(source);
  const payload = {
    version: 1,
    source: { bytes: source.byteLength, sha256: sourceSha256 },
    named: { bytes: source.byteLength + 128, sha256: "f".repeat(64) },
    importedFunctions,
    names,
  };
  const bytes = new Uint8Array(utf8.encode(JSON.stringify(payload)));
  return { bytes, sha256: await sha256Hex(bytes) };
}
