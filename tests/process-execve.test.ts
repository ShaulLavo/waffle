import { expect, test } from "bun:test";
import { MemoryBackend } from "../fs/backend";
import { ExecutableNotFound, ExecutableNotRunnable, ExecutableRegistry, ProcessSupervisor, Signal, waitStatus, type ProcessContext, type SpawnRequest } from "../proc";

const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const request = (executable: string, cwd = "/"): SpawnRequest => ({ executable, argv: [executable], env: {}, cwd, job: 0, fds: [] });

function fixture() {
  const backend = new MemoryBackend(), fs = backend.fs;
  fs.writeFile("/bin/test-guest", new Uint8Array());
  let loads = 0;
  const lookups: string[] = [], contexts: ProcessContext[] = [], failures: unknown[] = [];
  const registry = new ExecutableRegistry(path => { lookups.push(path); return backend.execute("resolvePath", [path], new Uint8Array()) as { path: string; kind: "file" | "dir" } | undefined; });
  registry.register("/bin/test-guest", { adapter: "test", module: () => { loads++; return module; }, interruptible: true });
  const supervisor = new ProcessSupervisor({ registry, startFailed(_pid, error) { failures.push(error); }, launch(context) {
    contexts.push(context); context.exit(23); return { terminate() {} };
  } });
  const root = supervisor.createRoot();
  return { fs, registry, supervisor, root, lookups, contexts, failures, get loads() { return loads; } };
}

for (const [executable, cwd] of [["./test-guest", "/bin"], ["test-guest", "/bin"], ["/bin/../bin/./test-guest", "/elsewhere"], ["/../bin/test-guest", "/"], ["../bin/test-guest", "/"], ["/bin/../../bin/test-guest", "/"]] as const) {
  test(`spawn resolves ${executable} against cwd ${cwd}`, async () => {
    const state = fixture();
    try {
      const spec = request(executable, cwd);
      const pid = state.supervisor.reserveSpawn(state.root, spec);
      spec.cwd = "/changed-after-spawn";
      await state.supervisor.start(pid);
      expect(await state.supervisor.waitForExit(state.root, pid)).toEqual({ kind: "exited", code: 23, status: 23 });
      expect(state.lookups).toEqual([executable.startsWith("/") ? executable : `${cwd}/${executable}`]);
      expect(state.contexts[0]?.request.cwd).toBe(cwd);
      expect(state.contexts[0]?.interruptible).toBe(true);
      expect(state.loads).toBe(1);
    } finally { state.supervisor.dispose(); }
  });
}

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
      expect(result).toEqual({ kind: "start-failed", code: missing ? 2 : 13, error: missing ? "ENOENT" : "EACCES", status: null });
      expect(waitStatus(result)).toBe(missing ? 127 : 126);
      expect(state.failures[0]).toBeInstanceOf(missing ? ExecutableNotFound : ExecutableNotRunnable);
      expect(state.failures[0]).toMatchObject({ code: missing ? "ENOENT" : "EACCES" });
      if (stateChange === "directory") expect(String(state.failures[0])).toContain("directory");
      expect(state.contexts).toEqual([]);
      expect(state.loads).toBe(0);
    } finally { state.supervisor.dispose(); }
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
  } finally { state.supervisor.dispose(); }
});

test("asynchronous filesystem admission retains the exact registered program", async () => {
  let release!: (file: { path: "/bin/test-guest", kind: "file" }) => void;
  const lookup = new Promise<{ path: "/bin/test-guest", kind: "file" }>(resolve => { release = resolve; });
  const registry = new ExecutableRegistry(() => lookup);
  registry.register("/bin/test-guest", { module, adapter: "original", interruptible: true });
  const pending = registry.resolve("./test-guest", "/bin");
  registry.unregister("/bin/test-guest");
  registry.register("/bin/test-guest", { module, adapter: "replacement", interruptible: false });
  release({ path: "/bin/test-guest", kind: "file" });
  expect(await pending).toEqual({ module, adapter: "original", interruptible: true });
  expect(await registry.resolve("/bin/test-guest")).toEqual({ module, adapter: "replacement", interruptible: false });
});

test("cancellation during filesystem admission releases descriptors and never launches", async () => {
  let release!: (file: { path: "/bin/test-guest", kind: "file" }) => void;
  const lookup = new Promise<{ path: "/bin/test-guest", kind: "file" }>(resolve => { release = resolve; });
  const registry = new ExecutableRegistry(() => lookup);
  let loads = 0;
  registry.register("/bin/test-guest", { module: () => { loads++; return module; }, adapter: "test" });
  let closed = 0, launched = 0;
  const supervisor = new ProcessSupervisor({ registry, launch() { launched++; return { terminate() {} }; } });
  try {
    const root = supervisor.createRoot();
    const fd = supervisor.get(root)!.descriptors.open({ kind: "directory", handle: 1 }, 0n, 0n, () => { closed++; });
    const pid = supervisor.reserveSpawn(root, { ...request("/bin/test-guest"), fds: [{ parent: fd, child: 4 }] });
    supervisor.get(root)!.descriptors.close(fd);
    const starting = supervisor.start(pid);
    supervisor.kill(pid, Signal.SIGKILL);
    expect(await supervisor.waitForExit(root, pid)).toEqual({ kind: "signaled", code: 9, status: 137 });
    expect(closed).toBe(1);
    release({ path: "/bin/test-guest", kind: "file" });
    await starting;
    expect(launched).toBe(0);
    expect(loads).toBe(0);
    expect(closed).toBe(1);
  } finally { release({ path: "/bin/test-guest", kind: "file" }); supervisor.dispose(); }
});

test("executable checks share live admission rules without loading modules", async () => {
  const state = fixture();
  try {
    expect(await state.registry.check("../bin/./test-guest", "/bin")).toMatchObject({ adapter: "test", interruptible: true });
    expect(state.loads).toBe(0);
    expect(state.contexts).toHaveLength(0);
    for (const [path, code] of [["/bin/test-guest/", "ENOTDIR"], ["/missing/../bin/test-guest", "ENOENT"], ["/bin/test-guest/../test-guest", "ENOTDIR"], ["/../missing/../bin/test-guest", "ENOENT"], ["/../bin/test-guest/../test-guest", "ENOTDIR"]]) {
      await expect(state.registry.check(path!)).rejects.toMatchObject({ code });
    }
    state.registry.unregister("/bin/test-guest");
    await expect(state.registry.check("/bin/test-guest")).rejects.toMatchObject({ code: "EACCES" });
    state.fs.remove("/bin/test-guest");
    await expect(state.registry.check("/bin/test-guest")).rejects.toMatchObject({ code: "ENOENT" });
    expect(state.loads).toBe(0);
  } finally { state.supervisor.dispose(); }
});

test("canceling a process does not cancel compilation shared with another process", async () => {
  let compile!: (module: WebAssembly.Module) => void, loaded!: () => void;
  const loading = new Promise<void>(resolve => { loaded = resolve; });
  const compilation = new Promise<WebAssembly.Module>(resolve => { compile = resolve; });
  let loads = 0, launches = 0;
  const registry = new ExecutableRegistry(path => ({ path, kind: "file" }));
  registry.register("/bin/test-guest", { adapter: "test", module: () => { loads++; loaded(); return compilation; } });
  const supervisor = new ProcessSupervisor({ registry, launch(context) { launches++; context.exit(23); return { terminate() {} }; } });
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
  } finally { compile(module); supervisor.dispose(); }
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
  } finally { state.supervisor.dispose(); }
});
