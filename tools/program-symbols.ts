// Optional function-name sidecars for stripped program guests. The sidecar binds the names of
// the named optimized candidate to the stripped bytes that ship, indexed by original function
// definition so a runtime can map rewritten frame indices back without trusting the file itself.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const programSymbolsVersion = 1;
export const programSymbolsOperation = "extract-wasm-function-names" as const;

export interface ProgramIdentity {
  readonly bytes: number;
  readonly sha256: string;
}

export interface ProgramSymbols {
  readonly version: typeof programSymbolsVersion;
  /** The stripped program bytes that ship. */
  readonly source: ProgramIdentity;
  /** The named optimized candidate the names were read from. */
  readonly named: ProgramIdentity;
  readonly importedFunctions: number;
  /** One entry per original function definition; `null` when the producer named none. */
  readonly names: readonly (string | null)[];
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const functionSection = 3;
const functionNameSubsection = 1;

function identityOf(bytes: Uint8Array): ProgramIdentity {
  return { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Hash of this file, bound into a symbols receipt so a changed extractor invalidates it. */
export function programSymbolsExtractorSha256() {
  // Packaged Node builds sit beside the original TypeScript bytes, which this hash binds.
  return identityOf(readFileSync(new URL("./program-symbols.ts", import.meta.url))).sha256;
}

class Reader {
  offset = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  get done() {
    return this.offset === this.bytes.length;
  }
  byte() {
    const value = this.bytes[this.offset++];
    assert.ok(value !== undefined, "Truncated Wasm metadata");
    return value;
  }
  u32() {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = this.byte();
      assert.ok(shift < 28 || byte < 16, "Invalid Wasm u32");
      value += (byte & 127) * 2 ** shift;
      if (byte < 128) return value;
    }
    throw new Error("Invalid Wasm u32");
  }
  take(length: number) {
    assert.ok(length <= this.bytes.length - this.offset, "Truncated Wasm metadata");
    const start = this.offset;
    this.offset += length;
    return this.bytes.subarray(start, this.offset);
  }
}

function isUnshared(bytes: Uint8Array): bytes is Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer;
}

/** Original function imports and definitions, read from the module's own sections. */
export function programFunctionLayout(bytes: Uint8Array) {
  assert.ok(isUnshared(bytes), "Program bytes must not be shared memory");
  const module = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(module).filter(({ kind }) => kind === "function");
  const reader = new Reader(bytes);
  reader.take(8);
  let definitions = 0;
  while (!reader.done) {
    const kind = reader.byte();
    const section = new Reader(reader.take(reader.u32()));
    if (kind === functionSection) definitions = section.u32();
  }
  return { module, importedFunctions: imports.length, definitions };
}

function readFunctionNames(data: Reader, importedFunctions: number, names: (string | null)[]) {
  const count = data.u32();
  let previous = -1;
  for (let entry = 0; entry < count; entry++) {
    const index = data.u32();
    assert.ok(index > previous, "Function names are not in ascending index order");
    assert.ok(index < importedFunctions + names.length, "Function name index is out of range");
    const name = decoder.decode(data.take(data.u32()));
    if (index >= importedFunctions && name) names[index - importedFunctions] = name;
    previous = index;
  }
  assert.ok(data.done, "Trailing function name bytes");
}

/** Strictly read subsection 1 of the only `name` section, keeping duplicate names. */
export function definitionNames(bytes: Uint8Array) {
  const { module, importedFunctions, definitions } = programFunctionLayout(bytes);
  const sections = WebAssembly.Module.customSections(module, "name");
  const names = Array.from({ length: definitions }, (): string | null => null);
  // A module without definitions has no names to lose; the optimizer may drop its section.
  if (definitions === 0 && sections.length === 0) return { importedFunctions, names };
  assert.ok(sections.length === 1, "Expected exactly one name section");
  const reader = new Reader(new Uint8Array(sections[0]!));
  let previous = -1;
  while (!reader.done) {
    const kind = reader.byte();
    assert.ok(kind > previous, "Name subsections are out of order or repeated");
    previous = kind;
    const data = new Reader(reader.take(reader.u32()));
    if (kind === functionNameSubsection) readFunctionNames(data, importedFunctions, names);
  }
  assert.ok(
    definitions === 0 || names.some((name) => name !== null),
    "Named program candidate has no function definition names",
  );
  return { importedFunctions, names };
}

export function encodeProgramSymbols(symbols: ProgramSymbols): Uint8Array {
  const { version, source, named, importedFunctions, names } = symbols;
  return Buffer.from(JSON.stringify({ version, source, named, importedFunctions, names }));
}

/** Build the sidecar for `stripped`, reading names from the named candidate it came from. */
export function programSymbols(named: Uint8Array, stripped: Uint8Array): Uint8Array {
  const { importedFunctions, names } = definitionNames(named);
  const shipped = programFunctionLayout(stripped);
  assert.equal(shipped.importedFunctions, importedFunctions, "Stripping changed function imports");
  assert.equal(shipped.definitions, names.length, "Stripping changed function definitions");
  return encodeProgramSymbols({
    version: programSymbolsVersion,
    source: identityOf(stripped),
    named: identityOf(named),
    importedFunctions,
    names,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isName(value: unknown) {
  return value === null || (typeof value === "string" && value.length > 0);
}

/** Check a sidecar against the stripped bytes and named identity its receipt declares. */
export function validateProgramSymbols(
  symbolBytes: Uint8Array,
  stripped: Uint8Array,
  named: ProgramIdentity,
): ProgramSymbols {
  const value: unknown = JSON.parse(decoder.decode(symbolBytes));
  assert.ok(isRecord(value), "Program symbols must be an object");
  assert.equal(value.version, programSymbolsVersion, "Unsupported program symbols version");
  const source = identityOf(stripped);
  assert.deepEqual(value.source, source, "Program symbols source identity");
  assert.deepEqual(value.named, named, "Program symbols named identity");
  const layout = programFunctionLayout(stripped);
  assert.equal(value.importedFunctions, layout.importedFunctions, "Program symbols import count");
  assert.ok(Array.isArray(value.names) && value.names.every(isName), "Invalid program symbols");
  assert.equal(value.names.length, layout.definitions, "Program symbols definition count");
  const symbols: ProgramSymbols = {
    version: programSymbolsVersion,
    source,
    named,
    importedFunctions: layout.importedFunctions,
    names: value.names,
  };
  assert.ok(
    Buffer.from(encodeProgramSymbols(symbols)).equals(symbolBytes),
    "Program symbols are not canonically encoded",
  );
  return symbols;
}

/** The generated module callers import for a trusted sidecar URL and digest. */
export function programSymbolsReference(base: string, sidecar: ProgramIdentity) {
  return [
    `// Generated by Waffle program staging from ${base}-program.json. Do not edit.`,
    "export const symbols = {",
    `  url: new URL(${JSON.stringify(`./${base}-symbols.json`)}, import.meta.url),`,
    `  bytes: ${sidecar.bytes},`,
    `  sha256: ${JSON.stringify(sidecar.sha256)},`,
    "} as const;",
    "",
  ].join("\n");
}
