function uleb(value: number): number[] {
  const bytes: number[] = [];
  do {
    const byte = value & 127;
    value >>>= 7;
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
  return bytes;
}
const section = (id: number, bytes: number[]) => [id].concat(uleb(bytes.length), bytes);
const text = (value: string) => {
  const bytes = Array.from(new TextEncoder().encode(value));
  return uleb(bytes.length).concat(bytes);
};
/** Plain preview1: sleep with one page, grow by two, then poll until cancelled. */
export function memoryObservationGuest(): WebAssembly.Module {
  const poll = [0x41, 0, 0x41, 0xc0, 0, 0x41, 1, 0x41, 0xe0, 0, 0x10, 0, 0x1a];
  const body = [0].concat(poll, [0x41, 2, 0x40, 0, 0x1a, 0x03, 0x40], poll, [0x0c, 0, 0x0b, 0x0b]);
  const data = new Uint8Array(48);
  const view = new DataView(data.buffer);
  view.setUint32(16, 1, true);
  view.setBigUint64(24, 200_000_000n, true);
  return new WebAssembly.Module(
    Uint8Array.from(
      [0, 97, 115, 109, 1, 0, 0, 0].concat(
        section(1, [2, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f, 0x60, 0, 0]),
        section(2, [1].concat(text("wasi_snapshot_preview1"), text("poll_oneoff"), [0, 0])),
        section(3, [1, 1]),
        section(5, [1, 1, 1, 8]),
        section(7, [2].concat(text("memory"), [2, 0], text("_start"), [0, 1])),
        section(10, [1].concat(uleb(body.length), body)),
        section(11, [1, 0, 0x41, 0, 0x0b].concat(uleb(data.length), Array.from(data))),
      ),
    ),
  );
}

/** The engine allocates defined memory before a trapping start; only imported memory is observable. */
export function failingMemoryObservationGuest(imported: boolean): WebAssembly.Module {
  return new WebAssembly.Module(
    Uint8Array.from(
      [0, 97, 115, 109, 1, 0, 0, 0].concat(
        section(1, [1, 0x60, 0, 0]),
        imported ? section(2, [1].concat(text("env"), text("memory"), [2, 1, 1, 8])) : [],
        section(3, [1, 0]),
        imported ? [] : section(5, [1, 1, 1, 8]),
        section(7, [2].concat(text("memory"), [2, 0], text("_start"), [0, 0])),
        section(8, [0]),
        section(10, [1, 3, 0, 0, 0x0b]),
      ),
    ),
  );
}
