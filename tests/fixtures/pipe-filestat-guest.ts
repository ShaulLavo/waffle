const encoder = new TextEncoder();
const metadata = 1n << 21n;
const poll = 1n << 27n;
export const pipeReadRights = (1n << 1n) | metadata | poll;
export const pipeWriteRights = (1n << 6n) | metadata | poll;

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

type GuestImport = readonly [string, string, number];

/** Real preview1 guest imports share runtime_proc's fd namespace and exported memory. */
export function pipeFilestatModule(): WebAssembly.Module {
  return descriptorModule([
    ["runtime_proc", "pipe", 0],
    ["runtime_proc", "spawn", 1],
    ["runtime_proc", "fd_kind", 0],
    ["runtime_proc", "dup", 0],
    ["wasi_snapshot_preview1", "fd_filestat_get", 1],
    ["wasi_snapshot_preview1", "fd_fdstat_get", 1],
  ]);
}

export function fdKindModule(): WebAssembly.Module {
  return descriptorModule([["runtime_proc", "fd_kind", 0]]);
}

function descriptorModule(imports: readonly GuestImport[]): WebAssembly.Module {
  const exports = imports.flatMap(([, name], index) => text(name).concat([0, index]));
  const types = [3, 0x60, 1, 0x7f, 1, 0x7f, 0x60, 2, 0x7f, 0x7f, 1, 0x7f, 0x60, 0, 0];
  return new WebAssembly.Module(
    Uint8Array.from(
      [0, 97, 115, 109, 1, 0, 0, 0].concat(
        section(1, types),
        section(
          2,
          leb(imports.length).concat(
            imports.flatMap(([namespace, name, type]) =>
              text(namespace).concat(text(name), [0, type]),
            ),
          ),
        ),
        section(3, [1, 2]),
        section(5, [1, 0, 1]),
        section(
          7,
          leb(imports.length + 2).concat(exports, text("memory"), [2, 0], text("_start"), [
            0,
            imports.length,
          ]),
        ),
        section(10, [1, 2, 0, 0x0b]),
      ),
    ),
  );
}

export type PipeFilestatGuest = {
  memory: WebAssembly.Memory;
  pipe(ptr: number): number;
  fd_kind(fd: number): number;
  dup(fd: number): number;
  spawn(ptr: number, length: number): number;
  fd_filestat_get(fd: number, ptr: number): number;
  fd_fdstat_get(fd: number, ptr: number): number;
};

export function assertPipeFilestat(guest: PipeFilestatGuest, fd: number, rights: bigint): void {
  if (guest.fd_kind(fd) !== 1) throw new Error(`pipe fd ${fd}: fd_kind must return PIPE`);
  const bytes = new Uint8Array(guest.memory.buffer);
  bytes.fill(0xa5, 256, 344);
  const statError = guest.fd_filestat_get(fd, 256);
  if (statError !== 0) throw new Error(`pipe fd ${fd}: fd_filestat_get returned ${statError}`);
  const view = new DataView(guest.memory.buffer);
  if (view.getUint8(272) !== 0) throw new Error("pipe filestat must use preview1 UNKNOWN");
  for (const offset of [0, 8, 32, 40, 48, 56]) {
    if (view.getBigUint64(256 + offset, true) !== 0n)
      throw new Error(`pipe filestat field ${offset} must be zero`);
  }
  if (view.getBigUint64(280, true) !== 1n) throw new Error("pipe nlink must be one");
  if (guest.fd_fdstat_get(fd, 320) !== 0) throw new Error("pipe fdstat failed");
  if (
    view.getUint8(320) !== 0 ||
    view.getBigUint64(328, true) !== rights ||
    view.getBigUint64(336, true) !== 0n
  )
    throw new Error("pipe fdstat type or exact rights changed");
}
