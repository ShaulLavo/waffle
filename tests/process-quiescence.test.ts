import { expect, test } from "bun:test";
import { ExecutableRegistry, ProcessSupervisor, readOutcome, type ProcessContext, type ProcessHandle, type SpawnRequest } from "../proc";
import { createFilesystemIdentity, FilesystemSection, revokeFilesystem, waitForFilesystemQuiescence } from "../fs/protocol";

const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const request: SpawnRequest = { executable: "custom", argv: [], env: {}, cwd: "/", job: 0, fds: [] };
const turn = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function registry() {
  const registry = new ExecutableRegistry();
  registry.register("custom", { module, adapter: "custom" });
  return registry;
}

for (const completion of ["kill", "exit", "dispose"] as const) test(`${completion} publishes and revokes before fencing, but stops a custom handle only after its filesystem section drains`, async () => {
  const identity = createFilesystemIdentity();
  const section = new FilesystemSection(identity);
  const stoppedWithActiveSection: number[] = [];
  let child = 0;
  let context!: ProcessContext;
  const supervisor = new ProcessSupervisor({ registry: registry(),
    launch(value) {
      context = value;
      context.registerRevocation(() => revokeFilesystem(identity));
      return { terminate() { stoppedWithActiveSection.push(Atomics.load(new Int32Array(identity.sections), 0)); } };
    },
    quiesce: pid => pid === child ? waitForFilesystemQuiescence(identity) : undefined,
  });
  const root = supervisor.createRoot();
  child = supervisor.reserveSpawn(root, request);
  let entered = false;
  try {
    await supervisor.start(child);
    section.enter();
    entered = true;
    const record = supervisor.get(child)!;
    const waiting = supervisor.waitForExit(root, child);
    if (completion === "exit") context.exit(23);
    else if (completion === "kill") supervisor.kill(child, 9);
    else supervisor.dispose();
    expect(readOutcome(context.outcome)?.status).toBe(completion === "exit" ? 23 : 137);
    expect(record.revoked).toBe(true);
    expect(record.result).toBeNull();
    await turn();
    expect(stoppedWithActiveSection).toEqual([]);
    section.exit();
    entered = false;
    expect((await waiting).status).toBe(completion === "exit" ? 23 : 137);
    expect(stoppedWithActiveSection).toEqual([0]);
  } finally {
    if (entered) section.exit();
    supervisor.dispose();
    await turn();
  }
});

for (const release of ["before-fence", "after-fence"] as const) test(`a late custom launch handle arriving ${release} stops only after successful quiescence`, async () => {
  const admission = deferred<ProcessHandle>();
  const launched = deferred<void>();
  const fence = deferred<void>();
  let child = 0, stops = 0;
  const supervisor = new ProcessSupervisor({ registry: registry(), launch() { launched.resolve(); return admission.promise; }, quiesce: pid => pid === child ? fence.promise : undefined });
  const root = supervisor.createRoot();
  child = supervisor.reserveSpawn(root, request);
  const starting = supervisor.start(child);
  const handle = { terminate() { stops++; } };
  try {
    await launched.promise;
    supervisor.kill(child, 9);
    const waiting = supervisor.waitForExit(root, child);
    if (release === "before-fence") {
      admission.resolve(handle);
      await starting;
      expect(stops).toBe(0);
      expect(supervisor.get(child)!.handle).toBe(handle);
    }
    fence.resolve();
    expect((await waiting).status).toBe(137);
    if (release === "after-fence") {
      expect(stops).toBe(0);
      admission.resolve(handle);
      await starting;
    }
    expect(stops).toBe(1);
  } finally {
    admission.resolve(handle);
    fence.resolve();
    await starting;
    supervisor.dispose();
  }
});

for (const failure of ["throw", "reject"] as const) for (const late of [false, true]) test(`${failure}ing quiescence retains a ${late ? "late" : "running"} custom handle without physical stop`, async () => {
  const error = new Error("filesystem fence failed");
  const admission = deferred<ProcessHandle>();
  const launched = deferred<void>();
  const errors: unknown[] = [];
  let child = 0, stops = 0;
  const handle = { terminate() { stops++; } };
  const supervisor = new ProcessSupervisor({ registry: registry(),
    launch() { launched.resolve(); return late ? admission.promise : handle; },
    quiesce(pid) { if (pid !== child) return; if (failure === "throw") throw error; return Promise.reject(error); },
    onError: error => errors.push(error),
  });
  const root = supervisor.createRoot();
  child = supervisor.reserveSpawn(root, request);
  const starting = supervisor.start(child);
  try {
    await launched.promise;
    if (!late) await starting;
    supervisor.kill(child, 9);
    admission.resolve(handle);
    await starting;
    await turn();
    const record = supervisor.get(child)!;
    expect(readOutcome(record.outcome)?.status).toBe(137);
    expect(record.revoked).toBe(true);
    expect(record.result).toBeNull();
    expect(record.handle).toBe(handle);
    expect(errors).toEqual([error]);
    expect(stops).toBe(0);
    supervisor.dispose();
    expect(stops).toBe(0);
    expect(record.handle).toBe(handle);
  } finally {
    admission.resolve(handle);
    await starting;
    supervisor.dispose();
  }
});

test("safe logical exit never waits for the custom handle's physical stop promise", async () => {
  const stopping = deferred<void>();
  const fence = deferred<void>();
  let child = 0, stops = 0;
  const supervisor = new ProcessSupervisor({ registry: registry(), launch: () => ({ terminate() { stops++; return stopping.promise; } }), quiesce: pid => pid === child ? fence.promise : undefined });
  const root = supervisor.createRoot();
  child = supervisor.reserveSpawn(root, request);
  try {
    await supervisor.start(child);
    supervisor.kill(child, 9);
    expect(stops).toBe(0);
    fence.resolve();
    expect((await supervisor.waitForExit(root, child)).status).toBe(137);
    expect(stops).toBe(1);
  } finally {
    fence.resolve();
    stopping.resolve();
    supervisor.dispose();
  }
});
