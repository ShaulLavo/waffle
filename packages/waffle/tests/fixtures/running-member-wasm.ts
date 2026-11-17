function unsigned(value: number): number[] {
  const bytes: number[] = [];
  do {
    const next = Math.floor(value / 128);
    bytes.push((value & 127) | (next ? 128 : 0));
    value = next;
  } while (value);
  return bytes;
}
function text(value: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(value));
  return unsigned(bytes.length).concat(bytes);
}
const section = (id: number, bytes: number[]) => [id].concat(unsigned(bytes.length), bytes);

/**
 * Original tiny module: `spin(base, words, marker)` makes no host call and never returns.
 * Each pass atomically bumps the heartbeat word at `base`, then stores `marker` into words
 * 1..words-1 after it. It imports a shared memory with the wasm32 maximum, so it links
 * against any group memory. With `polling`, it also imports `env.checkpoint` and calls it at
 * the top of each pass, returning once it is non-zero, like a link-loader checkpoint.
 */
export function runningMemberModule(polling = false): Uint8Array<ArrayBuffer> {
  const heartbeat = [0x20, 0, 0x41, 1, 0xfe, 0x1e, 2, 0, 0x1a];
  const fill = [0x03, 0x40, 0x20, 0, 0x20, 3, 0x41, 2, 0x74, 0x6a, 0x20, 2, 0x36, 2, 0].concat([
    0x20, 3, 0x41, 1, 0x6a, 0x22, 3, 0x20, 1, 0x49, 0x0d, 0, 0x0b,
  ]);
  // call checkpoint; br_if 1 (out of the pass loop, which returns from spin)
  const poll = polling ? [0x10, 0, 0x0d, 1] : [];
  const body = [1, 1, 0x7f].concat(
    [0x03, 0x40],
    poll,
    heartbeat,
    [0x41, 1, 0x21, 3],
    fill,
    [0x0c, 0, 0x0b, 0x0b],
  );
  const memory = text("env").concat(text("memory"), [2, 3, 1], unsigned(65536));
  const types = polling
    ? [2, 0x60, 3, 0x7f, 0x7f, 0x7f, 0, 0x60, 0, 1, 0x7f]
    : [1, 0x60, 3, 0x7f, 0x7f, 0x7f, 0];
  const imports = polling
    ? [2].concat(memory, text("env"), text("checkpoint"), [0, 1])
    : [1].concat(memory);
  const spinIndex = polling ? 1 : 0;
  return new Uint8Array(
    [0, 97, 115, 109, 1, 0, 0, 0].concat(
      section(1, types),
      section(2, imports),
      section(3, [1, 0]),
      section(7, [1].concat(text("spin"), [0, spinIndex])),
      section(10, [1].concat(unsigned(body.length), body)),
    ),
  );
}
