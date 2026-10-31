import { Wasi } from "../../core/wasi.js";
import type { FileSystem } from "../../core/filesystem.js";
import { guestFunction, guestModule } from "./publication-wasm.js";

const rights = (1n << 29n) - 1n;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function metadataGuest(fs: FileSystem, root = "/") {
  const memory = new WebAssembly.Memory({ initial: 4 });
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens: { "/": root },
    namespaces: { env: { memory } },
    stdout() {},
    stderr() {},
    sleep() {},
  });
  const module = guestModule("wasi_snapshot_preview1", [
    {
      name: "path_open",
      parameters: ["i32", "i32", "i32", "i32", "i32", "i64", "i64", "i32", "i32"],
    },
    { name: "path_link", parameters: ["i32", "i32", "i32", "i32", "i32", "i32", "i32"] },
    { name: "path_unlink_file", parameters: ["i32", "i32", "i32"] },
    { name: "path_rename", parameters: ["i32", "i32", "i32", "i32", "i32", "i32"] },
    { name: "path_filestat_get", parameters: ["i32", "i32", "i32", "i32", "i32"] },
    { name: "fd_filestat_get", parameters: ["i32", "i32"] },
    { name: "fd_read", parameters: ["i32", "i32", "i32", "i32"] },
    { name: "fd_readdir", parameters: ["i32", "i32", "i32", "i64", "i32"] },
    { name: "fd_close", parameters: ["i32"] },
  ]);
  const instance = new WebAssembly.Instance(module, wasi.imports(module));
  wasi.start(instance);
  const view = new DataView(memory.buffer);
  const bytes = new Uint8Array(memory.buffer);
  function call(name: string, ...args: (number | bigint)[]) {
    return guestFunction(instance, name)(...args);
  }
  function checked(name: string, ...args: (number | bigint)[]) {
    const error = call(name, ...args);
    if (error !== 0) throw new Error(`${name} returned ${error}`);
  }
  function path(value: string, at = 512) {
    const encoded = encoder.encode(value);
    bytes.set(encoded, at);
    return encoded.length;
  }
  function statRecord() {
    return { ino: view.getBigUint64(4104, true), nlink: view.getBigUint64(4120, true) };
  }
  function stat(name: string) {
    checked("path_filestat_get", 3, 0, 512, path(name), 4096);
    return statRecord();
  }
  function fstat(fd: number) {
    checked("fd_filestat_get", fd, 4096);
    return statRecord();
  }
  function open(name: string) {
    checked("path_open", 3, 0, 512, path(name), 0, rights, 0n, 0, 4096);
    return view.getUint32(4096, true);
  }
  function link(from: string, to: string) {
    checked("path_link", 3, 0, 512, path(from), 3, 2048, path(to, 2048));
  }
  function rename(from: string, to: string) {
    checked("path_rename", 3, 512, path(from), 3, 2048, path(to, 2048));
  }
  function unlink(name: string) {
    checked("path_unlink_file", 3, 512, path(name));
  }
  function read(fd: number) {
    view.setUint32(0, 8192, true);
    view.setUint32(4, 128, true);
    checked("fd_read", fd, 0, 1, 4096);
    return decoder.decode(bytes.subarray(8192, 8192 + view.getUint32(4096, true)));
  }
  return { wasi, view, bytes, call, checked, stat, fstat, open, link, rename, unlink, read };
}

export function linkLifecycle(
  fs: FileSystem,
  root = "/",
  observer?: ReturnType<typeof metadataGuest>,
) {
  const h = metadataGuest(fs, root);
  try {
    const fd = h.open("file");
    const stats = [h.stat("file")];
    const descriptor = [h.fstat(fd)];
    const peer = observer ? [observer.stat("file")] : [];
    h.link("file", "alias");
    stats.push(h.stat("alias"));
    descriptor.push(h.fstat(fd));
    if (observer) peer.push(observer.stat("alias"));
    h.unlink("file");
    stats.push(h.stat("alias"));
    descriptor.push(h.fstat(fd));
    if (observer) peer.push(observer.stat("alias"));
    h.unlink("alias");
    descriptor.push(h.fstat(fd));
    const contents = h.read(fd);
    h.checked("fd_close", fd);
    return { stats, descriptor, peer, contents, closedErrno: h.call("fd_filestat_get", fd, 4096) };
  } finally {
    h.wasi.descriptors.dispose();
  }
}

export function directoryPage(
  h: ReturnType<typeof metadataGuest>,
  cookie: bigint,
  capacity = 4096,
) {
  h.checked("fd_readdir", 3, 8192, capacity, cookie, 4096);
  const used = h.view.getUint32(4096, true);
  const entries: { name: string; cookie: bigint; ino: bigint; kind: number }[] = [];
  let at = 0;
  while (at + 24 <= used) {
    const start = 8192 + at;
    const length = h.view.getUint32(start + 16, true);
    if (at + 24 + length > used) break;
    entries.push({
      name: decoder.decode(h.bytes.subarray(start + 24, start + 24 + length)),
      cookie: h.view.getBigUint64(start, true),
      ino: h.view.getBigUint64(start + 8, true),
      kind: h.view.getUint8(start + 20),
    });
    at += 24 + length;
  }
  return { used, entries, partialBytes: used - at };
}

function enumeratePages(h: ReturnType<typeof metadataGuest>, count: number, capacity: number) {
  const names: string[] = [];
  const cookies: bigint[] = [];
  let cookie = 0n;
  let calls = 0;
  let partialPages = 0;
  for (; calls < count + 3; calls++) {
    const page = directoryPage(h, cookie, capacity);
    if (!page.used) break;
    if (!page.entries.length) throw new Error("no complete dirent in 4 KiB buffer");
    if (page.partialBytes) partialPages++;
    for (const entry of page.entries) {
      names.push(entry.name);
      cookies.push(entry.cookie);
      cookie = entry.cookie;
    }
  }
  if (calls === count + 3) throw new Error("directory enumeration did not reach EOF");
  const eof = directoryPage(h, cookie).used;
  const partial = directoryPage(h, 0n, 10);
  const restart = directoryPage(h, 0n).entries.map((entry) => entry.name);
  return { names, cookies, calls: calls + 1, partialPages, eof, partial: partial.used, restart };
}

export function enumerateDirectory(fs: FileSystem, count: number, capacity = 4096) {
  const h = metadataGuest(fs);
  try {
    return enumeratePages(h, count, capacity);
  } finally {
    h.wasi.descriptors.dispose();
  }
}
