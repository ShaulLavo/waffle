// Original Wasm fixture. Stores adapter-provided identity imports in guest memory.
const text = (value: string) => [value.length].concat(Array.from(new TextEncoder().encode(value)));
const section = (id: number, bytes: number[]) => [id, bytes.length].concat(bytes);
const imports = ["uid", "euid", "parent_pid", "hostname_byte"].flatMap((name) =>
  text("identity_fixture").concat(text(name), [0, name === "hostname_byte" ? 1 : 0]),
);
const body = [0].concat(
  [0, 1, 2].flatMap((index) => [65, index * 4, 16, index, 54, 2, 0]),
  [65, 12, 65, 0, 16, 3, 54, 2, 0, 11],
);
export const processContextGuest = new WebAssembly.Module(
  Uint8Array.from(
    [0, 97, 115, 109, 1, 0, 0, 0].concat(
      section(1, [3, 96, 0, 1, 127, 96, 1, 127, 1, 127, 96, 0, 0]),
      section(2, [4].concat(imports)),
      section(3, [1, 2]),
      section(5, [1, 0, 1]),
      section(7, [2].concat(text("memory"), [2, 0], text("_start"), [0, 4])),
      section(10, [1, body.length].concat(body)),
    ),
  ),
);
