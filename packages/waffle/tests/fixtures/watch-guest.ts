function text(value: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(value));
  return [bytes.length].concat(bytes);
}
function section(id: number, payload: number[]): number[] {
  if (payload.length >= 128) throw new Error("fixture section must fit one-byte LEB");
  return [id, payload.length].concat(payload);
}
const I32 = 0x7f;

/** Imports runtime_fs.watch_open/read/close and re-exports them with its memory. */
export function watchGuestModule(shared = false): WebAssembly.Module {
  const imports = [3].concat(
    text("runtime_fs"),
    text("watch_open"),
    [0, 0],
    text("runtime_fs"),
    text("watch_read"),
    [0, 1],
    text("runtime_fs"),
    text("watch_close"),
    [0, 2],
  );
  const exports = [5].concat(
    text("memory"),
    [2, 0],
    text("watch_open"),
    [0, 0],
    text("watch_read"),
    [0, 1],
    text("watch_close"),
    [0, 2],
    text("_start"),
    [0, 3],
  );
  return new WebAssembly.Module(
    Uint8Array.from(
      [0, 97, 115, 109, 1, 0, 0, 0].concat(
        section(
          1,
          [4, 0x60, 3, I32, I32, I32, 1, I32, 0x60, 4, I32, I32, I32, I32, 1, I32].concat([
            0x60,
            1,
            I32,
            1,
            I32,
            0x60,
            0,
            0,
          ]),
        ),
        section(2, imports),
        section(3, [1, 3]),
        section(5, shared ? [1, 3, 1, 2] : [1, 0, 1]),
        section(7, exports),
        section(10, [1, 2, 0, 0x0b]),
      ),
    ),
  );
}

export interface WatchRecord {
  readonly type: number;
  readonly name: string | null;
}

/** Decode whole records; fails on a malformed stride, padding or reserved byte. */
function decodeRecords(bytes: Uint8Array): WatchRecord[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const records: WatchRecord[] = [];
  let at = 0;
  while (at < bytes.length) {
    if (view.getUint8(at + 1) || view.getUint16(at + 2, true)) throw new Error("reserved bytes");
    const length = view.getUint32(at + 4, true);
    const size = length === 0xffffffff ? 0 : length;
    const name =
      length === 0xffffffff ? null : decoder.decode(bytes.subarray(at + 8, at + 8 + size));
    for (let pad = at + 8 + size; pad < at + 8 + ((size + 3) & ~3); pad++)
      if (bytes[pad]) throw new Error("nonzero padding");
    records.push({ type: view.getUint8(at), name });
    at += 8 + ((size + 3) & ~3);
  }
  if (at !== bytes.length) throw new Error("partial record");
  return records;
}

const OUT = 16;
const BUFFER = 1024;
const EAGAIN = 6;

/** Calls the guest's exported runtime_fs functions through the WebAssembly boundary. */
export function watchGuest(instance: WebAssembly.Instance) {
  const { memory, watch_open, watch_read, watch_close } = instance.exports;
  if (
    !(memory instanceof WebAssembly.Memory) ||
    typeof watch_open !== "function" ||
    typeof watch_read !== "function" ||
    typeof watch_close !== "function"
  )
    throw new Error("invalid watch guest");
  const word = (at: number) =>
    at + 4 <= memory.buffer.byteLength ? new DataView(memory.buffer).getUint32(at, true) : 0;
  const open = (fd: number, flags = 0, out = OUT) => {
    const errno = Number(watch_open(fd, flags, out));
    return { errno, id: errno ? 0 : word(out) };
  };
  const read = (id: number, length = 60000, buffer = BUFFER, out = OUT) => {
    if (out + 4 <= memory.buffer.byteLength)
      new DataView(memory.buffer).setUint32(out, 0xdeadbeef, true);
    const errno = Number(watch_read(id, buffer, length, out));
    const size = word(out);
    const records =
      errno === 0 ? decodeRecords(new Uint8Array(memory.buffer, buffer, size).slice()) : [];
    return { errno, length: size, records };
  };
  /** Consecutive reads until EAGAIN or end, as a Bun watch waiter steps. */
  const drain = (id: number) => {
    let records: WatchRecord[] = [];
    for (;;) {
      const result = read(id);
      if (result.errno === EAGAIN) return { errno: 0, ended: false, records };
      if (result.errno) return { errno: result.errno, ended: false, records };
      if (!result.length) return { errno: 0, ended: true, records };
      records = records.concat(result.records);
    }
  };
  const close = (id: number) => Number(watch_close(id));
  return { memory, open, read, drain, close };
}
