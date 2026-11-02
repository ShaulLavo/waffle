const header = [0, 97, 115, 109, 1, 0, 0, 0];
function unsigned(value: number): number[] {
  const bytes: number[] = [];
  do {
    const next = Math.floor(value / 128);
    bytes.push((value & 127) | (next ? 128 : 0));
    value = next;
  } while (value);
  return bytes;
}
function signed(value: bigint): number[] {
  const bytes: number[] = [];
  for (;;) {
    const byte = Number(value & 127n);
    value >>= 7n;
    const done = (value === 0n && !(byte & 64)) || (value === -1n && !!(byte & 64));
    bytes.push(byte | (done ? 0 : 128));
    if (done) return bytes;
  }
}
function text(value: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(value));
  return unsigned(bytes.length).concat(bytes);
}
const vector = (items: number[][]) => unsigned(items.length).concat(...items);
const section = (id: number, bytes: number[]) => [id].concat(unsigned(bytes.length), bytes);
const signature = (params: number[], results: number[]) =>
  [0x60].concat(unsigned(params.length), params, unsigned(results.length), results);
const exported = (name: string, kind: number, index: number) =>
  text(name).concat([kind], unsigned(index));
const arguments3 = [0x20, 0, 0x20, 1, 0x20, 2];

/** Original tiny modules. No producer artifact or compiler dependency is embedded. */
export function interruptWaitFixture({
  width = 4,
  offset = 0,
  start = false,
  catchTrap = false,
}: {
  width?: 4 | 8;
  offset?: number;
  start?: boolean;
  catchTrap?: boolean;
} = {}): Uint8Array<ArrayBuffer> {
  const expected = width === 4 ? 0x7f : 0x7e;
  const wait = arguments3.concat(
    [0xfe, width === 4 ? 1 : 2, width === 4 ? 2 : 3],
    unsigned(offset),
  );
  const guarded = [0x02, 0x40, 0x1f, 0x40, 1, 2, 0].concat(
    wait,
    [0x0f, 0x0b, 0x0b, 0x41],
    signed(99n),
  );
  const bodies = [
    catchTrap ? guarded : wait,
    [0x20, 0, 0x20, 1, 0xfe, 0, 2, 0],
    arguments3.concat([0x10, 1]),
    arguments3.concat([0x41, 0, 0x11, 0, 0]),
    [0x41, 0, width === 4 ? 0x41 : 0x42, 0, 0x42, 0, 0x10, 1, 0x1a, 0x10, 0, 0x1a],
  ];
  const sections = [
    section(
      1,
      vector([
        signature([0x7f, expected, 0x7e], [0x7f]),
        signature([0x7f, 0x7f], [0x7f]),
        signature([], [0x7f]),
        signature([], []),
      ]),
    ),
    section(
      2,
      vector([
        text("env").concat(text("value"), [0, 2]),
        text("env").concat(text("memory"), [2, 3, 1, 1]),
      ]),
    ),
    section(3, vector([0, 1, 0, 0, 3].map(unsigned))),
    section(4, [1, 0x70, 0, 1]),
    section(6, [1, 0x70, 0, 0xd2, 1, 0x0b]),
    section(
      7,
      vector([
        exported("run", 0, 1),
        exported("notify", 0, 2),
        exported("direct", 0, 3),
        exported("indirect", 0, 4),
        exported("reference", 3, 0),
        exported("value", 0, 0),
      ]),
    ),
  ];
  if (start) sections.push(section(8, [5]));
  sections.push(section(9, [1, 0, 0x41, 0, 0x0b, 1, 1]));
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
  return new Uint8Array(header.concat(...sections));
}
