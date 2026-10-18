import { expect, test } from "bun:test";
import { ProcessABI } from "../proc/abi.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { ProcessSupervisor } from "../proc/supervisor.js";
import { claimOutcome, outcomeWord, readOutcome, serializeOutcome } from "../proc/outcome.js";
import { MemoryBackend } from "../fs/backend.js";
import { ProcessError } from "../proc/types.js";

const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const failures = [
  ["ENOENT", 2, 44], ["EACCES", 13, 2], ["ENOTDIR", 20, 54], ["ENOEXEC", 8, 45],
  ["ENOMEM", 12, 48], ["EAGAIN", 11, 6], ["EIO", 5, 29],
] as const;
for (const [error, code, wasi] of failures) {
  test(`${error} stays typed through consuming process and job ABI waits`, async () => {
    const backend = new MemoryBackend();
    backend.fs.writeFile("/bin/fixture", "");
    const registry = new ExecutableRegistry(path => backend.execute("resolvePath", [path], new Uint8Array()));
    registry.register("/bin/fixture", { adapter: "preview1", module: () => {
      if (error === "ENOEXEC") return new WebAssembly.Module(new Uint8Array([1, 2, 3]));
      if (error === "ENOMEM") throw new RangeError("allocation failed");
      if (error === "EAGAIN") throw new ProcessError(6, "capacity exhausted");
      throw new Error("loader or host failed");
    } });
    const executable = error === "ENOENT" ? "/bin/missing" : error === "ENOTDIR" ? "/bin/fixture/child"
      : error === "EACCES" ? "/bin" : "/bin/fixture";
    const supervisor = new ProcessSupervisor({ registry, launch() { throw new Error("must not launch"); } });
    const shell = supervisor.createRoot();
    const memory = new WebAssembly.Memory({ initial: 1 });
    const abi = new ProcessABI({ memory, descriptors: supervisor.get(shell)!.descriptors,
      fs: backend.fs, pid: shell, service: supervisor, signals: supervisor.get(shell)! });
    try {
      const pid = supervisor.spawn(shell, { executable, argv: [], env: {}, cwd: "/", job: 0, fds: [] });
      const job = supervisor.jobOf(pid);
      const expected = { kind: "start-failed", error, code, status: null };
      expect(await supervisor.waitForExit(shell, pid)).toEqual(expected);
      // The first four bytes fitting is not enough, and neither fault may consume.
      expect(abi.imports.wait!(pid, 65532)).toBe(-21);
      expect(abi.imports.wait_job!(job, 1, 65532)).toBe(-21);
      expect(abi.imports.wait!(pid, 64)).toBe(0);
      const view = new DataView(memory.buffer);
      expect([view.getUint32(64, true), view.getInt32(68, true)]).toEqual([2, wasi]);
      expect(abi.imports.wait!(pid, 64)).toBe(-12);
      expect(abi.imports.wait_job!(job, 0, 72)).toBe(0);
      expect([view.getUint32(72, true), view.getInt32(76, true)]).toEqual([2, wasi]);
      expect(abi.imports.wait_job!(job, 1, 72)).toBe(-12);
    } finally { supervisor.dispose(); }
  });
}

for (const status of [126, 127]) test(`a program exiting ${status} remains an ordinary exit`, async () => {
  const registry = new ExecutableRegistry();
  registry.register("fixture", { module, adapter: "preview1" });
  const supervisor = new ProcessSupervisor({ registry, launch(context) {
    context.exit(status); return { terminate() {} };
  } });
  const shell = supervisor.createRoot();
  try {
    const pid = supervisor.spawn(shell, { executable: "fixture", argv: [], env: {}, cwd: "/", job: 0, fds: [] });
    expect(await supervisor.waitForExit(shell, pid)).toEqual({ kind: "exited", code: status, status });
    const memory = new WebAssembly.Memory({ initial: 1 });
    const abi = new ProcessABI({ memory, descriptors: supervisor.get(shell)!.descriptors,
      fs: new MemoryBackend().fs, pid: shell, service: supervisor, signals: supervisor.get(shell)! });
    const job = supervisor.jobOf(pid);
    expect(abi.imports.wait!(pid, 64)).toBe(0);
    expect(abi.imports.wait_job!(job, 0, 72)).toBe(0);
    const view = new DataView(memory.buffer);
    expect([view.getUint32(64, true), view.getInt32(68, true)]).toEqual([0, status]);
    expect([view.getUint32(72, true), view.getInt32(76, true)]).toEqual([0, status]);
  } finally { supervisor.dispose(); }
});

test("start-failed tag is 3 and rejects unsupported errno values", () => {
  const word = outcomeWord();
  expect(() => claimOutcome(word, { kind: "start-failed", code: 126 })).toThrow(RangeError);
  expect(readOutcome(word)).toBeNull();
  claimOutcome(word, { kind: "start-failed", code: 13 });
  expect(Atomics.load(word, 0)).toBe((13n << 3n) | 3n);
});

test("typed startup failure becomes observable only after descriptor release and the filesystem fence", async () => {
  let release!: () => void;
  const fence = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = [];
  const supervisor = new ProcessSupervisor({ registry: new ExecutableRegistry(), launch() { throw new Error("must not launch"); },
    quiesce() { events.push("fence"); return fence; } });
  const shell = supervisor.createRoot();
  const pid = supervisor.reserveSpawn(shell, { executable: "missing", argv: [], env: {}, cwd: "/", job: 0, fds: [] });
  supervisor.get(pid)!.descriptors.open({ kind: "directory", handle: 1 }, 0n, 0n, () => events.push("release"));
  try {
    await supervisor.start(pid);
    expect(readOutcome(supervisor.get(pid)!.outcome)).toMatchObject({ kind: "start-failed", error: "ENOENT", status: null });
    expect(supervisor.wait(shell, pid)).toBeNull();
    expect(supervisor.jobEmpty(shell, supervisor.jobOf(pid))).toBe(false);
    expect(events).toEqual(["release", "fence"]);
    const finished = supervisor.waitForExit(shell, pid);
    release();
    expect(await finished).toEqual({ kind: "start-failed", code: 2, error: "ENOENT", status: null });
  } finally { release(); await fence; supervisor.dispose(); }
});

test("a generic root retains typed EIO when its first process import fails", async () => {
  const { createWorkerProcessTransport, workerProcessState } = await import("../proc/worker-client.js");
  const { createFilesystemConnection } = await import("../fs/protocol.js");
  const { failFirstWorkerImport } = await import("./first-worker-import.js");
  const transport = createWorkerProcessTransport();
  const connection = createFilesystemConnection();
  const state = workerProcessState(transport);
  try {
    const messages: unknown[] = [];
    await failFirstWorkerImport({ module, args: [], env: {}, filesystem: connection.client,
      runtimeProcess: transport, outcome: serializeOutcome(state.signals.outcome) }, message => messages.push(message));
    expect(readOutcome(state.signals.outcome)).toEqual({ kind: "start-failed", code: 5, error: "EIO", status: null });
    expect(messages).toContainEqual(expect.objectContaining({ type: "error", code: 126, message: expect.stringContaining("first worker-client import rejected") }));
  } finally { connection.client.port.close(); connection.server.port.close(); }
});

test("signals use a tagged signal number rather than a shell status in both waits", () => {
  const supervisor = new ProcessSupervisor({ registry: new ExecutableRegistry(), launch() { throw new Error("not launched"); } });
  const shell = supervisor.createRoot(), memory = new WebAssembly.Memory({ initial: 1 });
  const abi = new ProcessABI({ memory, descriptors: supervisor.get(shell)!.descriptors,
    fs: new MemoryBackend().fs, pid: shell, service: supervisor, signals: supervisor.get(shell)! });
  try {
    const pid = supervisor.reserveSpawn(shell, { executable: "fixture", argv: [], env: {}, cwd: "/", job: 0, fds: [] });
    const job = supervisor.jobOf(pid);
    supervisor.kill(pid, 9);
    expect(abi.imports.wait!(pid, 64)).toBe(0);
    expect(abi.imports.wait_job!(job, 0, 72)).toBe(0);
    const view = new DataView(memory.buffer);
    expect([view.getUint32(64, true), view.getInt32(68, true)]).toEqual([1, 9]);
    expect([view.getUint32(72, true), view.getInt32(76, true)]).toEqual([1, 9]);
  } finally { supervisor.dispose(); }
});

for (const [errno, name, code] of [[44, "ENOENT", 2], [2, "EACCES", 13], [54, "ENOTDIR", 20]] as const) {
  test(`loader filesystem errno ${errno} retains explicit ${name}`, async () => {
    const { FilesystemError } = await import("../fs/protocol.js");
    const registry = new ExecutableRegistry();
    registry.register("fixture", { adapter: "fixture", module() { throw new FilesystemError(errno); } });
    const supervisor = new ProcessSupervisor({ registry, launch() { throw new Error("must not launch"); } });
    const shell = supervisor.createRoot();
    try {
      const pid = supervisor.spawn(shell, { executable: "fixture", argv: [], env: {}, cwd: "/", job: 0, fds: [] });
      expect(await supervisor.waitForExit(shell, pid)).toEqual({ kind: "start-failed", error: name, code, status: null });
    } finally { supervisor.dispose(); }
  });
}
