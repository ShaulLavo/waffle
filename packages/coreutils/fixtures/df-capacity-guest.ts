// A syscall-only guest, not an implementation of df or filesystem statistics.
const encoder = new TextEncoder();
function leb(value: number): number[] {
  const result: number[] = [];
  do {
    result.push((value & 127) | (value > 127 ? 128 : 0));
    value >>>= 7;
  } while (value);
  return result;
}
function text(value: string): number[] {
  const bytes = Array.from(encoder.encode(value));
  return leb(bytes.length).concat(bytes);
}
function section(id: number, payload: number[]): number[] {
  return [id].concat(leb(payload.length), payload);
}
export function dfCapacityGuest(names = ["fd_filestat_get", "fd_prestat_get"]): WebAssembly.Module {
  const imports = names.flatMap((name) =>
    text("wasi_snapshot_preview1").concat(text(name), [0, 0]),
  );
  const exports = names.flatMap((name, index) => text(name).concat([0, index]));
  return new WebAssembly.Module(
    Uint8Array.from(
      [0, 97, 115, 109, 1, 0, 0, 0].concat(
        section(1, [2, 0x60, 2, 0x7f, 0x7f, 1, 0x7f, 0x60, 0, 0]),
        section(2, leb(names.length).concat(imports)),
        section(3, [1, 1]),
        section(5, [1, 0, 1]),
        section(
          7,
          leb(names.length + 2).concat(exports, text("memory"), [2, 0], text("_start"), [
            0,
            names.length,
          ]),
        ),
        section(10, [1, 2, 0, 0x0b]),
      ),
    ),
  );
}
