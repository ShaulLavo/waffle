import { expect, test } from "bun:test";
import { ExecutableRegistry, ProcessSupervisor, claimOutcome, readOutcome, type SpawnRequest } from "../proc";

const module = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
const request: SpawnRequest = { executable: "custom", argv: [], env: {}, cwd: "/", job: 0, fds: [] };

for (const failure of ["missing", "compile", "launch"] as const) test(`${failure} startup failure reports once before inherited stderr is released`, async () => {
  const registry = new ExecutableRegistry();
  const error = new Error(`${failure} failed`);
  const events: string[] = [];
  let reported: unknown;
  if (failure !== "missing") registry.register("custom", { module: failure === "compile" ? () => { throw error; } : module, adapter: "custom" });
  const supervisor = new ProcessSupervisor({ registry,
    launch: () => { throw error; },
    startFailed(pid, value) {
      reported = value;
      const record = supervisor.get(pid)!;
      expect(record.revoked).toBe(false);
      expect(readOutcome(record.outcome)).toMatchObject({kind:"start-failed", status:null});
      const stderr = record.descriptors.get(2)!.resource;
      if (stderr.kind !== "terminal") throw new Error("inherited stderr missing");
      stderr.write([new TextEncoder().encode(String(value))]);
      events.push("diagnostic");
    },
  });
  const root = supervisor.createRoot();
  const descriptors = supervisor.get(root)!.descriptors;
  const fd = descriptors.open({ kind: "terminal", read: () => 0, write: chunks => {
    events.push("stderr");
    return chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  }, readiness: () => ({ readable: false, writable: true, hangup: false }), close: () => events.push("closed") }, 7n, 3n);
  const child = supervisor.reserveSpawn(root, { ...request, fds: [{ child: 2, parent: fd }] });
  descriptors.close(fd);
  try {
    await supervisor.start(child);
    expect(events).toEqual(["stderr", "diagnostic", "closed"]);
    expect(failure === "missing" ? (reported as Error).name : reported).toBe(failure === "missing" ? "ExecutableNotFound" : error);
    expect(supervisor.wait(root, child)).toEqual(failure === "missing" ? { kind: "start-failed", code: 2, error: "ENOENT", status: null } : { kind: "start-failed", code: 5, error: "EIO", status: null });
    supervisor.failStart(child, new Error("duplicate startup failure"));
    expect(events).toEqual(["stderr", "diagnostic", "closed"]);
  } finally { supervisor.dispose(); }
});

test("a throwing startup diagnostic reports its error without replacing typed EIO", async () => {
  const registry = new ExecutableRegistry();
  registry.register("custom", { module, adapter: "custom" });
  const startupError = new Error("launcher failed"), diagnosticError = new Error("diagnostic sink failed");
  const errors: unknown[] = [];
  let reports = 0;
  const supervisor = new ProcessSupervisor({ registry, launch: () => { throw startupError; }, startFailed() { reports++; throw diagnosticError; }, onError: error => errors.push(error) });
  const root = supervisor.createRoot();
  const child = supervisor.reserveSpawn(root, request);
  try {
    await supervisor.start(child);
    expect(reports).toBe(1);
    expect(errors).toEqual([diagnosticError]);
    expect(supervisor.wait(root, child)).toEqual({ kind: "start-failed", code: 5, error: "EIO", status: null });
  } finally { supervisor.dispose(); }
});

test("a reentrant startup diagnostic cannot report the same process twice", () => {
  let reports = 0;
  const error = new Error("startup failed");
  const supervisor = new ProcessSupervisor({ registry: new ExecutableRegistry(), launch: () => ({ terminate() {} }), startFailed(pid) { reports++; if (reports === 1) supervisor.failStart(pid, error); } });
  const root = supervisor.createRoot();
  const child = supervisor.reserveSpawn(root, request);
  try {
    supervisor.failStart(child, error);
    expect(reports).toBe(1);
    expect(supervisor.wait(root, child)).toMatchObject({ kind: "start-failed", error: "EIO", status: null });
  } finally { supervisor.dispose(); }
});

for (const settled of ["exited", "signaled", "unconfirmed"] as const) test(`startup failure stays silent after an ${settled} outcome wins`, () => {
  let reports = 0;
  const supervisor = new ProcessSupervisor({ registry: new ExecutableRegistry(), launch: () => ({ terminate() {} }), startFailed: () => { reports++; } });
  const root = supervisor.createRoot();
  const child = supervisor.reserveSpawn(root, request);
  try {
    if (settled === "exited") supervisor.exit(child, 23);
    else if (settled === "signaled") supervisor.kill(child, 9);
    else claimOutcome(supervisor.get(child)!.outcome, { kind: "exited", code: 23 });
    supervisor.failStart(child, new Error("late loader rejection"));
    supervisor.failStart(0x7fffffff, new Error("unknown process"));
    expect(reports).toBe(0);
    expect(supervisor.wait(root, child)?.status).toBe(settled === "signaled" ? 137 : 23);
  } finally { supervisor.dispose(); }
});

test("a worker-selected startup error waits for acknowledgement and an asynchronous diagnostic", async () => {
  let acknowledged = false, reports = 0, closed = 0, resolve!: () => void;
  const pending = new Promise<void>(done => { resolve = done; });
  const error = new Error("worker setup failed");
  const supervisor = new ProcessSupervisor({ registry: new ExecutableRegistry(), launch: () => ({ terminate() {} }),
    canConfirmExit: () => acknowledged, startFailed(_pid, actual) { reports++; expect(actual).toBe(error); return pending; } });
  const root = supervisor.createRoot(), child = supervisor.reserveSpawn(root, request);
  supervisor.get(child)!.descriptors.open({ kind: "terminal", read: () => 0, write: () => 0,
    readiness: () => ({ readable: false, writable: true, hangup: false }), close() { closed++; } }, 0n, 0n);
  try {
    claimOutcome(supervisor.get(child)!.outcome, { kind: "start-failed", code: 5 });
    supervisor.exit(child, 126);
    expect(reports).toBe(0);
    expect(supervisor.wait(root, child)).toBeNull();
    acknowledged = true;
    supervisor.failStart(child, error);
    supervisor.failStart(child, new Error("duplicate"));
    expect(reports).toBe(1);
    expect(closed).toBe(0);
    expect(supervisor.get(child)!.revoked).toBe(false);
    resolve();
    expect(await supervisor.waitForExit(root, child)).toMatchObject({ kind: "start-failed", error: "EIO" });
    expect(closed).toBe(1);
  } finally { resolve(); supervisor.dispose(); }
});

for (const settlement of ["never", "resolve", "reject"] as const) test(`disposal cancels a ${settlement}-settling startup diagnostic without retaining resources`, async () => {
  const registry = new ExecutableRegistry();
  registry.register("custom", { module, adapter: "custom" });
  let resolve!: () => void, reject!: (error: unknown) => void, active!: () => boolean, closed = 0, stopped = 0;
  const pending = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  const errors: unknown[] = [];
  const supervisor = new ProcessSupervisor({ registry, launch: () => ({ terminate() { stopped++; } }),
    startFailed(_pid, _error, current) { active = current; return pending; }, onError: error => errors.push(error) });
  const root = supervisor.createRoot(), child = supervisor.reserveSpawn(root, request);
  const record = supervisor.get(child)!;
  record.descriptors.open({ kind: "terminal", read: () => 0, write: () => 0,
    readiness: () => ({ readable: false, writable: true, hangup: false }), close() { closed++; } }, 0n, 0n);
  try {
    await supervisor.start(child);
    const exited = supervisor.waitForExit(root, child);
    supervisor.failStart(child, new Error("startup failed"));
    expect(active()).toBe(true);
    expect(closed).toBe(0);
    supervisor.dispose();
    expect(active()).toBe(false);
    expect(closed).toBe(1);
    expect(stopped).toBe(1);
    expect(record.revoked).toBe(true);
    expect(record.result).toMatchObject({ kind: "start-failed", error: "EIO" });
    expect(await exited).toBe(record.result);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ errno: 11, message: expect.stringContaining("diagnostic delivery cancelled") });
    if (settlement === "resolve") resolve();
    else if (settlement === "reject") reject(new Error("late diagnostic rejection"));
    await Promise.resolve();
    expect(closed).toBe(1);
    expect(stopped).toBe(1);
    expect(errors).toHaveLength(1);
  } finally { supervisor.dispose(); }
});
