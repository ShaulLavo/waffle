import { expect, test } from "bun:test";
import { MemoryBackend } from "../fs/backend";
import {
  ExecutableNotFound,
  ExecutableNotRunnable,
  ExecutableFormatError,
  ExecutableRegistry,
  ProcessSupervisor,
  Signal,
  waitStatus,
  type ProcessContext,
  type SpawnRequest,
} from "../proc";

const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const request = (executable: string, cwd = "/"): SpawnRequest => ({
  executable,
  argv: [executable],
  env: {},
  cwd,
  job: 0,
  fds: [],
});

function reviewSymlink(fs: ReturnType<typeof fixture>["fs"], path: string, target: string): void {
  const resolved = fs.resolveAbsolute(path);
  if (typeof resolved === "number") throw new Error(`cannot resolve ${path}`);
  expect(fs.symlink(resolved, target)).toBe(0);
}

test("review: final symlink traversal respects the filesystem 40-link limit", async () => {
  const state = fixture();
  try {
    for (let index = 0; index < 41; index++)
      reviewSymlink(
        state.fs,
        `/bin/link-${index}`,
        index === 40 ? "test-guest" : `link-${index + 1}`,
      );
    const pid = state.supervisor.reserveSpawn(state.root, request("/bin/link-0"));
    await state.supervisor.start(pid);
    expect(await state.supervisor.waitForExit(state.root, pid)).toMatchObject({
      kind: "start-failed",
      error: "ELOOP",
      code: 40,
    });
    expect(state.loads).toBe(0);
  } finally {
    state.supervisor.dispose();
  }
});

test("review: symlink scripts resolve relative shebang interpreters against process cwd", async () => {
  const state = fixture();
  try {
    state.fs.mkdirp("/links");
    state.fs.writeFile("/tools/script", "#!./test-guest\n");
    reviewSymlink(state.fs, "/links/script", "/tools/script");
    expect(
      await state.registry.resolve("/tools/script", "/bin", undefined, ["/tools/script", "arg"]),
    ).toMatchObject({ adapter: "test", argv: ["./test-guest", "/tools/script", "arg"] });
    expect(
      await state.registry.resolve("/links/script", "/bin", undefined, ["/links/script", "arg"]),
    ).toMatchObject({ adapter: "test", argv: ["./test-guest", "/links/script", "arg"] });
  } finally {
    state.supervisor.dispose();
  }
});

test("review: registered final link target can traverse a directory symlink", async () => {
  const state = fixture();
  try {
    reviewSymlink(state.fs, "/alias", "/bin");
    reviewSymlink(state.fs, "/bin/indirect", "/alias/test-guest");
    state.registry.register("/alias/test-guest", { module, adapter: "wrong-owner" });
    expect(await state.registry.resolve("/bin/indirect")).toMatchObject({
      module,
      adapter: "test",
    });
    state.registry.unregister("/bin/test-guest");
    await expect(state.registry.check("/bin/indirect")).rejects.toMatchObject({ code: "EACCES" });
    state.registry.register("/bin/test-guest", { module, adapter: "replacement" });
    expect(await state.registry.resolve("/bin/indirect")).toMatchObject({ adapter: "replacement" });
  } finally {
    state.supervisor.dispose();
  }
});

test("review: link registration cannot override target ownership and replacement is live", async () => {
  const state = fixture();
  try {
    reviewSymlink(state.fs, "/bin/link", "test-guest");
    state.registry.register("/bin/link", { module, adapter: "wrong-owner" });
    expect(await state.registry.check("/bin/link")).toMatchObject({ adapter: "test" });
    expect(state.loads).toBe(0);
    state.registry.unregister("/bin/test-guest");
    await expect(state.registry.check("/bin/link")).rejects.toMatchObject({ code: "EACCES" });
    state.registry.register("/bin/test-guest", { module, adapter: "replacement" });
    expect(await state.registry.resolve("/bin/link")).toMatchObject({ adapter: "replacement" });
    state.fs.remove("/bin/test-guest");
    state.fs.mkdirp("/bin/test-guest");
    await expect(state.registry.resolve("/bin/link")).rejects.toMatchObject({ code: "EACCES" });
  } finally {
    state.supervisor.dispose();
  }
});

test("review: multi-hop relative and absolute links retain caller argv and reject target deletion", async () => {
  const state = fixture();
  try {
    state.fs.mkdirp("/links");
    reviewSymlink(state.fs, "/links/outer", "../bin/inner");
    reviewSymlink(state.fs, "/bin/inner", "/bin/test-guest");
    expect(
      await state.registry.resolve("./outer", "/links", undefined, ["caller-argv", "arg"]),
    ).toMatchObject({ module, adapter: "test", argv: ["caller-argv", "arg"] });
    expect(state.loads).toBe(1);
    state.fs.remove("/bin/test-guest");
    await expect(state.registry.resolve("./outer", "/links")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    state.supervisor.dispose();
  }
});

function fixture() {
  const backend = new MemoryBackend(),
    fs = backend.fs;
  fs.writeFile("/bin/test-guest", new Uint8Array());
  let loads = 0;
  const lookups: string[] = [],
    contexts: ProcessContext[] = [],
    failures: unknown[] = [];
  const registry = new ExecutableRegistry(
    (path) => {
      lookups.push(path);
      return backend.execute("resolvePath", [path], new Uint8Array()) as
        | { path: string; kind: "file" | "dir" }
        | undefined;
    },
    (path) => backend.execute("readFile", [path], new Uint8Array()) as Uint8Array | undefined,
  );
  registry.register("/bin/test-guest", {
    adapter: "test",
    module: () => {
      loads++;
      return module;
    },
    interruptible: true,
  });
  const supervisor = new ProcessSupervisor({
    registry,
    startFailed(_pid, error) {
      failures.push(error);
    },
    launch(context) {
      contexts.push(context);
      context.exit(23);
      return { terminate() {} };
    },
  });
  const root = supervisor.createRoot();
  return {
    fs,
    registry,
    supervisor,
    root,
    lookups,
    contexts,
    failures,
    get loads() {
      return loads;
    },
  };
}

for (const [executable, cwd] of [
  ["./test-guest", "/bin"],
  ["test-guest", "/bin"],
  ["/bin/../bin/./test-guest", "/elsewhere"],
  ["/../bin/test-guest", "/"],
  ["../bin/test-guest", "/"],
  ["/bin/../../bin/test-guest", "/"],
] as const) {
  test(`spawn resolves ${executable} against cwd ${cwd}`, async () => {
    const state = fixture();
    try {
      const spec = request(executable, cwd);
      const pid = state.supervisor.reserveSpawn(state.root, spec);
      spec.cwd = "/changed-after-spawn";
      await state.supervisor.start(pid);
      expect(await state.supervisor.waitForExit(state.root, pid)).toEqual({
        kind: "exited",
        code: 23,
        status: 23,
      });
      expect(state.lookups).toEqual([
        executable.startsWith("/") ? executable : `${cwd}/${executable}`,
      ]);
      expect(state.contexts[0]?.request.cwd).toBe(cwd);
      expect(state.contexts[0]?.interruptible).toBe(true);
      expect(state.loads).toBe(1);
    } finally {
      state.supervisor.dispose();
    }
  });
}

test("spawn follows a symlink to the canonical registered executable", async () => {
  const state = fixture();
  try {
    const link = state.fs.resolveAbsolute("/bin/test-link");
    if (typeof link === "number") throw new Error("missing symlink path");
    expect(state.fs.symlink(link, "test-guest")).toBe(0);
    const descriptors = state.supervisor.get(state.root)?.descriptors;
    if (!descriptors) throw new Error("missing root descriptors");
    const parent = descriptors.open({ kind: "directory", handle: 1 }, 0n, 0n);
    const pid = state.supervisor.reserveSpawn(state.root, {
      ...request("./test-link", "/bin"),
      argv: ["./test-link", "argument"],
      env: { MARKER: "preserved" },
      fds: [{ parent, child: 9 }],
    });
    await state.supervisor.start(pid);
    expect(await state.supervisor.waitForExit(state.root, pid)).toMatchObject({
      kind: "exited",
      code: 23,
    });
    expect(state.contexts[0]).toMatchObject({
      module,
      adapter: "test",
      interruptible: true,
      request: {
        executable: "./test-link",
        argv: ["./test-link", "argument"],
        env: { MARKER: "preserved" },
        cwd: "/bin",
        fds: [{ parent, child: 9 }],
      },
    });
    expect(state.loads).toBe(1);
  } finally {
    state.supervisor.dispose();
  }
});

test("spawn retains dangling and looping symlink errors", async () => {
  const state = fixture();
  try {
    const loopA = state.fs.resolveAbsolute("/bin/loop-a");
    const loopB = state.fs.resolveAbsolute("/bin/loop-b");
    const dangling = state.fs.resolveAbsolute("/bin/dangling");
    if (typeof loopA === "number" || typeof loopB === "number" || typeof dangling === "number")
      throw new Error("missing symlink path");
    expect(state.fs.symlink(loopA, "loop-b")).toBe(0);
    expect(state.fs.symlink(loopB, "loop-a")).toBe(0);
    expect(state.fs.symlink(dangling, "missing")).toBe(0);
    for (const [executable, error, code] of [
      ["/bin/loop-a", "ELOOP", 40],
      ["/bin/dangling", "ENOENT", 2],
    ] as const) {
      const pid = state.supervisor.reserveSpawn(state.root, request(executable));
      await state.supervisor.start(pid);
      expect(await state.supervisor.waitForExit(state.root, pid)).toMatchObject({
        kind: "start-failed",
        error,
        code,
      });
    }
    expect(state.loads).toBe(0);
  } finally {
    state.supervisor.dispose();
  }
});

for (const stateChange of ["missing", "deleted", "directory", "unregistered"] as const) {
  test(`spawn checks the live filesystem before loading a ${stateChange} executable`, async () => {
    const state = fixture();
    try {
      let executable = "/bin/test-guest";
      if (stateChange === "missing") executable = "/bin/missing";
      if (stateChange === "deleted" || stateChange === "directory") state.fs.remove(executable);
      if (stateChange === "directory") state.fs.mkdirp(executable);
      if (stateChange === "unregistered") state.registry.unregister(executable);
      const pid = state.supervisor.reserveSpawn(state.root, request(executable));
      await state.supervisor.start(pid);
      const result = await state.supervisor.waitForExit(state.root, pid);
      const missing = stateChange === "missing" || stateChange === "deleted";
      const invalid = stateChange === "unregistered";
      expect(result).toEqual({
        kind: "start-failed",
        code: invalid ? 8 : missing ? 2 : 13,
        error: invalid ? "ENOEXEC" : missing ? "ENOENT" : "EACCES",
        status: null,
      });
      expect(waitStatus(result)).toBe(invalid ? 126 : missing ? 127 : 126);
      if (invalid) expect(state.failures[0]).toBeInstanceOf(ExecutableFormatError);
      else if (missing) expect(state.failures[0]).toBeInstanceOf(ExecutableNotFound);
      else expect(state.failures[0]).toBeInstanceOf(ExecutableNotRunnable);
      expect(state.failures[0]).toMatchObject({
        code: invalid ? "ENOEXEC" : missing ? "ENOENT" : "EACCES",
      });
      if (stateChange === "directory") expect(String(state.failures[0])).toContain("directory");
      expect(state.contexts).toEqual([]);
      expect(state.loads).toBe(0);
    } finally {
      state.supervisor.dispose();
    }
  });
}

test("cached modules still require a live file for every spawn", async () => {
  const state = fixture();
  try {
    const first = state.supervisor.reserveSpawn(state.root, request("/bin/test-guest"));
    await state.supervisor.start(first);
    expect(waitStatus(await state.supervisor.waitForExit(state.root, first))).toBe(23);
    state.fs.remove("/bin/test-guest");
    const second = state.supervisor.reserveSpawn(state.root, request("/bin/test-guest"));
    await state.supervisor.start(second);
    expect(waitStatus(await state.supervisor.waitForExit(state.root, second))).toBe(127);
    state.fs.mkdirp("/bin/test-guest");
    const third = state.supervisor.reserveSpawn(state.root, request("/bin/test-guest"));
    await state.supervisor.start(third);
    expect(waitStatus(await state.supervisor.waitForExit(state.root, third))).toBe(126);
    expect(state.loads).toBe(1);
    expect(state.contexts).toHaveLength(1);
  } finally {
    state.supervisor.dispose();
  }
});

test("shebang execution substitutes the registered interpreter and preserves script argv", async () => {
  const state = fixture();
  try {
    state.fs.writeFile("/bin/interpreter", new Uint8Array());
    state.registry.register("/bin/interpreter", {
      adapter: "interpreter",
      module,
    });
    state.fs.writeFile("/bin/script", "#! /bin/interpreter -x y\nignored body");
    expect(await state.registry.check("./script", "/bin")).toMatchObject({
      adapter: "interpreter",
    });
    const pid = state.supervisor.reserveSpawn(state.root, {
      ...request("./script", "/bin"),
      argv: ["./script", "first", "second"],
    });
    await state.supervisor.start(pid);
    expect(await state.supervisor.waitForExit(state.root, pid)).toEqual({
      kind: "exited",
      code: 23,
      status: 23,
    });
    expect(state.contexts[0]).toMatchObject({
      adapter: "interpreter",
      request: {
        executable: "./script",
        cwd: "/bin",
        argv: ["/bin/interpreter", "-x y", "./script", "first", "second"],
      },
    });
  } finally {
    state.supervisor.dispose();
  }
});

for (const suffix of ["   ", "\t\t", " \t \t"])
  test(`shebang optional arguments trim trailing blanks (${JSON.stringify(suffix)})`, async () => {
    const state = fixture();
    try {
      state.fs.writeFile("/usr/bin/env", new Uint8Array());
      state.registry.register("/usr/bin/env", { adapter: "env-fixture", module });
      state.fs.writeFile("/bin/script", `#!/usr/bin/env node${suffix}\n`);
      const pid = state.supervisor.reserveSpawn(state.root, {
        ...request("/bin/script"),
        argv: ["/bin/script", "argument"],
      });
      await state.supervisor.start(pid);
      expect(await state.supervisor.waitForExit(state.root, pid)).toMatchObject({
        kind: "exited",
        code: 23,
      });
      expect(state.contexts[0]?.request.argv).toEqual([
        "/usr/bin/env",
        "node",
        "/bin/script",
        "argument",
      ]);
    } finally {
      state.supervisor.dispose();
    }
  });

test("shebang lines with only trailing blanks have no optional argument", async () => {
  const state = fixture();
  try {
    state.fs.writeFile("/bin/interpreter", new Uint8Array());
    state.registry.register("/bin/interpreter", { adapter: "interpreter", module });
    state.fs.writeFile("/bin/script", "#!/bin/interpreter \t \t\n");
    const pid = state.supervisor.reserveSpawn(state.root, request("/bin/script"));
    await state.supervisor.start(pid);
    expect(await state.supervisor.waitForExit(state.root, pid)).toMatchObject({
      kind: "exited",
      code: 23,
    });
    expect(state.contexts[0]?.request.argv).toEqual(["/bin/interpreter", "/bin/script"]);
  } finally {
    state.supervisor.dispose();
  }
});

test("shebang execution follows a package-bin symlink while retaining its caller path", async () => {
  const state = fixture();
  try {
    state.fs.writeFile("/bin/interpreter", new Uint8Array());
    state.registry.register("/bin/interpreter", { adapter: "interpreter", module });
    state.fs.mkdirp("/project/node_modules/.bin");
    state.fs.writeFile("/project/vite.js", "#!/bin/interpreter\n");
    const link = state.fs.resolveAbsolute("/project/node_modules/.bin/vite");
    if (typeof link === "number") throw new Error("missing symlink path");
    expect(state.fs.symlink(link, "../../vite.js")).toBe(0);
    const pid = state.supervisor.reserveSpawn(state.root, {
      ...request("./node_modules/.bin/vite", "/project"),
      argv: ["./node_modules/.bin/vite", "--version"],
    });
    await state.supervisor.start(pid);
    expect(await state.supervisor.waitForExit(state.root, pid)).toMatchObject({
      kind: "exited",
      code: 23,
    });
    expect(state.contexts[0]?.request.argv).toEqual([
      "/bin/interpreter",
      "./node_modules/.bin/vite",
      "--version",
    ]);
  } finally {
    state.supervisor.dispose();
  }
});

test("missing shebang interpreters fail access and spawn with ENOENT", async () => {
  const state = fixture();
  try {
    state.fs.writeFile("/bin/script", "#!/bin/missing\n");
    await expect(state.registry.check("/bin/script")).rejects.toMatchObject({ code: "ENOENT" });
    const pid = state.supervisor.reserveSpawn(state.root, request("/bin/script"));
    await state.supervisor.start(pid);
    expect(await state.supervisor.waitForExit(state.root, pid)).toMatchObject({
      kind: "start-failed",
      error: "ENOENT",
      code: 2,
    });
  } finally {
    state.supervisor.dispose();
  }
});

test("shebang recursion is bounded and cycles report ELOOP", async () => {
  const state = fixture();
  try {
    state.fs.writeFile("/bin/a", "#!/bin/b\n");
    state.fs.writeFile("/bin/b", "#!/bin/a\n");
    await expect(state.registry.check("/bin/a")).rejects.toMatchObject({ code: "ELOOP" });
    const pid = state.supervisor.reserveSpawn(state.root, request("/bin/a"));
    await state.supervisor.start(pid);
    expect(await state.supervisor.waitForExit(state.root, pid)).toMatchObject({
      kind: "start-failed",
      error: "ELOOP",
      code: 40,
    });
  } finally {
    state.supervisor.dispose();
  }
});

test("registered executables keep priority over file contents", async () => {
  const state = fixture();
  try {
    state.fs.writeFile("/bin/test-guest", "#!/bin/missing\n");
    const pid = state.supervisor.reserveSpawn(state.root, request("/bin/test-guest"));
    await state.supervisor.start(pid);
    expect(await state.supervisor.waitForExit(state.root, pid)).toMatchObject({
      kind: "exited",
      code: 23,
    });
    expect(state.contexts[0]?.request.argv).toEqual(["/bin/test-guest"]);
  } finally {
    state.supervisor.dispose();
  }
});

test("malformed shebangs retain ENOEXEC instead of guessing a shell", async () => {
  const state = fixture();
  try {
    state.fs.writeFile("/bin/malformed", "#!\nplain text");
    const pid = state.supervisor.reserveSpawn(state.root, request("/bin/malformed"));
    await state.supervisor.start(pid);
    expect(await state.supervisor.waitForExit(state.root, pid)).toMatchObject({
      kind: "start-failed",
      error: "ENOEXEC",
      code: 8,
    });
  } finally {
    state.supervisor.dispose();
  }
});

test("asynchronous filesystem admission retains the exact registered program", async () => {
  let release!: (file: { path: "/bin/test-guest"; kind: "file" }) => void;
  const lookup = new Promise<{ path: "/bin/test-guest"; kind: "file" }>((resolve) => {
    release = resolve;
  });
  const registry = new ExecutableRegistry(() => lookup);
  registry.register("/bin/test-guest", { module, adapter: "original", interruptible: true });
  const pending = registry.resolve("./test-guest", "/bin");
  registry.unregister("/bin/test-guest");
  registry.register("/bin/test-guest", { module, adapter: "replacement", interruptible: false });
  release({ path: "/bin/test-guest", kind: "file" });
  expect(await pending).toEqual({
    kind: "module",
    module,
    adapter: "original",
    interruptible: true,
  });
  expect(await registry.resolve("/bin/test-guest")).toEqual({
    kind: "module",
    module,
    adapter: "replacement",
    interruptible: false,
  });
});

test("cancellation during filesystem admission releases descriptors and never launches", async () => {
  let release!: (file: { path: "/bin/test-guest"; kind: "file" }) => void;
  const lookup = new Promise<{ path: "/bin/test-guest"; kind: "file" }>((resolve) => {
    release = resolve;
  });
  const registry = new ExecutableRegistry(() => lookup);
  let loads = 0;
  registry.register("/bin/test-guest", {
    module: () => {
      loads++;
      return module;
    },
    adapter: "test",
  });
  let closed = 0,
    launched = 0;
  const supervisor = new ProcessSupervisor({
    registry,
    launch() {
      launched++;
      return { terminate() {} };
    },
  });
  try {
    const root = supervisor.createRoot();
    const fd = supervisor
      .get(root)!
      .descriptors.open({ kind: "directory", handle: 1 }, 0n, 0n, () => {
        closed++;
      });
    const pid = supervisor.reserveSpawn(root, {
      ...request("/bin/test-guest"),
      fds: [{ parent: fd, child: 4 }],
    });
    supervisor.get(root)!.descriptors.close(fd);
    const starting = supervisor.start(pid);
    supervisor.kill(pid, Signal.SIGKILL);
    expect(await supervisor.waitForExit(root, pid)).toEqual({
      kind: "signaled",
      code: 9,
      status: 137,
    });
    expect(closed).toBe(1);
    release({ path: "/bin/test-guest", kind: "file" });
    await starting;
    expect(launched).toBe(0);
    expect(loads).toBe(0);
    expect(closed).toBe(1);
  } finally {
    release({ path: "/bin/test-guest", kind: "file" });
    supervisor.dispose();
  }
});

test("executable checks share live admission rules without loading modules", async () => {
  const state = fixture();
  try {
    expect(await state.registry.check("../bin/./test-guest", "/bin")).toMatchObject({
      adapter: "test",
      interruptible: true,
    });
    expect(state.loads).toBe(0);
    expect(state.contexts).toHaveLength(0);
    for (const [path, code] of [
      ["/bin/test-guest/", "ENOTDIR"],
      ["/missing/../bin/test-guest", "ENOENT"],
      ["/bin/test-guest/../test-guest", "ENOTDIR"],
      ["/../missing/../bin/test-guest", "ENOENT"],
      ["/../bin/test-guest/../test-guest", "ENOTDIR"],
    ]) {
      await expect(state.registry.check(path!)).rejects.toMatchObject({ code });
    }
    state.registry.unregister("/bin/test-guest");
    await expect(state.registry.check("/bin/test-guest")).rejects.toMatchObject({ code: "EACCES" });
    state.fs.remove("/bin/test-guest");
    await expect(state.registry.check("/bin/test-guest")).rejects.toMatchObject({ code: "ENOENT" });
    expect(state.loads).toBe(0);
  } finally {
    state.supervisor.dispose();
  }
});

test("canceling a process does not cancel compilation shared with another process", async () => {
  let compile!: (module: WebAssembly.Module) => void, loaded!: () => void;
  const loading = new Promise<void>((resolve) => {
    loaded = resolve;
  });
  const compilation = new Promise<WebAssembly.Module>((resolve) => {
    compile = resolve;
  });
  let loads = 0,
    launches = 0;
  const registry = new ExecutableRegistry((path) => ({ path, kind: "file" }));
  registry.register("/bin/test-guest", {
    adapter: "test",
    module: () => {
      loads++;
      loaded();
      return compilation;
    },
  });
  const supervisor = new ProcessSupervisor({
    registry,
    launch(context) {
      launches++;
      context.exit(23);
      return { terminate() {} };
    },
  });
  try {
    const root = supervisor.createRoot();
    const first = supervisor.reserveSpawn(root, request("/bin/test-guest"));
    const second = supervisor.reserveSpawn(root, request("/bin/test-guest"));
    const startingFirst = supervisor.start(first);
    await loading;
    const startingSecond = supervisor.start(second);
    supervisor.kill(first, Signal.SIGKILL);
    expect(waitStatus(await supervisor.waitForExit(root, first))).toBe(137);
    compile(module);
    await Promise.all([startingFirst, startingSecond]);
    expect(waitStatus(await supervisor.waitForExit(root, second))).toBe(23);
    expect(loads).toBe(1);
    expect(launches).toBe(1);
  } finally {
    compile(module);
    supervisor.dispose();
  }
});

test("absolute executable checks clamp parent-of-root without weakening WASI capability paths", async () => {
  const state = fixture();
  try {
    expect(state.fs.resolve(state.fs.preopen("/"), "../bin/test-guest")).toBe(63);
    for (const path of ["/../bin/test-guest", "/bin/../../bin/test-guest"]) {
      expect(await state.registry.check(path)).toMatchObject({ adapter: "test" });
    }
    expect(await state.registry.check("../bin/test-guest", "/")).toMatchObject({ adapter: "test" });
    expect(state.loads).toBe(0);
    expect(state.contexts).toHaveLength(0);
  } finally {
    state.supervisor.dispose();
  }
});
