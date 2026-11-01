class Reader {
  private at = 0;
  constructor(private readonly bytes: Uint8Array) {}
  get remaining(): number {
    return this.bytes.length - this.at;
  }
  byte(): number {
    const byte = this.bytes[this.at++];
    if (byte === undefined) throw new Error("truncated fixture section");
    return byte;
  }
  u32(): number {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = this.byte();
      value += (byte & 127) * 2 ** shift;
      if (byte < 128) return value;
    }
    throw new Error("invalid fixture integer");
  }
  take(length: number): Uint8Array {
    if (length > this.remaining) throw new Error("truncated fixture payload");
    const result = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    return result;
  }
  name(): string {
    return new TextDecoder("utf-8", { fatal: true }).decode(this.take(this.u32()));
  }
  vector<T>(read: () => T): T[] {
    return Array.from({ length: this.u32() }, read);
  }
  done(): void {
    if (this.remaining !== 0) throw new Error("unconsumed fixture section");
  }
}

const valueTypes = new Map([
  [0x7f, "i32"],
  [0x7e, "i64"],
  [0x7d, "f32"],
  [0x7c, "f64"],
]);

function valueType(reader: Reader): string {
  const type = valueTypes.get(reader.byte());
  if (!type) throw new Error("unsupported fixture value type");
  return type;
}

function functionTypes(bytes: Uint8Array) {
  const reader = new Reader(bytes);
  const result = reader.vector(() => {
    if (reader.byte() !== 0x60) throw new Error("fixture must use function types");
    return {
      parameters: reader.vector(() => valueType(reader)),
      results: reader.vector(() => valueType(reader)),
    };
  });
  reader.done();
  return result;
}

function imports(bytes: Uint8Array) {
  const reader = new Reader(bytes);
  const result = reader.vector(() => {
    const module = reader.name(),
      name = reader.name(),
      kind = reader.byte();
    if (kind === 0) return { kind: "function", module, name, typeIndex: reader.u32() } as const;
    if (kind !== 2) throw new Error("unexpected fixture import kind");
    const flags = reader.u32();
    if (flags !== 3) throw new Error("fixture must import wasm32 shared memory with a maximum");
    return {
      kind: "memory",
      module,
      name,
      minimum: reader.u32(),
      maximum: reader.u32(),
      shared: true,
    } as const;
  });
  reader.done();
  return result;
}

function constant(reader: Reader): number {
  if (reader.byte() !== 0x41) throw new Error("fixture initializer must be i32.const");
  let value = 0,
    shift = 0,
    byte: number;
  do {
    byte = reader.byte();
    value += (byte & 127) * 2 ** shift;
    shift += 7;
  } while (byte >= 128 && shift < 35);
  if (reader.byte() !== 0x0b) throw new Error("unterminated fixture initializer");
  return byte & 64 ? value - 2 ** shift : value;
}

function globals(bytes: Uint8Array) {
  const reader = new Reader(bytes);
  const result = reader.vector(() => ({
    type: valueType(reader),
    mutable: reader.byte() === 1,
    initial: constant(reader),
  }));
  reader.done();
  return result;
}

function dataSegments(bytes: Uint8Array) {
  const reader = new Reader(bytes);
  const result = reader.vector(() => {
    const mode = reader.u32();
    if (mode === 1) return { kind: "passive", size: reader.take(reader.u32()).length } as const;
    if (mode !== 0) throw new Error("unexpected fixture data mode");
    const offset = constant(reader);
    return { kind: "active", offset, size: reader.take(reader.u32()).length } as const;
  });
  reader.done();
  return result;
}

export function inspectThreadFixture(bytes: Uint8Array<ArrayBuffer>) {
  const module = new WebAssembly.Module(bytes);
  const reader = new Reader(bytes);
  reader.take(8);
  const sections = new Map<number, Uint8Array>();
  while (reader.remaining > 0) {
    const id = reader.byte(),
      body = reader.take(reader.u32());
    if (id !== 0) sections.set(id, body);
  }
  const get = (id: number) => sections.get(id) ?? new Uint8Array([0]);
  const types = functionTypes(get(1));
  const imported = imports(get(2));
  const functions = new Reader(get(3));
  const typeIndices = imported
    .filter((entry) => entry.kind === "function")
    .map((entry) => entry.typeIndex)
    .concat(functions.vector(() => functions.u32()));
  functions.done();
  const signature = (index: number) => {
    const typeIndex = typeIndices[index];
    const type = typeIndex === undefined ? undefined : types[typeIndex];
    if (!type) throw new Error("missing fixture function signature");
    return type;
  };
  const globalEntries = globals(get(6));
  const exports = new Reader(get(7));
  const exported = exports.vector(() => {
    const name = exports.name(),
      kind = exports.byte(),
      index = exports.u32();
    if (kind === 0) return { name, kind: "function", index, ...signature(index) };
    if (kind === 3) return { name, kind: "global", index, ...globalEntries[index] };
    return {
      name,
      kind: WebAssembly.Module.exports(module).find((entry) => entry.name === name)?.kind,
      index,
    };
  });
  exports.done();
  const start = sections.get(8);
  const startIndex = start ? new Reader(start).u32() : null;
  return {
    imports: imported.map((entry) =>
      entry.kind === "function" ? { ...entry, ...types[entry.typeIndex] } : entry,
    ),
    exports: exported,
    start: startIndex === null ? null : { index: startIndex, ...signature(startIndex) },
    globals: globalEntries,
    data: dataSegments(get(11)),
    fixed32MiBImportCompatible: imported.some(
      (entry) => entry.kind === "memory" && entry.minimum <= 512 && entry.maximum >= 512,
    ),
  };
}
