import { expect, spyOn, test } from "bun:test";
import { MemFS } from "../fs/memory.js";
import { createPathOpenHost } from "./fixtures/wasi-path-open-host.js";

const O_CREAT = 1;
const O_EXCL = 4;
const O_TRUNC = 8;
const ROOT = 3;

function fixture() {
  const fs = new MemFS();
  const host = createPathOpenHost(fs);
  const open = (name: string, oflags: number) => host.openRaw(ROOT, name, { oflags });
  const size = (name: string) => fs.readFile(`/${name}`)?.length;
  return { fs, host, open, size };
}

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

test("O_TRUNC on a file this open created skips the truncate", () => {
  const f = fixture();
  const resize = spyOn(f.fs, "resize");
  const { errno, fd } = f.open("new.txt", O_CREAT | O_TRUNC);
  expect(errno).toBe(0);
  expect(resize).not.toHaveBeenCalled();
  expect(f.size("new.txt")).toBe(0);
  expect(f.host.close(fd)).toBe(0);
});

test("O_TRUNC still truncates a file that already existed", () => {
  const f = fixture();
  f.fs.writeFile("/old.txt", "existing");
  const resize = spyOn(f.fs, "resize");
  const { errno, fd } = f.open("old.txt", O_CREAT | O_TRUNC);
  expect(errno).toBe(0);
  expect(resize).toHaveBeenCalledTimes(1);
  expect(f.size("old.txt")).toBe(0);
  expect(f.host.close(fd)).toBe(0);
});

test("O_TRUNC truncates a competing creator's file with data", () => {
  const f = fixture();
  competingCreator(f, "written by the other creator");
  const { errno, fd } = f.open("raced.txt", O_CREAT | O_TRUNC);
  expect(errno).toBe(0);
  expect(f.size("raced.txt")).toBe(0);
  expect(f.host.close(fd)).toBe(0);
});

test("O_TRUNC still truncates a competing creator's empty file", () => {
  const f = fixture();
  competingCreator(f, "");
  // The truncate also updates the file times and checks the file's write permission.
  const resize = spyOn(f.fs, "resize");
  const { errno, fd } = f.open("raced.txt", O_CREAT | O_TRUNC);
  expect(errno).toBe(0);
  expect(resize).toHaveBeenCalledTimes(1);
  expect(f.host.close(fd)).toBe(0);
});

test("any failed exclusive probe falls back to the ordinary create and truncate", () => {
  const f = fixture();
  const create = f.fs.create.bind(f.fs);
  // A publication service can refuse the probe's receipt with EAGAIN instead of EEXIST.
  spyOn(f.fs, "create").mockImplementation((path, kind, exclusive) =>
    exclusive ? { error: 6 } : create(path, kind, exclusive),
  );
  const resize = spyOn(f.fs, "resize");
  const { errno, fd } = f.open("probe.txt", O_CREAT | O_TRUNC);
  expect(errno).toBe(0);
  expect(resize).toHaveBeenCalledTimes(1);
  expect(f.host.close(fd)).toBe(0);
});

test("O_EXCL still fails when a competing creator wins", () => {
  const f = fixture();
  competingCreator(f, "");
  expect(f.open("raced.txt", O_CREAT | O_EXCL).errno).toBe(20);
});
