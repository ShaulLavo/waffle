import { expect, spyOn, test } from "bun:test";
import { Wasi } from "../core/wasi.js";
import { MemFS } from "../fs/memory.js";

const encoder = new TextEncoder();
const ALL_RIGHTS = (1n << 29n) - 1n;
const O_CREAT = 1;
const O_EXCL = 4;
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
  const tryOpen = (name: string, flags: number) => {
    const path = encoder.encode(name);
    bytes.set(path, 256);
    return calls.path_open(3, 1, 256, path.length, flags, ALL_RIGHTS, 0n, 0, 1024);
  };
  const open = (name: string, flags: number) => {
    expect(tryOpen(name, flags)).toBe(0);
    return view.getUint32(1024, true);
  };
  const size = (name: string) => fs.readFile(`/${name}`)?.length;
  return { fs, calls, open, tryOpen, size };
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

/** Another creator makes the file after this open's lookup and before its create. */
function competingCreator(f: ReturnType<typeof fixture>, content: string) {
  const create = f.fs.create.bind(f.fs);
  let raced = false;
  return spyOn(f.fs, "create").mockImplementation((path, kind, exclusive) => {
    if (!raced) {
      raced = true;
      f.fs.writeFile("/raced.txt", content);
    }
    return create(path, kind, exclusive);
  });
}

test("O_TRUNC truncates a competing creator's file with data", () => {
  const f = fixture();
  competingCreator(f, "written by the other creator");
  const fd = f.open("raced.txt", O_CREAT | O_TRUNC);
  expect(f.size("raced.txt")).toBe(0);
  expect(f.calls.fd_close(fd)).toBe(0);
});

test("O_TRUNC still truncates a competing creator's empty file", () => {
  const f = fixture();
  competingCreator(f, "");
  // The truncate also updates the file times and checks the file's write permission.
  const resize = spyOn(f.fs, "resize");
  const fd = f.open("raced.txt", O_CREAT | O_TRUNC);
  expect(resize).toHaveBeenCalledTimes(1);
  expect(f.calls.fd_close(fd)).toBe(0);
});

test("O_EXCL still fails when a competing creator wins", () => {
  const f = fixture();
  competingCreator(f, "");
  expect(f.tryOpen("raced.txt", O_CREAT | O_EXCL)).toBe(20);
});
