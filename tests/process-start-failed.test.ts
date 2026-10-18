import { expect, test } from "bun:test";
import { ProcessABI } from "../proc/abi";
import { ExecutableRegistry } from "../proc/registry";
import { ProcessSupervisor } from "../proc/supervisor";
import { claimOutcome, outcomeWord, readOutcome } from "../proc/outcome";
import { MemFS } from "../fs/memory";

const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
for (const [executable, error, code, status] of [["missing", "ENOENT", 2, 127], ["broken", "EACCES", 13, 126]] as const) {
  test(`${error} stays typed through process and job wait while the ABI reports ${status}`, async () => {
    const registry = new ExecutableRegistry();
    registry.register("broken", { adapter: "preview1", module: () => { throw new Error("invalid executable"); } });
    const supervisor = new ProcessSupervisor({ registry, launch() { throw new Error("must not launch"); } });
    const shell = supervisor.createRoot();
    const memory = new WebAssembly.Memory({ initial: 1 });
    const abi = new ProcessABI({ memory, descriptors: supervisor.get(shell)!.descriptors,
      fs: new MemFS(), pid: shell, service: supervisor, signals: supervisor.get(shell)! });
    try {
      const pid = supervisor.spawn(shell, { executable, argv: [], env: {}, cwd: "/", job: 0, fds: [] });
      const job = supervisor.jobOf(pid);
      const expected = { kind: "start-failed", error, code, status: null };
      expect(await supervisor.waitForExit(shell, pid)).toEqual(expected);
      expect(abi.imports.wait!(pid, 64)).toBe(0);
      const view = new DataView(memory.buffer);
      expect(view.getUint32(64, true)).toBe(0);
      expect(view.getInt32(68, true)).toBe(status);
      expect(() => supervisor.reap(shell, pid)).toThrow("not a child");
      expect(abi.imports.wait_job!(job, 0, 72)).toBe(0);
      expect(view.getInt32(72, true)).toBe(status);
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
    expect(supervisor.waitJob(shell, supervisor.jobOf(pid))).toEqual({ kind: "exited", code: status, status });
  } finally { supervisor.dispose(); }
});

test("start-failed tag is 3 and rejects errno values outside ENOENT/EACCES", () => {
  const word = outcomeWord();
  expect(() => claimOutcome(word, { kind: "start-failed", code: 126 })).toThrow(RangeError);
  expect(readOutcome(word)).toBeNull();
  claimOutcome(word, { kind: "start-failed", code: 13 });
  expect(Atomics.load(word, 0)).toBe((13n << 2n) | 3n);
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

test("a generic root retains typed EACCES when its first process import fails", async () => {
  const { createWorkerProcessTransport, workerProcessState } = await import("../proc/worker-client");
  const { createFilesystemConnection } = await import("../fs/protocol");
  const { failFirstWorkerImport } = await import("./first-worker-import");
  const transport = createWorkerProcessTransport();
  const connection = createFilesystemConnection();
  const state = workerProcessState(transport);
  try {
    const messages: unknown[] = [];
    await failFirstWorkerImport({ module, args: [], env: {}, filesystem: connection.client,
      runtimeProcess: transport, outcome: state.signals.outcome }, message => messages.push(message));
    expect(readOutcome(state.signals.outcome)).toEqual({ kind: "start-failed", code: 13, error: "EACCES", status: null });
    expect(messages).toContainEqual(expect.objectContaining({ type: "error", code: 126, message: expect.stringContaining("first worker-client import rejected") }));
  } finally { connection.client.port.close(); connection.server.port.close(); }
});
