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
      expect(readOutcome(record.outcome)).toBeNull();
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
