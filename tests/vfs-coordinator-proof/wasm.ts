const encoder = new TextEncoder();
const signatures = { path_open: "iiiiijjii", fd_write: "iiii", fd_read: "iiii", fd_close: "i", path_rename: "iiiiii" };
function leb(value: number): number[] {
  const bytes: number[] = [];
  do { const byte = value & 127; value >>>= 7; bytes.push(byte | (value ? 128 : 0)); } while (value);
  return bytes;
}
function string(value: string): number[] { return leb(value.length).concat(Array.from(encoder.encode(value))); }
function section(id: number, value: number[]): number[] { return [id].concat(leb(value.length), value); }
export function guestModule(): WebAssembly.Module {
  const entries = Object.entries(signatures);
  const types = entries.flatMap(([, signature]) => [0x60].concat(leb(signature.length), Array.from(signature, (type) => type === "j" ? 0x7e : 0x7f), [1, 0x7f]));
  const imports = entries.flatMap(([key], index) => string("wasi_snapshot_preview1").concat(string(key), [0], leb(index)));
  const exports = entries.flatMap(([key], index) => string(key).concat([0], leb(entries.length + index)));
  const bodies = entries.map(([, signature], index) => {
    const body = [0].concat(Array.from(signature, (_, parameter) => [0x20].concat(leb(parameter))).flat(), [0x10], leb(index), [0x0b]);
    return leb(body.length).concat(body);
  }).flat();
  return new WebAssembly.Module(Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0].concat(
    section(1, leb(entries.length + 1).concat(types, [0x60, 0, 0])),
    section(2, leb(entries.length).concat(imports)),
    section(3, leb(entries.length + 1).concat(entries.flatMap((_, index) => leb(index)), leb(entries.length))),
    section(5, [1, 0, 4]),
    section(7, leb(entries.length + 2).concat(exports, string("memory"), [2, 0], string("_start"), [0], leb(entries.length * 2))),
    section(10, leb(entries.length + 1).concat(bodies, [2, 0, 0x0b])),
  )));
}
