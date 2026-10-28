// A real WASI preview1 `cat FILE`: reads argv, opens FILE under the root preopen (fd 3) with
// path_open, then copies it to fd 1 with fd_read/fd_write. Exit 2 on usage, 1 on I/O errors.
function uleb(value: number): number[] {
  const bytes: number[] = [];
  do {
    const byte = value & 0x7f;
    value >>>= 7;
    bytes.push(value ? byte | 0x80 : byte);
  } while (value);
  return bytes;
}
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
function name(text: string): number[] {
  const bytes = Array.from(new TextEncoder().encode(text));
  return uleb(bytes.length).concat(bytes);
}
function vector(items: number[][]): number[] {
  return uleb(items.length).concat(items.flat());
}
function section(id: number, payload: number[]): number[] {
  return [id].concat(uleb(payload.length), payload);
}

const i32 = 0x7f,
  i64 = 0x7e;
const op = {
  block: [0x02, 0x40],
  loop: [0x03, 0x40],
  if: [0x04, 0x40],
  end: [0x0b],
  br: (depth: number) => [0x0c, depth],
  brIf: (depth: number) => [0x0d, depth],
  call: (index: number) => [0x10, index],
  drop: [0x1a],
  get: (local: number) => [0x20, local],
  set: (local: number) => [0x21, local],
  load: [0x28, 2, 0],
  load8: [0x2d, 0, 0],
  store: [0x36, 2, 0],
  i32: (value: number) => [0x41].concat(sleb(value)),
  i64: (value: number) => [0x42].concat(sleb(value)),
  eqz: [0x45],
  ne: [0x47],
  add: [0x6a],
  sub: [0x6b],
};
const [argsSizes, argsGet, pathOpen, fdRead, fdWrite, procExit] = [0, 1, 2, 3, 4, 5];
const [path, length, fd] = [0, 1, 2];
const exitWith = (code: number) => op.if.concat(op.i32(code), op.call(procExit), op.end);
const load = (address: number) => op.i32(address).concat(op.load);
const store = (address: number, value: number[]) => op.i32(address).concat(value, op.store);

// Memory: argc@0, argv buffer size@4, opened fd@8, argv pointers@16, argv strings@1024,
// read iovec@32, byte count@40, write iovec@48, data@4096.
const body = [
  op.i32(0),
  op.i32(4),
  op.call(argsSizes),
  op.drop,
  op.i32(16),
  op.i32(1024),
  op.call(argsGet),
  op.drop,
  load(0),
  op.i32(2),
  op.ne,
  exitWith(2),
  load(20),
  op.set(path),
  op.i32(1024),
  load(4),
  op.add,
  op.get(path),
  op.sub,
  op.i32(1),
  op.sub,
  op.set(length),
  // Paths are opened relative to the "/" preopen, so drop leading slashes.
  op.block,
  op.loop,
  op.get(path),
  op.load8,
  op.i32(47),
  op.ne,
  op.brIf(1),
  op.get(path),
  op.i32(1),
  op.add,
  op.set(path),
  op.get(length),
  op.i32(1),
  op.sub,
  op.set(length),
  op.br(0),
  op.end,
  op.end,
  op.i32(3),
  op.i32(0),
  op.get(path),
  op.get(length),
  op.i32(0),
  op.i64(2),
  op.i64(0),
  op.i32(0),
  op.i32(8),
  op.call(pathOpen),
  exitWith(1),
  load(8),
  op.set(fd),
  store(32, op.i32(4096)),
  store(36, op.i32(4096)),
  op.block,
  op.loop,
  op.get(fd),
  op.i32(32),
  op.i32(1),
  op.i32(40),
  op.call(fdRead),
  exitWith(1),
  load(40),
  op.eqz,
  op.brIf(1),
  store(48, op.i32(4096)),
  store(52, load(40)),
  op.i32(1),
  op.i32(48),
  op.i32(1),
  op.i32(44),
  op.call(fdWrite),
  exitWith(1),
  op.br(0),
  op.end,
  op.end,
  op.end,
].flat();

const types = [
  [0x60, 2, i32, i32, 1, i32],
  [0x60, 9, i32, i32, i32, i32, i32, i64, i64, i32, i32, 1, i32],
  [0x60, 4, i32, i32, i32, i32, 1, i32],
  [0x60, 1, i32, 0],
  [0x60, 0, 0],
];
const imports = (
  [
    ["args_sizes_get", 0],
    ["args_get", 0],
    ["path_open", 1],
    ["fd_read", 2],
    ["fd_write", 2],
    ["proc_exit", 3],
  ] as const
).map(([field, type]) => name("wasi_snapshot_preview1").concat(name(field), [0, type]));
const code = [1, 3, i32].concat(body);

/** Encoded once per call so each caller owns its bytes. */
export function wasiCat(): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0].concat(
      section(1, vector(types)),
      section(2, vector(imports)),
      section(3, vector([[4]])),
      section(5, vector([[0, 1]])),
      section(7, vector([name("memory").concat([2, 0]), name("_start").concat([0, 6])])),
      section(10, vector([uleb(code.length).concat(code)])),
    ),
  );
}
