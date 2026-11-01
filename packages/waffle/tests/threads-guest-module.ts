const unsigned = (value: number): number[] => {
  const bytes: number[] = [];
  do {
    const next = Math.floor(value / 128);
    bytes.push((value & 127) | (next ? 128 : 0));
    value = next;
  } while (value);
  return bytes;
};
const signed = (value: bigint): number[] => {
  const bytes: number[] = [];
  for (;;) {
    const byte = Number(value & 127n);
    value >>= 7n;
    const done = (value === 0n && !(byte & 64)) || (value === -1n && !!(byte & 64));
    bytes.push(byte | (done ? 0 : 128));
    if (done) return bytes;
  }
};
const text = (value: string) => {
  const bytes = Array.from(new TextEncoder().encode(value));
  return unsigned(bytes.length).concat(bytes);
};
const vector = (items: number[][]) => unsigned(items.length).concat(...items);
const section = (id: number, bytes: number[]) => [id].concat(unsigned(bytes.length), bytes);
export const i32 = (value: number) => [0x41].concat(signed(BigInt(value)));
export const i64 = (value: bigint) => [0x42].concat(signed(value));
export const call = (index: number) => [0x10].concat(unsigned(index));
export const store = (address: number, value: number[]) => i32(address).concat(value, [0x36, 2, 0]);
export const notify = (address: number) => i32(address).concat(i32(8), [0xfe, 0, 2, 0, 0x1a]);
export const wait32 = (address: number, expected = 0) =>
  i32(address).concat(i32(expected), i64(-1n), [0xfe, 1, 2, 0, 0x1a]);
export const wait64 = (address: number) =>
  i32(address).concat(i64(0n), i64(-1n), [0xfe, 2, 3, 0, 0x1a]);
export interface GuestFunctionImport {
  module?: string;
  name: string;
  params: number[];
  result?: boolean;
}
/** Original binary generator. No external compiler or stored guest artifact is needed. */
export function guestModule(
  input: {
    imports?: GuestFunctionImport[];
    initial?: number[];
    secondary?: number[];
    start?: number[];
  } = {},
): Uint8Array<ArrayBuffer> {
  const imports = input.imports ?? [];
  const types = imports.map((entry) =>
    [0x60].concat(
      unsigned(entry.params.length),
      entry.params,
      entry.result === false ? [0] : [1, 0x7f],
    ),
  );
  types.push([0x60, 0, 0], [0x60, 2, 0x7f, 0x7f, 0]);
  const functions = imports.map((entry, index) =>
    text(entry.module ?? "wasi_snapshot_preview1").concat(text(entry.name), [0], unsigned(index)),
  );
  functions.push(text("env").concat(text("memory"), [2, 3, 2], unsigned(512)));
  const n = imports.length;
  const bodies = [input.initial ?? [], input.secondary ?? []];
  if (input.start) bodies.push(input.start);
  const exports = text("_start").concat(
    [0],
    unsigned(n),
    text("wasi_thread_start"),
    [0],
    unsigned(n + 1),
  );
  const sections = [
    section(1, vector(types)),
    section(2, vector(functions)),
    section(3, vector(bodies.map((_, index) => unsigned(index === 1 ? n + 1 : n)))),
    section(7, [2].concat(exports)),
  ];
  if (input.start) sections.push(section(8, unsigned(n + 2)));
  sections.push(
    section(
      10,
      vector(
        bodies.map((body) => {
          const bytes = [0].concat(body, [0x0b]);
          return unsigned(bytes.length).concat(bytes);
        }),
      ),
    ),
  );
  return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0].concat(...sections));
}
