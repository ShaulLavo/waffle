// A real WASI preview1 guest that writes `size` patterned bytes to fd 1 with one fd_write,
// like CPython flushing its stdout buffer at exit. It exits 0 only when fd_write succeeded and
// reported exactly `size` bytes, 1 for a short count and 2 for an errno.
import { leb, section, text } from "./publication-wasm.js";

const DATA = 16;

function sleb(value: number): number[] {
  const bytes: number[] = [];
  for (;;) {
    const byte = value & 0x7f;
    value >>= 7;
    const done = (value === 0 && !(byte & 0x40)) || (value === -1 && byte & 0x40);
    bytes.push(done ? byte : byte | 0x80);
    if (done) return bytes;
  }
}

/** "0123456789" repeated, the payload of the Shell Python stdout case. */
export function writePattern(size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, index) => 48 + (index % 10));
}

export function wasiWrite(size: number): Uint8Array {
  const i32 = (value: number) => [0x41].concat(sleb(value));
  const body = [0].concat(
    // iovec {DATA, size} at 0; fd_write(1, iovs=0, count=1, nwritten=8)
    i32(0),
    i32(DATA),
    [0x36, 2, 0],
    i32(4),
    i32(size),
    [0x36, 2, 0],
    i32(1),
    i32(0),
    i32(1),
    i32(8),
    [0x10, 0],
    [0x04, 0x40],
    i32(2),
    [0x10, 1],
    [0x0b],
    i32(8),
    [0x28, 2, 0],
    i32(size),
    [0x47, 0x10, 1, 0x0b],
  );
  const pages = Math.ceil((DATA + size) / 65536);
  const pattern = Array.from(writePattern(size));
  return Uint8Array.from(
    [0, 97, 115, 109, 1, 0, 0, 0].concat(
      // (i32 x4) -> i32, (i32) -> (), () -> ()
      section(1, [3, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f, 0x60, 1, 0x7f, 0, 0x60, 0, 0]),
      section(
        2,
        [2].concat(
          text("wasi_snapshot_preview1"),
          text("fd_write"),
          [0, 0],
          text("wasi_snapshot_preview1"),
          text("proc_exit"),
          [0, 1],
        ),
      ),
      section(3, [1, 2]),
      section(5, [1, 0].concat(leb(pages))),
      section(7, [2].concat(text("memory"), [2, 0], text("_start"), [0, 2])),
      section(10, [1].concat(leb(body.length), body)),
      section(11, [1, 0].concat(i32(DATA), [0x0b], leb(size), pattern)),
    ),
  );
}
