class Reader {
  private at = 0;
  constructor(private readonly bytes: Uint8Array) {}
  get remaining(): number {
    return this.bytes.length - this.at;
  }
  byte(): number {
    const byte = this.bytes[this.at++];
    if (byte === undefined) throw new Error("truncated C thread fixture section");
    return byte;
  }
  u32(): number {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = this.byte();
      value += (byte & 127) * 2 ** shift;
      if (byte < 128) return value;
    }
    throw new Error("invalid C thread fixture integer");
  }
  take(length: number): Uint8Array {
    if (length > this.remaining) throw new Error("truncated C thread fixture payload");
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
    if (this.remaining !== 0) throw new Error("unconsumed C thread fixture section");
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
  if (!type) throw new Error("unsupported C thread fixture value type");
  return type;
}

function functionTypes(bytes: Uint8Array) {
  const reader = new Reader(bytes);
  const result = reader.vector(() => {
    if (reader.byte() !== 0x60) throw new Error("C thread fixture must use function types");
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
    const module = reader.name();
    const name = reader.name();
    const kind = reader.byte();
    if (kind === 0) return { kind: "function", module, name, typeIndex: reader.u32() } as const;
    if (kind !== 2) throw new Error("unexpected C thread fixture import kind");
    const flags = reader.u32();
    if (flags !== 3)
      throw new Error("C thread fixture must import wasm32 shared memory with a maximum");
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

function exports(
  bytes: Uint8Array,
  module: WebAssembly.Module,
  types: ReturnType<typeof functionTypes>,
  typeIndices: number[],
) {
  const reader = new Reader(bytes);
  const entries = reader.vector(() => {
    const name = reader.name();
    const kind = reader.byte();
    const index = reader.u32();
    if (kind !== 0) return { name, kind: kind === 2 ? "memory" : "other", index } as const;
    const typeIndex = typeIndices[index];
    const type = typeIndex === undefined ? undefined : types[typeIndex];
    if (!type) throw new Error("missing C thread fixture export signature");
    return { name, kind: "function", index, ...type } as const;
  });
  reader.done();
  const wasmExports = WebAssembly.Module.exports(module);
  return entries.map((entry) =>
    entry.kind === "other"
      ? { ...entry, kind: wasmExports.find((item) => item.name === entry.name)?.kind ?? "other" }
      : entry,
  );
}

export function inspectCThreadFixture(bytes: Uint8Array<ArrayBuffer>) {
  const module = new WebAssembly.Module(bytes);
  const reader = new Reader(bytes);
  if (reader.take(4).join(",") !== "0,97,115,109" || reader.take(4).join(",") !== "1,0,0,0")
    throw new WebAssembly.CompileError("invalid C thread fixture header");
  const sections = new Map<number, Uint8Array>();
  while (reader.remaining > 0) {
    const id = reader.byte();
    const body = reader.take(reader.u32());
    if (id !== 0) sections.set(id, body);
  }
  const types = functionTypes(sections.get(1) ?? new Uint8Array([0]));
  const imported = imports(sections.get(2) ?? new Uint8Array([0]));
  const functions = new Reader(sections.get(3) ?? new Uint8Array([0]));
  const typeIndices = imported
    .filter((entry) => entry.kind === "function")
    .map((entry) => entry.typeIndex)
    .concat(functions.vector(() => functions.u32()));
  functions.done();
  const exported = exports(sections.get(7) ?? new Uint8Array([0]), module, types, typeIndices);
  const start = sections.get(8);
  const startIndex = start ? new Reader(start).u32() : null;
  const memory = imported.find((entry) => entry.kind === "memory");
  const spawn = imported.find(
    (entry) =>
      entry.kind === "function" && entry.module === "wasi" && entry.name === "thread-spawn",
  );
  const threadStart = exported.find(
    (entry) => entry.kind === "function" && entry.name === "wasi_thread_start",
  );
  return {
    imports: imported.map((entry) =>
      entry.kind === "function" ? { ...entry, ...types[entry.typeIndex] } : entry,
    ),
    exports: exported,
    start: startIndex === null ? null : { index: startIndex },
    sharedMemory: memory
      ? { minimum: memory.minimum, maximum: memory.maximum, shared: memory.shared }
      : null,
    hasThreadSpawn: spawn?.kind === "function",
    hasThreadStart: threadStart?.kind === "function",
    fixed32MiBImportCompatible:
      memory !== undefined && memory.minimum <= 512 && memory.maximum >= 512 && memory.shared,
  };
}
