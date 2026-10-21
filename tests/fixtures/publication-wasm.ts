type ValueType = "i32" | "i64";
interface ImportSignature {
  readonly name: string;
  readonly parameters: readonly ValueType[];
}
const encoder = new TextEncoder();
function leb(value: number): number[] {
  const bytes: number[] = [];
  do {
    bytes.push((value & 127) | (value > 127 ? 128 : 0));
    value >>>= 7;
  } while (value);
  return bytes;
}
function text(value: string): number[] {
  const bytes = Array.from(encoder.encode(value));
  return leb(bytes.length).concat(bytes);
}
function section(id: number, payload: number[]): number[] {
  return [id].concat(leb(payload.length), payload);
}
/** Original local fixture. Every exported function has a real Wasm body that calls the
 * production import. Exporting an import directly would not exercise a guest call body. */
function moduleFor(namespace: string, signatures: readonly ImportSignature[]): WebAssembly.Module {
  const types = signatures.flatMap(({ parameters }) =>
    [0x60].concat(
      leb(parameters.length),
      Array.from(parameters, (type) => (type === "i64" ? 0x7e : 0x7f)),
      [1, 0x7f],
    ),
  );
  const imports = signatures.flatMap(({ name }, index) =>
    text(namespace).concat(text(name), [0], leb(index)),
  );
  const memoryImport = text("env").concat(text("memory"), [2, 0, 4]);
  const functions = signatures.flatMap((_signature, index) => leb(index));
  const exports = signatures.flatMap(({ name }, index) =>
    text(name).concat([0], leb(signatures.length + index)),
  );
  const bodies = signatures.flatMap(({ parameters }, index) => {
    const argumentsCode = parameters.flatMap((_type, parameter) => [0x20].concat(leb(parameter)));
    const body = [0].concat(argumentsCode, [0x10], leb(index), [0x0b]);
    return leb(body.length).concat(body);
  });
  return new WebAssembly.Module(
    Uint8Array.from(
      [0, 97, 115, 109, 1, 0, 0, 0].concat(
        section(1, leb(signatures.length + 1).concat(types, [0x60, 0, 0])),
        section(2, leb(signatures.length + 1).concat(imports, memoryImport)),
        section(3, leb(signatures.length + 1).concat(functions, leb(signatures.length))),
        section(
          7,
          leb(signatures.length + 2).concat(
            exports,
            text("memory"),
            [2, 0],
            text("_start"),
            [0],
            leb(signatures.length * 2),
          ),
        ),
        section(10, leb(signatures.length + 1).concat(bodies, [2, 0, 0x0b])),
      ),
    ),
  );
}
export function publicationWasiModule(): WebAssembly.Module {
  return moduleFor("wasi_snapshot_preview1", [
    { name: "fd_pwrite", parameters: ["i32", "i32", "i32", "i64", "i32"] },
    { name: "fd_write", parameters: ["i32", "i32", "i32", "i32"] },
    { name: "fd_read", parameters: ["i32", "i32", "i32", "i32"] },
    { name: "fd_tell", parameters: ["i32", "i32"] },
    { name: "fd_filestat_get", parameters: ["i32", "i32"] },
    { name: "path_open", parameters: ["i32", "i32", "i32", "i32", "i32", "i64", "i64", "i32", "i32"] },
    { name: "path_rename", parameters: ["i32", "i32", "i32", "i32", "i32", "i32"] },
    { name: "path_unlink_file", parameters: ["i32", "i32", "i32"] },
    { name: "fd_close", parameters: ["i32"] },
  ]);
}
export function publicationProcModule(): WebAssembly.Module {
  return moduleFor("runtime_proc", [
    { name: "read", parameters: ["i32", "i32", "i32"] },
    { name: "write", parameters: ["i32", "i32", "i32"] },
  ]);
}
export function guestFunction(
  instance: WebAssembly.Instance,
  name: string,
): (...args: (number | bigint)[]) => number {
  const value = instance.exports[name];
  if (typeof value !== "function") throw new Error(`missing Wasm export ${name}`);
  return (...args) => {
    const result: unknown = value(...args);
    if (typeof result !== "number") throw new Error(`invalid Wasm return from ${name}`);
    return result;
  };
}
