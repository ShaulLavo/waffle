import { Wasi, WasiExit } from "../../core/wasi.js";
import { MemFS } from "../../fs/memory.js";
import { PipeController } from "../../proc/pipes.js";
import { leb, text, section } from "./publication-wasm.js";

const native = globalThis.WebAssembly;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const all = (1n << 29n) - 1n;
const page = 65536;
const signatures = [
  { name: "fd_read", parameters: [127, 127, 127, 127] },
  { name: "fd_write", parameters: [127, 127, 127, 127] },
  { name: "fd_close", parameters: [127] },
  { name: "path_open", parameters: [127, 127, 127, 127, 127, 126, 126, 127, 127] },
  { name: "proc_exit", parameters: [127], exits: true },
];

function module(shared: boolean): WebAssembly.Module {
  const types = signatures.flatMap(({ parameters, exits }) =>
    [96, parameters.length].concat(parameters, exits ? [0] : [1, 127]),
  );
  const imports = signatures.flatMap(({ name }, index) =>
    text("wasi_snapshot_preview1").concat(text(name), [0, index]),
  );
  const exports = signatures.flatMap(({ name }, index) =>
    text(name).concat([0, signatures.length + index]),
  );
  const bodies = signatures.flatMap(({ parameters }, index) => {
    const args = parameters.flatMap((_type, parameter) => [32, parameter]);
    const body = [0].concat(args, [16, index, 11]);
    return leb(body.length).concat(body);
  });
  return new native.Module(
    Uint8Array.from(
      [0, 97, 115, 109, 1, 0, 0, 0].concat(
        section(1, [signatures.length + 2].concat(types, [96, 0, 0, 96, 1, 127, 1, 127])),
        section(
          2,
          [signatures.length + 1].concat(imports, text("env"), text("memory"), [
            2,
            shared ? 3 : 1,
            4,
            8,
          ]),
        ),
        section(
          3,
          [signatures.length + 2].concat(
            signatures.map((_entry, index) => index),
            [signatures.length, signatures.length + 1],
          ),
        ),
        section(
          7,
          [signatures.length + 3].concat(
            exports,
            text("memory"),
            [2, 0],
            text("_start"),
            [0, signatures.length * 2],
            text("grow"),
            [0, signatures.length * 2 + 1],
          ),
        ),
        section(10, [signatures.length + 2].concat(bodies, [2, 0, 11, 6, 0, 32, 0, 64, 0, 11])),
      ),
    ),
  );
}
function equal(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected)
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}
function exit(instance: WebAssembly.Instance, code: number): number {
  const fn = instance.exports.proc_exit;
  if (typeof fn !== "function") throw new Error("missing proc_exit export");
  try {
    fn(code);
  } catch (error) {
    if (error instanceof WasiExit) return error.code;
    throw error;
  }
  throw new Error("proc_exit returned without exiting");
}
function context(fs: MemFS, shared: boolean, diagnostics: string[]) {
  const memory = new native.Memory({ initial: 4, maximum: 8, shared });
  const guestModule = module(shared);
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens: { "/": "/" },
    namespaces: { env: { memory } },
    stdout() {},
    stderr: (bytes) => diagnostics.push(decoder.decode(bytes)),
    sleep() {},
  });
  let instance: WebAssembly.Instance;
  try {
    const imports = wasi.imports(guestModule);
    equal(imports.env?.memory, memory, "native memory import identity");
    instance = new native.Instance(guestModule, imports);
    equal(instance.exports.memory, memory, "native memory export identity");
    equal(wasi.start(instance), 0, "initial entry");
  } catch (error) {
    wasi.descriptors.dispose();
    throw error;
  }
  const call = (name: string, ...args: (number | bigint)[]): number => {
    const fn = instance.exports[name];
    if (typeof fn !== "function") throw new Error(`missing Wasm export ${name}`);
    const result: unknown = fn(...args);
    if (typeof result !== "number") throw new Error(`invalid result from ${name}`);
    return result;
  };
  const bytes = () => new Uint8Array(memory.buffer);
  const view = () => new DataView(memory.buffer);
  const put = (value: string, at: number) => {
    const data = encoder.encode(value);
    bytes().set(data, at);
    return data.length;
  };
  const open = (name: string, at = 256) => {
    equal(call("path_open", 3, 0, at, put(name, at), 0, all, 0n, 0, at + 128), 0, "path_open");
    return view().getUint32(at + 128, true);
  };
  const io = (operation: "fd_read" | "fd_write", fd: number, at: number, length: number) => {
    view().setUint32(at, at + 64, true);
    view().setUint32(at + 4, length, true);
    equal(call(operation, fd, at, 1, at + 8), 0, operation);
    return view().getUint32(at + 8, true);
  };
  return { wasi, memory, instance, call, bytes, view, put, open, io };
}

export function nestedWasi(shared: boolean): void {
  const fs = new MemFS();
  fs.writeFile("/input", "abcdef");
  fs.writeFile("/nested", "nested-file");
  const diagnostics: string[] = [];
  const input = new PipeController({ capacity: 256, relay: "manual" });
  const output = new PipeController({ capacity: 256, relay: "manual" });
  const stdin = input.retain(1, "read"),
    feeder = input.retain(2, "write");
  const stdout = output.retain(1, "write"),
    reader = output.retain(2, "read");
  let outer: ReturnType<typeof context> | undefined;
  let nested: ReturnType<typeof context> | undefined;
  try {
    outer = context(fs, false, diagnostics);
    outer.wasi.descriptors.openAt(10, stdin, all, 0n);
    outer.wasi.descriptors.inherit(0, outer.wasi.descriptors.get(10)!);
    outer.wasi.descriptors.close(10);
    outer.wasi.descriptors.openAt(10, stdout, all, 0n);
    outer.wasi.descriptors.inherit(1, outer.wasi.descriptors.get(10)!);
    outer.wasi.descriptors.inherit(2, outer.wasi.descriptors.get(10)!);
    outer.wasi.descriptors.close(10);
    const file = outer.open("input");
    equal(outer.io("fd_read", file, 512, 2), 2, "outer initial file count");
    equal(decoder.decode(outer.bytes().slice(576, 578)), "ab", "outer initial file bytes");
    outer.bytes().fill(0xa5, 1024, 1152);
    nested = context(fs, shared, diagnostics);
    equal(nested.memory instanceof native.Memory, true, "native provider");
    equal(nested.memory.buffer instanceof SharedArrayBuffer, shared, "shared memory selection");
    const outerStdin = outer.wasi.descriptors.get(0)!;
    const outerStdout = outer.wasi.descriptors.get(1)!;
    for (const fd of [0, 1, 2])
      nested.wasi.descriptors.inherit(fd, outer.wasi.descriptors.get(fd)!);
    nested.wasi.descriptors.inherit(9, outer.wasi.descriptors.get(file)!);
    equal(nested.io("fd_read", 9, 1024, 2), 2, "nested shared-offset count");
    equal(decoder.decode(nested.bytes().slice(1088, 1090)), "cd", "nested shared-offset bytes");
    equal(
      outer
        .bytes()
        .slice(1024, 1152)
        .every((byte) => byte === 0xa5),
      true,
      "outer memory isolation",
    );
    const oldBuffer = nested.memory.buffer;
    const tracksGrowth = Reflect.get(oldBuffer, shared ? "growable" : "resizable") === true;
    equal(nested.call("grow", 0), 4, "zero-page growth");
    equal(
      nested.call("fd_close", nested.open("nested", 1024)),
      0,
      "filesystem I/O after zero-page growth",
    );
    equal(nested.call("grow", 1), 4, "one-page growth");
    equal(nested.memory.buffer.byteLength, 5 * page, "grown memory length");
    equal(
      oldBuffer.byteLength,
      tracksGrowth ? 5 * page : shared ? 4 * page : 0,
      "old buffer lifetime",
    );
    const at = 4 * page + 128;
    equal(feeder.tryWrite([encoder.encode("stdin")]), 5, "feed real pipe");
    equal(nested.io("fd_read", 0, at, 5), 5, "grown stdin count");
    equal(decoder.decode(nested.bytes().slice(at + 64, at + 69)), "stdin", "grown stdin bytes");
    equal(nested.io("fd_write", 1, at, 5), 5, "grown stdout count");
    equal(nested.io("fd_write", 2, at, 5), 5, "grown stderr count");
    const nestedFile = nested.open("nested", at);
    equal(nestedFile, file, "descriptor numbers belong to each WASI context");
    equal(nested.io("fd_read", nestedFile, at, 11), 11, "grown file count");
    equal(
      decoder.decode(nested.bytes().slice(at + 64, at + 75)),
      "nested-file",
      "grown file bytes",
    );
    nested.put("nested-edit", at + 64);
    equal(nested.io("fd_write", nestedFile, at, 11), 11, "grown file write count");
    equal(
      decoder.decode(fs.readFile("/nested")),
      "nested-filenested-edit",
      "actual filesystem bytes",
    );
    equal(nested.call("fd_close", nestedFile), 0, "nested file close");
    equal(nested.call("fd_close", nestedFile), 8, "closed descriptor error");
    equal(nested.call("grow", 4), -1, "maximum growth rejection");
    equal(nested.memory.buffer.byteLength, 5 * page, "failed growth preserves memory");
    equal(exit(nested.instance, 23), 23, "nested proc_exit");
    equal(nested.wasi.descriptors.get(3), undefined, "nested preopen released");
    equal(nested.call("fd_write", 1, at, 1, at + 8), 8, "exited nested stdout is closed");
    equal(outer.wasi.descriptors.get(0), outerStdin, "outer stdin binding survives");
    equal(outer.wasi.descriptors.get(1), outerStdout, "outer stdout binding survives");
    equal(outerStdin.description.references, 1, "outer stdin retains ownership");
    equal(outerStdout.description.references, 2, "outer stdout and stderr retain ownership");
    equal(outer.io("fd_read", file, 512, 2), 2, "outer file count after nested exit");
    equal(decoder.decode(outer.bytes().slice(576, 578)), "ef", "outer shared offset survives");
    equal(feeder.tryWrite([encoder.encode("outer")]), 5, "outer feed after nested exit");
    equal(outer.io("fd_read", 0, 512, 5), 5, "outer stdin after nested exit");
    equal(outer.io("fd_write", 1, 512, 5), 5, "outer stdout after nested exit");
    const received = new Uint8Array(15);
    let total = 0;
    for (let attempt = 0; total < received.length && attempt < received.length; attempt++) {
      const count = reader.tryRead([received.subarray(total)]);
      equal(count > 0, true, "actual pipe read makes progress");
      total += count;
    }
    equal(total, 15, "actual pipe output count");
    equal(decoder.decode(received.slice(0, 15)), "stdinstdinouter", "actual pipe output bytes");
    const reopened = outer.open("nested");
    equal(outer.io("fd_read", reopened, 512, 22), 22, "outer preopen remains usable");
    equal(
      decoder.decode(outer.bytes().slice(576, 598)),
      "nested-filenested-edit",
      "outer sees nested file writes",
    );
    equal(diagnostics.length, 0, "unexpected WASI diagnostics");
  } finally {
    nested?.wasi.descriptors.dispose();
    outer?.wasi.descriptors.dispose();
    stdin.close();
    stdout.close();
    feeder.close();
    reader.close();
    input.dispose();
    output.dispose();
  }
}
