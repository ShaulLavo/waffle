import { rewriteInterrupts } from "../../interrupt/rewriter.js";
import { declareModuleMemory } from "../../memory/declarations.js";
import type { ExecRequest } from "../../proc/types.js";

const encoder = new TextEncoder();
function leb(value: number): number[] {
  const bytes: number[] = [];
  do {
    const part = value & 127;
    value >>>= 7;
    bytes.push(part | (value ? 128 : 0));
  } while (value);
  return bytes;
}
function signed(value: number): number[] {
  const bytes: number[] = [];
  for (;;) {
    const part = value & 127;
    value >>= 7;
    const done = (value === 0 && !(part & 64)) || (value === -1 && !!(part & 64));
    bytes.push(part | (done ? 0 : 128));
    if (done) return bytes;
  }
}
const integer = (value: number) => [0x41].concat(signed(value));
const call = (index: number) => [0x10].concat(leb(index));
const text = (value: string) => {
  const bytes = Array.from(encoder.encode(value));
  return leb(bytes.length).concat(bytes);
};
const section = (id: number, bytes: number[]) => [id].concat(leb(bytes.length), bytes);
type Import = readonly [string, string, number];
function program(
  imports: readonly Import[],
  ops: number[],
  data: readonly [number, Uint8Array][],
  maximumPages: number,
  locals = 0,
): WebAssembly.Module {
  const types = Array.from({ length: 5 }, (_, count) =>
    [0x60, count].concat(Array<number>(count).fill(0x7f), [1, 0x7f]),
  );
  types.push(
    [0x60, 0, 0],
    [0x60, 9, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7e, 0x7e, 0x7f, 0x7f, 1, 0x7f],
  );
  const body = (locals ? [1, locals, 0x7f] : [0]).concat(ops, [0x0b]);
  const source = Uint8Array.from(
    [0, 97, 115, 109, 1, 0, 0, 0].concat(
      section(1, leb(types.length).concat(types.flat())),
      section(
        2,
        leb(imports.length).concat(
          imports.flatMap(([namespace, name, type]) =>
            text(namespace).concat(text(name), [0, type]),
          ),
        ),
      ),
      section(3, [1, 5]),
      section(5, [1, 1, 1].concat(leb(maximumPages))),
      section(7, [2].concat(text("memory"), [2, 0], text("_start"), [0], leb(imports.length))),
      section(10, [1].concat(leb(body.length), body)),
      section(
        11,
        leb(data.length).concat(
          data.flatMap(([offset, bytes]) =>
            [0].concat(integer(offset), [0x0b], leb(bytes.length), Array.from(bytes)),
          ),
        ),
      ),
    ),
  );
  const rewritten = rewriteInterrupts(source);
  const module = new WebAssembly.Module(rewritten);
  declareModuleMemory(module, rewritten);
  return module;
}
const equals = (actual: number[], expected: number) =>
  actual.concat(integer(expected), [0x47, 0x04, 0x40, 0, 0x0b]);
const load = (address: number) => integer(address).concat([0x28, 2, 0]);
const store = (address: number, value: number[]) => integer(address).concat(value, [0x36, 2, 0]);
function equalText(offset: number, value: string): number[] {
  return Array.from(encoder.encode(value), (byte, index) =>
    equals(integer(offset + index).concat([0x2d, 0, 0]), byte),
  ).flat();
}

export function execCallerGuest(
  request: ExecRequest,
  control = false,
  maximumPages = 64,
  openFile = false,
): WebAssembly.Module {
  const json = encoder.encode(JSON.stringify(control ? { ...request, job: -1 } : request));
  if (openFile) {
    const ops = equals(
      integer(3).concat(
        integer(0),
        integer(4200),
        integer(9),
        integer(0),
        [0x42, 2, 0x42, 0],
        integer(0),
        integer(900),
        call(1),
      ),
      0,
    ).concat(
      equals(load(900), 0),
      store(944, integer(4800)),
      store(948, integer(2)),
      equals(load(900).concat(integer(944), integer(1), integer(960), call(2)), 0),
      equals(load(960), 2),
      equalText(4800, "ke"),
      equals(load(900).concat(call(3)), 4),
      integer(1024),
      integer(json.length),
      call(0),
      [0],
    );
    return program(
      [
        ["runtime_proc", "exec", 2],
        ["wasi_snapshot_preview1", "path_open", 6],
        ["wasi_snapshot_preview1", "fd_read", 4],
        ["runtime_proc", "dup", 1],
      ],
      ops,
      [
        [1024, json],
        [4200, encoder.encode("exec-file")],
      ],
      maximumPages,
    );
  }
  if (!control)
    return program(
      [["runtime_proc", "exec", 2]],
      integer(1024).concat(integer(json.length), call(0), [0]),
      [[1024, json]],
      maximumPages,
    );
  const ops = integer(1024).concat(
    integer(json.length),
    call(0),
    [0x21, 0],
    store(64, integer(6)),
    store(68, [0x20, 0]),
    integer(64),
    integer(1),
    integer(-1),
    integer(96),
    call(1),
    [0x1a],
    equals([0x20, 0].concat(call(2)), 48),
  );
  return program(
    [
      ["runtime_proc", "spawn", 2],
      ["runtime_proc", "poll", 4],
      ["runtime_proc", "start_status", 1],
    ],
    ops,
    [[1024, json]],
    maximumPages,
    1,
  );
}

export function execTargetGuest(
  pid: number,
  request: ExecRequest,
  preservePreopen = true,
): WebAssembly.Module {
  const argv = request.argv.join("\0") + "\0";
  const env = Object.entries(request.env)
    .map(([key, value]) => `${key}=${value}\0`)
    .join("");
  const output = encoder.encode("exec-ok\n");
  const ops = equals(call(0), pid).concat(
    equals(integer(9).concat(call(2)), -8),
    equals(integer(0).concat(call(2)), -8),
    equals(integer(2).concat(call(2)), -8),
    equals(integer(3).concat(call(2)), preservePreopen ? 4 : -8),
    equals(integer(4).concat(call(2)), -8),
    equals(integer(1).concat(call(2)), 2),
    equals(integer(0).concat(integer(4), call(4)), 0),
    equals(load(0), request.argv.length),
    equals(integer(16).concat(integer(128), call(3)), 0),
    equalText(128, argv),
    equals(integer(0).concat(integer(4), call(6)), 0),
    equals(load(0), Object.keys(request.env).length),
    equals(integer(16).concat(integer(256), call(5)), 0),
    equalText(256, env),
    equals(integer(512).concat(integer(128), call(1)), encoder.encode(request.cwd).length),
    equalText(512, request.cwd),
    store(768, integer(4096)),
    store(772, integer(output.length)),
    equals(integer(1).concat(integer(768), integer(1), integer(800), call(7)), 0),
    equals(load(800), output.length),
    request.fds.some((binding) => binding.child === 7)
      ? equals(integer(7).concat(call(2)), 3).concat(
          equals(integer(11).concat(call(2)), 3),
          store(944, integer(4800)),
          store(948, integer(2)),
          equals(integer(7).concat(integer(944), integer(1), integer(960), call(11)), 0),
          equals(load(960), 2),
          equalText(4800, "pt"),
          equals(integer(11).concat(integer(944), integer(1), integer(960), call(11)), 0),
          equals(load(960), 0),
        )
      : [],
    equals(integer(3).concat(integer(900), call(8)), preservePreopen ? 0 : 8),
    preservePreopen
      ? equals(load(904), 1).concat(
          equals(integer(3).concat(integer(920), integer(1), call(9)), 0),
          equalText(920, "/"),
          equals(
            integer(3).concat(
              integer(0),
              integer(4200),
              integer(9),
              integer(0),
              [0x42, 2, 0x42, 0],
              integer(0),
              integer(940),
              call(10),
            ),
            0,
          ),
          store(944, integer(4800)),
          store(948, integer(4)),
          equals(load(940).concat(integer(944), integer(1), integer(960), call(11)), 0),
          equals(load(960), 4),
          equalText(4800, "kept"),
        )
      : equals(
          integer(3).concat(
            integer(0),
            integer(4200),
            integer(9),
            integer(0),
            [0x42, 2, 0x42, 0],
            integer(0),
            integer(940),
            call(10),
          ),
          8,
        ),
  );
  return program(
    [
      ["runtime_proc", "getpid", 0],
      ["runtime_proc", "cwd", 2],
      ["runtime_proc", "fd_kind", 1],
      ["wasi_snapshot_preview1", "args_get", 2],
      ["wasi_snapshot_preview1", "args_sizes_get", 2],
      ["wasi_snapshot_preview1", "environ_get", 2],
      ["wasi_snapshot_preview1", "environ_sizes_get", 2],
      ["wasi_snapshot_preview1", "fd_write", 4],
      ["wasi_snapshot_preview1", "fd_prestat_get", 2],
      ["wasi_snapshot_preview1", "fd_prestat_dir_name", 3],
      ["wasi_snapshot_preview1", "path_open", 6],
      ["wasi_snapshot_preview1", "fd_read", 4],
    ],
    ops,
    [
      [4096, output],
      [4200, encoder.encode("exec-file")],
    ],
    64,
  );
}
