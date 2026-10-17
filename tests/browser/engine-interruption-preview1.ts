// Original byte-encoded Preview1 signal-only guest. No compiler or WASM build.
// Its runtime imports deliberately do not select the generic runtimeProcess route.
function unsigned(value: number): number[] {
  const result: number[] = [];
  do { const byte = value & 127; value >>>= 7; result.push(byte | (value ? 128 : 0)); } while (value);
  return result;
}
function signed(value: number): number[] {
  const result: number[] = [];
  for (;;) {
    const byte = value & 127; value >>= 7;
    const more = value !== (byte & 64 ? -1 : 0);
    result.push(byte | (more ? 128 : 0));
    if (!more) return result;
  }
}
const text = (value: string) => { const bytes = Array.from(new TextEncoder().encode(value)); return unsigned(bytes.length).concat(bytes); };
const section = (id: number, bytes: number[]) => [id].concat(unsigned(bytes.length), bytes);
const constant = (value: number) => [0x41].concat(signed(value));
const call = (index: number, ...args: number[][]) => args.flat().concat([0x10], unsigned(index));
const check = (value: number[], expected: number, stage: number) => value.concat(constant(expected), [0x47, 0x04, 0x40], call(4, constant(stage)), [0x00, 0x0b]);

export function preview1SignalClockGuest(): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(768), view = new DataView(data.buffer);
  view.setBigUint64(0, 1234n, true); // subscription userdata
  view.setUint32(16, 1, true); // monotonic clock, relative timeout
  view.setBigUint64(24, 5_000_000_000n, true);
  let pointer = 512;
  for (const [index, marker] of ["ready\n", "poll-eintr\n", "poll-clean\n"].entries()) {
    const bytes = new TextEncoder().encode(marker);
    view.setUint32(256 + index * 8, pointer, true);
    view.setUint32(260 + index * 8, bytes.length, true);
    data.set(bytes, pointer); pointer += bytes.length;
  }
  const write = (iov: number, stage: number) => check(call(2, constant(2), constant(iov), constant(1), constant(208)), 0, stage);
  const poll = () => call(3, constant(0), constant(128), constant(1), constant(200));
  const body = [0].concat(
    check(call(0, constant(2), constant(2)), 0, 101), write(256, 110),
    check(poll(), 27, 102), check(call(1), 2, 103), check(call(1), 0, 104), write(264, 111),
    // A consumed last signal must not leave EINTR stuck in the final empty wait.
    constant(24), [0x42], signed(10_000_000), [0x37, 3, 0],
    check(poll(), 0, 105), check(constant(200).concat([0x28, 2, 0]), 1, 106), write(272, 112),
    call(4, constant(23)), [0x0b],
  );
  const signature = (arity: number, result = true) => [0x60].concat(unsigned(arity), Array.from({ length: arity }, () => 0x7f), result ? [1, 0x7f] : [0]);
  const imports: [string, string, number][] = [
    ["runtime_proc", "signal", 0], ["runtime_proc", "interrupted", 1],
    ["wasi_snapshot_preview1", "fd_write", 2], ["wasi_snapshot_preview1", "poll_oneoff", 2],
    ["wasi_snapshot_preview1", "proc_exit", 3],
  ];
  return new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0].concat(
    section(1, [5].concat(signature(2), signature(0), signature(4), signature(1, false), signature(0, false))),
    section(2, unsigned(imports.length).concat(imports.flatMap(([namespace, name, type]) => text(namespace).concat(text(name), [0], unsigned(type))))),
    section(3, [1, 4]), section(5, [1, 0, 1]),
    section(7, [2].concat(text("memory"), [2, 0], text("_start"), [0, imports.length])),
    section(10, [1].concat(unsigned(body.length), body)),
    section(11, [1, 0, 0x41, 0, 0x0b].concat(unsigned(data.length), Array.from(data))),
  ));
}
