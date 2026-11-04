import {
  guestModule,
  wait32,
  wait64,
  notify,
  i32,
  i64,
  call,
  store,
} from "./threads-guest-module.js";
const u32 = (value: number): number[] => {
  const result: number[] = [];
  do {
    const next = Math.floor(value / 128);
    result.push((value & 127) | (next ? 128 : 0));
    value = next;
  } while (value);
  return result;
};
const name = (value: string): number[] => {
  const bytes = Array.from(new TextEncoder().encode(value));
  return u32(bytes.length).concat(bytes);
};
const vector = (values: number[][]) => u32(values.length).concat(...values);
const section = (id: number, body: number[]) => [id].concat(u32(body.length), body);
const load = (address: number) => i32(address).concat([0x28, 2, 0]);
const checked = (code: number[]) => code.concat([0x04, 0x40, 0x00, 0x0b]);
/** A real ordinary Preview 1 guest waits on stdin, then writes, seeks and reads a file. */
export function runtimeSurvivorModule(): Uint8Array<ArrayBuffer> {
  const types = [
    [0x7f, 0x7f, 0x7f, 0x7f],
    [0x7f, 0x7f, 0x7f, 0x7f, 0x7f, 0x7e, 0x7e, 0x7f, 0x7f],
    [0x7f, 0x7e, 0x7f, 0x7f],
  ].map((params) => [0x60].concat(u32(params.length), params, [1, 0x7f]));
  types.push([0x60, 0, 0]);
  const imports = ["fd_read", "fd_write", "path_open", "fd_seek"].map((value, index) =>
    name("wasi_snapshot_preview1").concat(name(value), [0, index < 2 ? 0 : index - 1]),
  );
  const io = (fd: number[], index: number) => fd.concat(i32(0), i32(1), i32(24), call(index));
  const path = i32(3).concat(
    i32(0),
    i32(8),
    i32(8),
    i32(0),
    i64(102n),
    i64(0n),
    i32(0),
    i32(20),
    call(2),
  );
  const body = [0].concat(
    store(0, i32(64)),
    store(4, i32(1)),
    checked(io(i32(0), 0)),
    checked(path),
    store(64, i32(88)),
    checked(io(load(20), 1)),
    checked(load(20).concat(i64(0n), i32(0), i32(32), call(3))),
    store(0, i32(65)),
    checked(io(load(20), 0)),
    i32(65),
    [0x2d, 0, 0],
    i32(88),
    [0x47, 0x04, 0x40, 0, 0x0b, 0x0b],
  );
  const data = [0, 0x41, 8, 0x0b].concat(name("survivor"));
  return new Uint8Array(
    [0, 97, 115, 109, 1, 0, 0, 0].concat(
      section(1, vector(types)),
      section(2, vector(imports)),
      section(3, [1, 3]),
      section(5, [1, 1, 1, 1]),
      section(7, [2].concat(name("_start"), [0, 4], name("memory"), [2, 0])),
      section(10, [1].concat(u32(body.length), body)),
      section(11, [1].concat(data)),
    ),
  );
}

export function generatedRuntimeThreadModule(selected: string): Uint8Array<ArrayBuffer> {
  const spawn = { module: "wasi", name: "thread-spawn", params: [0x7f] };
  if (selected === "join")
    return guestModule({
      imports: [spawn, { name: "fd_write", params: [0x7f, 0x7f, 0x7f, 0x7f] }],
      initial: i32(0x12345678).concat(call(0), [0x1a], wait32(0)),
      secondary: store(256, i32(99)).concat(
        store(128, i32(256)),
        store(132, i32(1)),
        i32(1),
        i32(128),
        i32(1),
        i32(160),
        call(1),
        [0x1a],
        store(0, i32(1)),
        notify(0),
      ),
    });
  if (selected === "child-exit")
    return guestModule({
      imports: [spawn, { name: "proc_exit", params: [0x7f], result: false }],
      initial: i32(0).concat(call(0), [0x1a], wait64(0)),
      secondary: i32(0).concat(call(1)),
    });
  return guestModule({
    imports: [spawn],
    initial:
      selected === "cpu"
        ? [0x03, 0x40, 0x0c, 0, 0x0b]
        : selected === "wait32"
          ? wait32(0)
          : wait64(0),
  });
}
