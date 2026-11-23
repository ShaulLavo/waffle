// Hand-encoded WASI guests for symbol sidecar tests: one `proc_exit` import, capped memory and
// one exported `() -> i32` definition per name, so the pinned optimizer keeps every function.
const header = [0, 97, 115, 109, 1, 0, 0, 0];
const encoder = new TextEncoder();

export function u32(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  do {
    const low = rest & 127;
    rest = Math.floor(rest / 128);
    bytes.push(rest ? low | 128 : low);
  } while (rest);
  return bytes;
}

export function text(value: string | Uint8Array): number[] {
  const bytes = Array.from(typeof value === "string" ? encoder.encode(value) : value);
  return u32(bytes.length).concat(bytes);
}

function vector(items: readonly number[][]): number[] {
  return u32(items.length).concat(items.flat());
}

function section(id: number, payload: readonly number[]): number[] {
  return [id].concat(u32(payload.length), payload);
}

/** A `name` custom section from raw `[id, payload]` subsections, in the order given. */
export function nameSection(subsections: readonly (readonly [number, readonly number[]])[]) {
  const payload = subsections.flatMap(([id, data]) => [id].concat(u32(data.length), data));
  return section(0, text("name").concat(payload));
}

/** A function name map from raw `[index, name]` entries, in the order given. */
export function functionNameMap(entries: readonly (readonly [number, string | Uint8Array])[]) {
  return u32(entries.length).concat(
    entries.flatMap(([index, name]) => u32(index).concat(text(name))),
  );
}

/** The guest with `definitions` functions, followed by any extra raw sections. */
export function wasiModule(definitions: number, extra: readonly number[] = []): Uint8Array {
  const indices = Array.from({ length: definitions }, (_, index) => index);
  const body = (index: number) => [0, 0x41, (index + 1) & 63, 0x0b];
  return Uint8Array.from(
    header.concat(
      section(
        1,
        vector([
          [0x60, 0, 1, 0x7f],
          [0x60, 1, 0x7f, 0],
        ]),
      ),
      section(2, vector([text("wasi_snapshot_preview1").concat(text("proc_exit"), [0, 1])])),
      section(3, vector(indices.map(() => [0]))),
      section(5, [1, 1, 1, 0x80, 0x20]),
      section(7, vector(indices.map((index) => text(`f${index}`).concat([0], u32(index + 1))))),
      section(10, vector(indices.map((index) => u32(4).concat(body(index))))),
      extra,
    ),
  );
}

/** The guest naming its import and each definition `names[i]`, duplicates included. */
export function namedWasiFixture(names: readonly string[]): Uint8Array {
  const entries: (readonly [number, string])[] = [[0, "proc_exit"]];
  const map = functionNameMap(entries.concat(names.map((name, index) => [index + 1, name])));
  return wasiModule(names.length, nameSection([[1, map]]));
}

function readU32(bytes: Uint8Array, cursor: { offset: number }) {
  let value = 0;
  for (let shift = 0; ; shift += 7) {
    const byte = bytes[cursor.offset++]!;
    value += (byte & 127) * 2 ** shift;
    if (byte < 128) return value;
  }
}

function readExports(bytes: Uint8Array, cursor: { offset: number }) {
  const exports = new Map<string, number>();
  const count = readU32(bytes, cursor);
  for (let entry = 0; entry < count; entry++) {
    const length = readU32(bytes, cursor);
    const name = new TextDecoder().decode(bytes.subarray(cursor.offset, cursor.offset + length));
    cursor.offset += length;
    const kind = bytes[cursor.offset++];
    const index = readU32(bytes, cursor);
    if (kind === 0) exports.set(name, index);
  }
  return exports;
}

/** Function indices of every exported function, read from the export section. */
export function exportedFunctions(bytes: Uint8Array): Map<string, number> {
  const cursor = { offset: 8 };
  while (cursor.offset < bytes.length) {
    const id = bytes[cursor.offset++];
    const size = readU32(bytes, cursor);
    const end = cursor.offset + size;
    if (id === 7) return readExports(bytes, cursor);
    cursor.offset = end;
  }
  return new Map();
}
