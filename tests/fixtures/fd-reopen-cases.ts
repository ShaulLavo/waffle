import { FilesystemError } from "../../core/filesystem.js";
import { Wasi } from "../../core/wasi.js";
import { MemFS } from "../../fs/memory.js";
import { ProcessABI } from "../../proc/abi.js";
import { ExecutableRegistry } from "../../proc/registry.js";
import { ProcessSupervisor } from "../../proc/supervisor.js";
import { guestFunction, guestModule } from "./publication-wasm.js";

const READ = 2n,
  WRITE = 64n;
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
function equal(actual: unknown, expected: unknown): void {
  if (actual !== expected) throw new Error(`expected ${String(expected)}, got ${String(actual)}`);
}
function fixture(fs = new MemFS(), reservedFds: number[] = []) {
  const memory = new WebAssembly.Memory({ initial: 4 });
  const traces: string[] = [];
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens: { "/": "/" },
    reservedFds,
    namespaces: { env: { memory } },
    stdout() {},
    stderr() {},
    sleep() {},
    trace: (line) => traces.push(line),
  });
  const supervisor = new ProcessSupervisor({
    registry: new ExecutableRegistry(),
    launch() {
      throw new Error("unexpected launch");
    },
  });
  const pid = supervisor.createRoot({ descriptors: wasi.descriptors });
  const abi = new ProcessABI({
    memory,
    descriptors: wasi.descriptors,
    fs,
    pid,
    service: supervisor,
    signals: supervisor.get(pid)!,
  });
  const procModule = guestModule("runtime_proc", [
    { name: "fd_reopen", parameters: ["i32", "i32", "i32", "i64", "i32"] },
    { name: "fd_kind", parameters: ["i32"] },
    { name: "pipe", parameters: ["i32"] },
    { name: "spawn", parameters: ["i32", "i32"] },
  ]);
  let proc: WebAssembly.Instance | undefined;
  const wasiModule = guestModule("wasi_snapshot_preview1", [
    {
      name: "path_open",
      parameters: ["i32", "i32", "i32", "i32", "i32", "i64", "i64", "i32", "i32"],
    },
    { name: "fd_read", parameters: ["i32", "i32", "i32", "i32"] },
    { name: "fd_write", parameters: ["i32", "i32", "i32", "i32"] },
    { name: "fd_fdstat_get", parameters: ["i32", "i32"] },
  ]);
  const instance = new WebAssembly.Instance(wasiModule, wasi.imports(wasiModule));
  wasi.start(instance);
  const call = (name: string, ...args: (number | bigint)[]) =>
    guestFunction(instance, name)(...args);
  const procCall = (name: string, ...args: (number | bigint)[]) => {
    proc ??= new WebAssembly.Instance(procModule, { env: { memory }, runtime_proc: abi.imports });
    return guestFunction(proc, name)(...args);
  };
  const view = () => new DataView(memory.buffer);
  const put = (text: string, at = 2048) => {
    const bytes = encoder.encode(text);
    new Uint8Array(memory.buffer).set(bytes, at);
    return bytes.length;
  };
  const root = reservedFds.includes(3) ? 4 : 3;
  const tryPath = (path: string, oflags = 0, base = READ, flags = 0, inherit = 0n, dir = root) =>
    call("path_open", dir, 0, 2048, put(path), oflags, base, inherit, flags, 128);
  const open = (path: string, oflags = 0, base = READ, flags = 0) => {
    equal(tryPath(path, oflags, base, flags), 0);
    return view().getUint32(128, true);
  };
  const tryReopen = (fd: number, oflags = 0, base = READ, flags = 0, out = 128) =>
    procCall("fd_reopen", fd, oflags, flags, base, out);
  const reopen = (fd: number, oflags = 0, base = READ, flags = 0) => {
    equal(tryReopen(fd, oflags, base, flags), 0);
    return view().getUint32(128, true);
  };
  const io = (name: string, fd: number, length: number) => {
    view().setUint32(256, 4096, true);
    view().setUint32(260, length, true);
    equal(call(name, fd, 256, 1, 264), 0);
    return view().getUint32(264, true);
  };
  const read = (fd: number, length = 64) => {
    const count = io("fd_read", fd, length);
    return decoder.decode(new Uint8Array(memory.buffer, 4096, count).slice());
  };
  const write = (fd: number, text: string) =>
    equal(io("fd_write", fd, put(text, 4096)), text.length);
  return {
    traces,
    fs,
    wasi,
    supervisor,
    pid,
    root,
    procCall,
    view,
    put,
    tryPath,
    open,
    tryReopen,
    reopen,
    read,
    write,
    call,
  };
}
type Fixture = ReturnType<typeof fixture>;
function using(run: (f: Fixture) => void): void {
  const f = fixture();
  try {
    run(f);
  } finally {
    f.supervisor.dispose();
  }
}
function resource(f: Fixture, fd: number) {
  const value = f.wasi.descriptors.get(fd)!.resource;
  if (value.kind !== "file") throw new Error("expected file");
  return value;
}
function seed(f: Fixture, text = "abcdef", base = READ | WRITE, flags = 0): number {
  f.fs.writeFile("/file", text);
  return f.open("file", 0, base, flags);
}
const cases: { label: string; run(): void }[] = [];
function test(label: string, run: (f: Fixture) => void): void {
  cases.push({ label: `fd_reopen: ${label}`, run: () => using(run) });
}

test("regular files start at zero and have independent offsets", (f) => {
  const source = seed(f);
  equal(f.read(source, 2), "ab");
  const reopened = f.reopen(source);
  equal(f.procCall("fd_kind", reopened), 3);
  equal(f.read(reopened, 3), "abc");
  equal(f.read(source), "cdef");
  equal(f.read(reopened), "def");
  f.wasi.descriptors.close(source);
  equal(f.read(reopened), "");
});
test("write-only source can reopen for reading against inode policy", (f) => {
  const source = seed(f, "", WRITE);
  f.write(source, "written");
  const reopened = f.reopen(source);
  equal(f.read(reopened), "written");
  equal(resource(f, source).offset, 7);
});
test("TRUNC resets the inode and new offset but not the source offset", (f) => {
  const source = seed(f);
  equal(f.read(source, 3), "abc");
  const reopened = f.reopen(source, 8, WRITE);
  f.write(reopened, "x");
  equal(f.read(f.reopen(source)), "x");
  equal(resource(f, source).offset, 3);
});
test("APPEND and NONBLOCK flags belong to the new description", (f) => {
  const source = seed(f, "abc");
  const reopened = f.reopen(source, 0, WRITE, 5);
  f.write(reopened, "d");
  f.write(source, "X");
  equal(f.read(f.reopen(source)), "Xbcd");
  equal(f.call("fd_fdstat_get", reopened, 512), 0);
  equal(f.view().getUint16(514, true), 5);
  equal(f.call("fd_fdstat_get", source, 512), 0);
  equal(f.view().getUint16(514, true), 0);
});
test("unlinked open inode survives independent reopen and source close", (f) => {
  const source = seed(f);
  const path = f.fs.resolve(f.fs.preopen("/"), "file");
  if (typeof path === "number") throw new Error("missing fixture path");
  equal(f.fs.removePath(path, false), 0);
  const reopened = f.reopen(source);
  f.wasi.descriptors.close(source);
  equal(f.read(reopened), "abcdef");
});
test("inode read and write denial returns EACCES without truncation", (f) => {
  const source = seed(f);
  const handle = resource(f, source).handle;
  equal(f.fs.setMode(handle, 0o200), 0);
  equal(f.tryReopen(source), 2);
  equal(f.fs.setMode(handle, 0o400), 0);
  equal(f.tryReopen(source, 8, WRITE), 2);
  equal(f.read(f.reopen(source)), "abcdef");
});
test("the live root capability bounds new rights and truncation", (f) => {
  const source = seed(f);
  const root = f.wasi.descriptors.get(f.root)!;
  root.rightsInheriting &= ~WRITE;
  equal(f.tryReopen(source, 0, WRITE), 76);
  const reopened = f.reopen(source);
  equal(f.read(reopened), "abcdef");
  root.rightsBase &= ~(1n << 19n);
  equal(f.tryReopen(source, 8), 76);
});
test("pipe endpoints stay shared and cannot gain source rights", (f) => {
  equal(f.procCall("pipe", 32), 0);
  const reader = f.view().getUint32(32, true),
    writer = f.view().getUint32(36, true);
  const reopened = f.reopen(reader);
  equal(f.procCall("fd_kind", reopened), 1);
  equal(f.wasi.descriptors.get(reopened)!.description, f.wasi.descriptors.get(reader)!.description);
  f.write(writer, "pipe");
  equal(f.read(reopened, 2), "pi");
  equal(f.read(reader, 2), "pe");
  equal(f.tryReopen(reader, 0, WRITE), 2);
});
test("terminal and directory duplicates keep their original kind and lifetime", (f) => {
  const tty = f.reopen(1, 0, WRITE);
  equal(f.procCall("fd_kind", tty), 2);
  equal(f.wasi.descriptors.get(tty)!.description, f.wasi.descriptors.get(1)!.description);
  const dir = f.reopen(f.root, 2, 1n << 14n);
  equal(f.procCall("fd_kind", dir), 4);
  equal(f.wasi.descriptors.get(dir)!.description, f.wasi.descriptors.get(f.root)!.description);
  equal(f.tryReopen(tty, 0, 1n << 2n), 2);
});
test("closed descriptors return EBADF and successful opens use the lowest hole", (f) => {
  const source = seed(f);
  const hole = f.reopen(source),
    last = f.reopen(source);
  f.wasi.descriptors.close(hole);
  equal(f.reopen(source), hole);
  f.wasi.descriptors.close(last);
  equal(f.tryReopen(last), 8);
  equal(f.tryReopen(-1), 8);
});
test("invalid creation flags, DIRECTORY and bad output pointers cannot modify the file", (f) => {
  const source = seed(f);
  for (const flags of [1, 4, 5, 16]) equal(f.tryReopen(source, flags), 28);
  equal(f.tryReopen(source, 2), 54);
  equal(f.tryReopen(source, 8, WRITE, 0, 0xfffffff0), 21);
  equal(f.tryReopen(source, 0, READ, 32), 28);
  equal(f.read(f.reopen(source)), "abcdef");
});

test("direct WASI reopen keeps EBADF separate from absent alias ENOENT", (f) => {
  f.view().setUint32(128, 0xabcdef01, true);
  equal(f.wasi.fdReopen(99999, 0, 0, READ, 128), 8);
  equal(f.wasi.fdReopen(-1, 0, 0, READ, 128), 8);
  equal(f.tryPath("dev/fd/99999"), 44);
  equal(f.view().getUint32(128, true), 0xabcdef01);
  equal(f.wasi.fdReopen(99999, 8, 0, WRITE, 0xfffffff0), 21);
  equal(
    f.call("path_open", f.root, 0, 2048, f.put("dev/fd/99999"), 8, WRITE, 0n, 0, 0xfffffff0),
    44,
  );
});
test("direct and alias output spans are validated before TRUNC or allocation", (f) => {
  const source = seed(f);
  const last = f.reopen(source);
  f.wasi.descriptors.close(last);
  for (const out of [4 * 65536 - 3, 0xfffffff0, -1]) {
    equal(f.wasi.fdReopen(source, 8, 0, WRITE, out), 21);
    equal(
      f.call("path_open", f.root, 0, 2048, f.put(`dev/fd/${source}`), 8, WRITE, 0n, 0, out),
      21,
    );
  }
  equal(f.wasi.fdReopen(source, 0, 0, READ, 4 * 65536 - 4), 0);
  equal(f.view().getUint32(4 * 65536 - 4, true), last);
  equal(f.read(last), "abcdef");
});
test("inode open failures keep positive errno and leave output and bytes untouched", (f) => {
  const source = seed(f);
  const permissions = f.fs.permissions.bind(f.fs);
  const resize = f.fs.resize.bind(f.fs);
  f.view().setUint32(128, 0xabcdef01, true);
  const traces = f.traces.length;
  f.fs.permissions = () => {
    throw new FilesystemError(2);
  };
  equal(f.wasi.fdReopen(source, 8, 0, WRITE, 128), 2);
  equal(f.tryPath(`dev/fd/${source}`, 8, WRITE), 2);
  equal(f.tryPath("file", 8, WRITE), 2);
  equal(f.traces.length, traces);
  f.fs.permissions = permissions;
  f.fs.resize = () => 29;
  equal(f.wasi.fdReopen(source, 8, 0, WRITE, 128), 29);
  equal(f.tryPath(`dev/fd/${source}`, 8, WRITE), 29);
  equal(f.tryPath("file", 8, WRITE), 29);
  f.fs.resize = resize;
  equal(f.view().getUint32(128, true), 0xabcdef01);
  equal(f.read(f.reopen(source)), "abcdef");
});
test("ordinary opens and descriptor reopens keep their original policy order", (f) => {
  const source = seed(f);
  equal(f.fs.setMode(resource(f, source).handle, 0o200), 0);
  equal(f.wasi.fdReopen(source, 2, 0, READ, 128), 54);
  equal(f.tryPath(`dev/fd/${source}`, 2), 54);
  equal(f.tryPath("file", 2), 2);
  equal(f.wasi.fdReopen(f.root, 8, 0, READ, 128), 31);
  equal(f.tryPath(".", 8), 31);
});
test("direct reopen propagates unknown host errors while preview1 wraps them", (f) => {
  const source = seed(f);
  const permissions = f.fs.permissions.bind(f.fs);
  const failure = new Error("fixture inode failure");
  f.fs.permissions = () => {
    throw failure;
  };
  let caught: unknown;
  try {
    f.wasi.fdReopen(source, 0, 0, READ, 128);
  } catch (error) {
    caught = error;
  }
  equal(caught, failure);
  equal(f.tryPath(`dev/fd/${source}`), 29);
  f.fs.permissions = permissions;
});

test("only root directory bindings resolve normalized descriptor aliases", (f) => {
  const source = seed(f);
  equal(f.read(f.open(`./dev//fd/./${source}`)), "abcdef");
  const root = f.wasi.descriptors.get(f.root)!;
  const openedRoot = f.wasi.descriptors.open(
    { kind: "directory", handle: f.fs.preopen("/") },
    root.rightsBase,
    root.rightsInheriting,
  );
  equal(f.tryPath(`proc/self/fd/${source}`, 0, READ, 0, 0n, openedRoot), 0);
  equal(f.read(f.view().getUint32(128, true)), "abcdef");
  f.fs.writeFile(`/other/dev/fd/${source}`, "ordinary");
  const directory = f.wasi.descriptors.open(
    { kind: "directory", handle: f.fs.preopen("/other") },
    root.rightsBase,
    root.rightsInheriting,
  );
  equal(f.tryPath(`dev/fd/${source}`, 0, READ, 0, 0n, directory), 0);
  equal(f.read(f.view().getUint32(128, true)), "ordinary");
  equal(f.tryPath(`/dev/fd/${source}`, 0, READ, 0, 0n, directory), 63);
  f.wasi.descriptors.get(directory)!.preopen = "/other";
  equal(f.tryPath(`dev/fd/${source}`, 0, READ, 0, 0n, directory), 0);
  equal(f.read(f.view().getUint32(128, true)), "ordinary");
});
test("descriptor aliases enforce root search permission before reopening", (f) => {
  const source = seed(f);
  equal(f.read(f.open(`/dev/fd/${source}`)), "abcdef");
  equal(f.fs.setMode(f.fs.preopen("/"), 0o600), 0);
  equal(f.tryPath("file"), 2);
  equal(f.tryPath(`/dev/fd/${source}`), 2);
  equal(f.tryPath(`proc/self/fd/${source}`), 2);
});
for (const parent of ["/dev", "/dev/fd", "/proc", "/proc/self", "/proc/self/fd"]) {
  test(`descriptor aliases enforce search on existing ${parent}`, (f) => {
    const source = seed(f);
    const directory = f.fs.preopen(parent);
    const path = parent.startsWith("/dev") ? `/dev/fd/${source}` : `/proc/self/fd/${source}`;
    equal(f.read(f.open(path)), "abcdef");
    equal(f.fs.setMode(directory, 0o600), 0);
    equal(f.tryPath(path, 8, WRITE), 2);
    equal(f.read(f.reopen(source)), "abcdef");
  });
}

const traversalShapes = [
  { shape: "noaccess/../%", error: 2 },
  { shape: "../%", error: 63 },
  { shape: "parent//../%", error: 0 },
  { shape: "parent/./../%", error: 0 },
  { shape: "%/", error: undefined },
  { shape: "%/.", error: undefined },
];
const traversalCases = [
  "dev/fd/N",
  "proc/self/fd/N",
  "dev/stdout",
  "/dev/fd/N",
  "/proc/self/fd/N",
  "/dev/stdout",
].flatMap((alias) =>
  ["file", "directory"].flatMap((kind) =>
    traversalShapes.map((entry) => ({ alias, kind, ...entry })),
  ),
);
for (const { alias, kind, shape, error } of traversalCases) {
  test(`${alias} ${kind} traversal ${shape} matches ordinary paths without failed truncation`, (f) => {
    const file = seed(f);
    const root = f.wasi.descriptors.get(f.root)!;
    const source =
      kind === "file"
        ? file
        : f.wasi.descriptors.open(
            { kind: "directory", handle: f.fs.preopen("/target") },
            root.rightsBase,
            root.rightsInheriting,
          );
    f.wasi.descriptors.inherit(1, f.wasi.descriptors.get(source)!);
    const name = alias.replace("N", String(source));
    equal(f.tryPath(name), 0);
    f.fs.preopen("/parent");
    equal(f.fs.setMode(f.fs.preopen("/noaccess"), 0o600), 0);
    const flags = kind === "file" ? 8 : 0;
    const rights = kind === "file" ? WRITE : READ;
    const expected = error ?? (kind === "file" ? 54 : 0);
    equal(
      f.tryPath(shape.replace("%", kind === "file" ? "file" : "target"), flags, rights),
      expected,
    );
    if (expected) equal(f.read(f.reopen(file)), "abcdef");
    f.fs.writeFile("/file", "abcdef");
    equal(f.tryPath(shape.replace("%", name), flags, rights), expected);
    if (expected) equal(f.read(f.reopen(file)), "abcdef");
  });
}

for (const path of ["/dev/fd/N", "/proc/self/fd/N", "dev/fd/N", "proc/self/fd/N"]) {
  test(`path_open ${path} resolves the caller's descriptor, not shared MemFS`, (f) => {
    const source = seed(f);
    equal(f.read(source, 2), "ab");
    equal(f.read(f.open(path.replace("N", String(source)))), "abcdef");
    equal(f.read(source), "cdef");
    equal(f.tryPath(path.replace("N", "99999")), 44);
    equal(f.fs.lookup("/dev"), undefined);
  });
}
for (const [name, fd] of [
  ["stdin", 0],
  ["stdout", 1],
  ["stderr", 2],
] as const) {
  for (const prefix of ["/", ""]) {
    test(`path_open ${prefix}dev/${name} follows regular-file stdio bindings`, (f) => {
      const source = seed(f);
      f.wasi.descriptors.inherit(fd, f.wasi.descriptors.get(source)!);
      equal(f.read(source, 2), "ab");
      equal(f.read(f.open(`${prefix}dev/${name}`)), "abcdef");
      equal(f.read(source), "cdef");
      f.wasi.descriptors.close(fd);
      equal(f.tryPath(`${prefix}dev/${name}`), 44);
    });
  }
}
for (let bits = 0; bits < 8; bits++) {
  const name = bits & 4 ? "stderr" : "stdout";
  const originalAppend = (bits & 2) !== 0;
  const redirectAppend = (bits & 1) !== 0;
  test(`${name} source ${originalAppend ? "APPEND" : "plain"}, redirect ${redirectAppend ? ">>" : ">"} exact Linux bytes`, (f) => {
    const source = seed(f, "old\n", WRITE, originalAppend ? 1 : 0);
    f.wasi.descriptors.inherit(name === "stdout" ? 1 : 2, f.wasi.descriptors.get(source)!);
    const reopened = f.open(`/dev/${name}`, redirectAppend ? 0 : 8, WRITE, redirectAppend ? 1 : 0);
    f.write(reopened, "x\n");
    equal(f.read(f.reopen(source)), redirectAppend ? "old\nx\n" : "x\n");
    equal(resource(f, source).offset, 0);
    equal(resource(f, source).append, originalAppend);
  });
}
test("child inherited fd 3 reopens independently through its displaced root preopen", (f) => {
  const source = seed(f);
  equal(f.read(source, 2), "ab");
  const length = f.put(
    JSON.stringify({
      executable: "fixture",
      argv: [],
      env: {},
      cwd: "/",
      job: 0,
      fds: [{ parent: source, child: 3 }],
    }),
  );
  const pid = f.procCall("spawn", 2048, length);
  if (pid <= 0) throw new Error(`spawn failed ${pid}`);
  const child = fixture(f.fs, [3]);
  try {
    child.wasi.descriptors.inherit(3, f.supervisor.get(pid)!.descriptors.get(3)!);
    const reopened = child.open("dev/fd/3");
    equal(child.read(reopened), "abcdef");
    equal(child.procCall("fd_kind", reopened), 3);
    equal(f.read(source), "cdef");
  } finally {
    child.supervisor.dispose();
  }
});
export function fdReopenCases(): readonly { label: string; run(): void }[] {
  return cases;
}
