import type { FileSystem } from "../../core/filesystem.js";
import { Wasi } from "../../core/wasi.js";

const allRights = (1n << 29n) - 1n;
const O_CREAT = 1,
  O_DIRECTORY = 2;
const encoder = new TextEncoder(),
  decoder = new TextDecoder();

/** One process's Preview1 path calls over `fs`, set up and checked only through those calls, so
 * every backend runs the same scenario. Paths start at fd 3, the `/` preopen. */
export function preview1(
  fs: FileSystem,
  preopens: Record<string, string> = { "/": "/" },
  /** Host setup between construction and guest entry, as exec's binding installation runs. */
  beforeEntry?: (wasi: Wasi) => void,
) {
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens,
    stdout() {},
    stderr() {},
    sleep() {},
  });
  beforeEntry?.(wasi);
  const memory = new WebAssembly.Memory({ initial: 1 });
  wasi.start({ exports: { memory, _start() {} } });
  const bytes = new Uint8Array(memory.buffer);
  const view = new DataView(memory.buffer);
  const calls = wasi["functions"]();
  const put = (value: string, at: number) => {
    const encoded = encoder.encode(value);
    bytes.set(encoded, at);
    return encoded.length;
  };
  const open = (name: string, follow = true, oflags = 0, fd = 3) => {
    const error = calls.path_open(
      fd,
      Number(follow),
      256,
      put(name, 256),
      oflags,
      allRights,
      allRights,
      0,
      4096,
    );
    return error ? -error : view.getUint32(4096, true);
  };
  const read = (fd: number) => {
    view.setUint32(0, 5000, true);
    view.setUint32(4, 1024, true);
    const error = calls.fd_read(fd, 0, 1, 4096);
    calls.fd_close(fd);
    return error ? -error : decoder.decode(bytes.slice(5000, 5000 + view.getUint32(4096, true)));
  };
  return {
    wasi,
    dispose: () => wasi.descriptors.dispose(),
    rmdir: (name: string) => calls.path_remove_directory(3, 256, put(name, 256)),
    /** The open description's inode handle, to tell a live descriptor from a physical file. */
    handleOf: (fd: number) => {
      const resource = wasi.descriptors.get(fd)?.resource;
      return resource?.kind === "file" || resource?.kind === "directory"
        ? resource.handle
        : undefined;
    },
    symlink: (target: string, name: string, fd = 3) =>
      calls.path_symlink(256, put(target, 256), fd, 2048, put(name, 2048)),
    /** The filetype, or a negative errno. */
    stat: (name: string, follow: boolean, fd = 3) => {
      const error = calls.path_filestat_get(fd, Number(follow), 256, put(name, 256), 4096);
      return error ? -error : view.getUint8(4112);
    },
    readlink: (name: string, fd = 3) => {
      const error = calls.path_readlink(fd, 256, put(name, 256), 5000, 1024, 4096);
      return error ? -error : decoder.decode(bytes.slice(5000, 5000 + view.getUint32(4096, true)));
    },
    open,
    read,
    /** The file's contents through a followed open, or a negative errno. */
    contents: (name: string, fd = 3) => {
      const opened = open(name, true, 0, fd);
      return opened < 0 ? opened : read(opened);
    },
    write(name: string, text: string) {
      const fd = open(name, true, O_CREAT);
      if (fd < 0) return fd;
      view.setUint32(0, 5000, true);
      view.setUint32(4, put(text, 5000), true);
      const error = calls.fd_write(fd, 0, 1, 4096);
      calls.fd_close(fd);
      return -error;
    },
    mkdir: (name: string, fd = 3) => calls.path_create_directory(fd, 256, put(name, 256)),
    unlink: (name: string) => calls.path_unlink_file(3, 256, put(name, 256)),
    rename: (from: string, to: string) =>
      calls.path_rename(3, 256, put(from, 256), 3, 2048, put(to, 2048)),
    openDirectory: (name: string) => open(name, true, O_DIRECTORY),
    close: (fd: number) => calls.fd_close(fd),
  };
}

/** Absolute and climbing link targets in the guest's root namespace, as Linux resolves them. */
export function rootedSymlinkScenario(fs: FileSystem): Record<string, unknown> {
  const p = preview1(fs);
  try {
    for (const dir of ["tmp", "tmp/x", "tmp/x/d"])
      if (p.mkdir(dir)) throw new Error(`mkdir ${dir}`);
    if (p.write("tmp/x/d/a.txt", "inside")) throw new Error("write a.txt");
    const results: Record<string, unknown> = {};
    results.create = p.symlink("/tmp/x/d/a.txt", "tmp/x/abs");
    results.readlink = p.readlink("tmp/x/abs");
    results.lstat = p.stat("tmp/x/abs", false);
    results.stat = p.stat("tmp/x/abs", true);
    results.read = p.contents("tmp/x/abs");
    results.nofollow = p.open("tmp/x/abs", false);
    results.dirlink = p.symlink("/tmp/x/d", "tmp/x/dirlink");
    results.through = p.contents("tmp/x/dirlink/a.txt");
    results.trailing = p.stat("tmp/x/dirlink/.", false);
    results.mkdirThrough = [p.mkdir("tmp/x/dirlink/made"), p.stat("tmp/x/d/made", false)];
    results.climb = [
      p.symlink("../../../../../../../tmp/x/d/a.txt", "tmp/x/climb"),
      p.contents("tmp/x/climb"),
    ];
    results.rootDotDot = [
      p.symlink("/../../tmp/x/d", "tmp/x/rootdot"),
      p.stat("tmp/x/rootdot/a.txt", true),
    ];
    const directory = p.openDirectory("tmp/x/dirlink");
    results.fromDirectory = [
      p.stat("../abs", true, directory),
      p.contents("../../../../../../tmp/x/d/a.txt", directory),
      p.stat("../dirlink/made", false, directory),
      p.close(directory),
    ];
    results.loop = [
      p.symlink("/tmp/x/loop-b", "tmp/x/loop-a"),
      p.symlink("/tmp/x/loop-a", "tmp/x/loop-b"),
      p.stat("tmp/x/loop-a", true),
      p.open("tmp/x/loop-a/inner"),
    ];
    // chain{i} -> chain{i+1} ... chain40 -> a.txt: chain1 takes 40 links, chain0 takes 41.
    for (let i = 0; i < 40; i++) p.symlink(`/tmp/x/chain${i + 1}`, `tmp/x/chain${i}`);
    p.symlink("/tmp/x/d/a.txt", "tmp/x/chain40");
    results.limit = [p.stat("tmp/x/chain1", true), p.stat("tmp/x/chain0", true)];
    results.device = [p.symlink("/dev", "tmp/x/devlink"), p.open("tmp/x/devlink/null") >= 0];
    results.rename = [
      p.rename("tmp/x/dirlink", "tmp/x/moved"),
      p.stat("tmp/x/moved", false),
      p.readlink("tmp/x/moved"),
    ];
    results.unlink = [
      p.unlink("tmp/x/abs"),
      p.stat("tmp/x/abs", false),
      p.stat("tmp/x/d/a.txt", false),
    ];
    return results;
  } finally {
    p.dispose();
  }
}

const NOENT = 44,
  LOOP = 32,
  DIRECTORY = 3,
  REGULAR = 4,
  SYMLINK = 7;
/** What Linux answers for rootedSymlinkScenario. */
export const rootedSymlinkExpected = {
  create: 0,
  readlink: "/tmp/x/d/a.txt",
  lstat: SYMLINK,
  stat: REGULAR,
  read: "inside",
  nofollow: -LOOP,
  dirlink: 0,
  through: "inside",
  trailing: DIRECTORY,
  mkdirThrough: [0, DIRECTORY],
  climb: [0, "inside"],
  rootDotDot: [0, REGULAR],
  fromDirectory: [REGULAR, "inside", DIRECTORY, 0],
  loop: [0, 0, -LOOP, -LOOP],
  limit: [REGULAR, -LOOP],
  device: [0, true],
  rename: [0, SYMLINK, "/tmp/x/d"],
  unlink: [0, -NOENT, REGULAR],
};
