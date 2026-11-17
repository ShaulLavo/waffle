function unsigned(value: number): number[] {
  const bytes: number[] = [];
  do {
    const next = Math.floor(value / 128);
    bytes.push((value & 127) | (next ? 128 : 0));
    value = next;
  } while (value);
  return bytes;
}
function signed(value: number): number[] {
  const bytes: number[] = [];
  for (;;) {
    const low = value & 127;
    value >>= 7;
    const done = (value === 0 && (low & 64) === 0) || (value === -1 && (low & 64) !== 0);
    bytes.push(done ? low : low | 128);
    if (done) return bytes;
  }
}
function text(value: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(value));
  return unsigned(bytes.length).concat(bytes);
}
const section = (id: number, bytes: number[]) => [id].concat(unsigned(bytes.length), bytes);

/**
 * Original tiny command: `_start` never returns on its own. Each pass atomically bumps the
 * heartbeat word at address 0, then stores into every word of `pages` 64 KiB pages after it, in
 * its own exported shared memory. With `polling`, each pass first calls
 * `runtime_proc.signal(0, 4)`, which throws once the process is killed (docs/host-abi.md,
 * "Stop polling"); without it the loop makes no host call at all.
 */
export function stopOrderModule(pages: number, polling: boolean): Uint8Array<ArrayBuffer> {
  const words = pages * 16384;
  const poll = polling ? [0x41, 0, 0x41, 4, 0x10, 0, 0x1a] : [];
  const heartbeat = [0x41, 0, 0x41, 1, 0xfe, 0x1e, 2, 0, 0x1a];
  // i = 1; do { mem[i] = i; i++ } while (i < words)
  const fill = [0x41, 1, 0x21, 0, 0x03, 0x40, 0x20, 0, 0x41, 2, 0x74, 0x20, 0, 0x36, 2, 0].concat(
    [0x20, 0, 0x41, 1, 0x6a, 0x22, 0, 0x41],
    signed(words),
    [0x49, 0x0d, 0, 0x0b],
  );
  const body = [1, 1, 0x7f].concat([0x03, 0x40], poll, heartbeat, fill, [0x0c, 0, 0x0b, 0x0b]);
  const types = polling
    ? [2, 0x60, 2, 0x7f, 0x7f, 1, 0x7f, 0x60, 0, 0]
    : [1, 0x60, 0, 0];
  const imports = polling ? section(2, [1].concat(text("runtime_proc"), text("signal"), [0, 0])) : [];
  const start = polling ? 1 : 0;
  const size = unsigned(pages + 1);
  return new Uint8Array(
    [0, 97, 115, 109, 1, 0, 0, 0].concat(
      section(1, types),
      imports,
      section(3, [1, start]),
      section(5, [1, 3].concat(size, size)),
      section(7, [2].concat(text("memory"), [2, 0], text("_start"), [0, start])),
      section(10, [1].concat(unsigned(body.length), body)),
    ),
  );
}
