import { expect, test } from "bun:test";
import { MemFS } from "../fs/memory";
import { ExecutableNotFound, ExecutableNotRunnable, ExecutableRegistry, ProcessSupervisor, Signal, waitStatus, type ProcessContext, type SpawnRequest } from "../proc";

const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const request = (executable: string, cwd = "/"): SpawnRequest => ({ executable, argv: [executable], env: {}, cwd, job: 0, fds: [] });

function fixture() {
  const fs = new MemFS();
  fs.writeFile("/bin/test-guest", new Uint8Array());
  let loads = 0;
  const lookups: string[] = [], contexts: ProcessContext[] = [], failures: unknown[] = [];
  const registry = new ExecutableRegistry(path => { lookups.push(path); return fs.lookup(path); });
  registry.register("/bin/test-guest", { adapter: "test", module: () => { loads++; return module; }, interruptible: true });
  const supervisor = new ProcessSupervisor({ registry, startFailed(_pid, error) { failures.push(error); }, launch(context) {
    contexts.push(context); context.exit(23); return { terminate() {} };
  } });
  const root = supervisor.createRoot();
  return { fs, registry, supervisor, root, lookups, contexts, failures, get loads() { return loads; } };
}

for (const [executable, cwd] of [["./test-guest", "/bin"], ["test-guest", "/bin"], ["/bin/../bin/./test-guest", "/elsewhere"]] as const) {
  test(`spawn resolves ${executable} against cwd ${cwd}`, async () => {
    const state = fixture();
    try {
      const spec = request(executable, cwd);
      const pid = state.supervisor.reserveSpawn(state.root, spec);
      spec.cwd = "/changed-after-spawn";
      await state.supervisor.start(pid);
      expect(await state.supervisor.waitForExit(state.root, pid)).toEqual({ kind: "exited", code: 23, status: 23 });
      expect(state.lookups).toEqual(["/bin/test-guest"]);
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
  let release!: (file: { kind: "file" }) => void;
  const lookup = new Promise<{ kind: "file" }>(resolve => { release = resolve; });
  const registry = new ExecutableRegistry(() => lookup);
  registry.register("/bin/test-guest", { module, adapter: "original", interruptible: true });
  const pending = registry.resolve("./test-guest", "/bin");
  registry.unregister("/bin/test-guest");
  registry.register("/bin/test-guest", { module, adapter: "replacement", interruptible: false });
  release({ kind: "file" });
  expect(await pending).toEqual({ module, adapter: "original", interruptible: true });
  expect(await registry.resolve("/bin/test-guest")).toEqual({ module, adapter: "replacement", interruptible: false });
});

test("cancellation during filesystem admission releases descriptors and never launches", async () => {
  let release!: (file: { kind: "file" }) => void;
  const lookup = new Promise<{ kind: "file" }>(resolve => { release = resolve; });
  const registry = new ExecutableRegistry(() => lookup);
  registry.register("/bin/test-guest", { module, adapter: "test" });
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
    release({ kind: "file" });
    await starting;
    expect(launched).toBe(0);
    expect(closed).toBe(1);
  } finally { release({ kind: "file" }); supervisor.dispose(); }
});
