import { expect, spyOn, test } from "bun:test";
import { Wasi } from "../core/wasi.js";
import { MemFS } from "../fs/memory.js";

const encoder = new TextEncoder();
const ALL_RIGHTS = (1n << 29n) - 1n;
const O_CREAT = 1;
const O_TRUNC = 8;

function fixture() {
  const fs = new MemFS();
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens: { "/": "/" },
    stdout() {},
    stderr() {},
    sleep() {},
  });
  const memory = new WebAssembly.Memory({ initial: 1 });
  wasi.start({ exports: { memory, _start() {} } });
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const calls = wasi["functions"]();
  const open = (name: string, flags: number) => {
    const path = encoder.encode(name);
    bytes.set(path, 256);
    expect(calls.path_open(3, 1, 256, path.length, flags, ALL_RIGHTS, 0n, 0, 1024)).toBe(0);
    return view.getUint32(1024, true);
  };
  const size = (name: string) => fs.readFile(`/${name}`)?.length;
  return { fs, calls, open, size };
}

test("O_TRUNC on a file this open created skips the truncate", () => {
  const f = fixture();
  const resize = spyOn(f.fs, "resize");
  const fd = f.open("new.txt", O_CREAT | O_TRUNC);
  expect(resize).not.toHaveBeenCalled();
  expect(f.size("new.txt")).toBe(0);
  expect(f.calls.fd_close(fd)).toBe(0);
});

test("O_TRUNC still truncates a file that already existed", () => {
  const f = fixture();
  f.fs.writeFile("/old.txt", "existing");
  const resize = spyOn(f.fs, "resize");
  const fd = f.open("old.txt", O_CREAT | O_TRUNC);
  expect(resize).toHaveBeenCalledTimes(1);
  expect(f.size("old.txt")).toBe(0);
  expect(f.calls.fd_close(fd)).toBe(0);
});

test("O_TRUNC truncates when a competing creator's file with data wins the create", () => {
  const f = fixture();
  const create = f.fs.create.bind(f.fs);
  spyOn(f.fs, "create").mockImplementation((path, kind, exclusive) => {
    const created = create(path, kind, exclusive);
    // Another writer fills the file between the create and this open's stat.
    f.fs.writeFile("/raced.txt", "written by the other creator");
    return created;
  });
  const fd = f.open("raced.txt", O_CREAT | O_TRUNC);
  expect(f.size("raced.txt")).toBe(0);
  expect(f.calls.fd_close(fd)).toBe(0);
});
