import { SharedFilesystem } from "../src/shared-fs";
import { SubprocessBroker, type ExecutableRegistration } from "../src/subprocess-broker";
import { SubprocessHost, type ChildTransport, type SpawnMeta } from "../src/subprocess.ts";
import { createFilesystemIdentity, type FilesystemIdentity } from "../../runtime/fs";
import { processFixture, type ProcessFixture } from "./process-fixtures";
import { measureProcessStarts } from "./process-benchmark";

const decoder = new TextDecoder();
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 1));
function equal(actual: unknown, expected: unknown, label: string) { if (actual !== expected) throw new Error(`${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`); }
function truth(value: unknown, label: string): asserts value { if (!value) throw new Error(label); }
const checks: string[] = [];
const activeWorkers = new Set<Worker>();
const NativeWorker = globalThis.Worker;
globalThis.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) { super(url, options); activeWorkers.add(this); }
  override terminate() { activeWorkers.delete(this); super.terminate(); }
};
const fs = new SharedFilesystem();
// These own preview1 fixtures implement runtime_proc signal checkpoints directly and exercise
// handled delivery. Third-party byte registrations are covered by browser-interrupt.ts.
const modules = new Map<ProcessFixture, WebAssembly.Module>();
function module(mode: ProcessFixture) { let result = modules.get(mode); if (!result) { result = new WebAssembly.Module(processFixture(mode)); modules.set(mode, result); } return result; }
interface Child { host: SubprocessHost; handle: number; transport: ChildTransport; filesystem: FilesystemIdentity; stdout: string; stderr: string; }
function scope(entries: Record<string, ExecutableRegistration>, options?: ConstructorParameters<typeof SubprocessBroker>[2]) {
  const broker = new SubprocessBroker(new URL("./worker.js", location.href).href, fs, options);
  for (const [name, entry] of Object.entries(entries)) broker.register(name, entry);
  const children = new Map<number, Child>();
  const hosts: SubprocessHost[] = [];
  function makeHost(parent?: Child) {
    const host = new SubprocessHost({
      budget: parent?.transport.budget, identity: parent?.transport.identity,
      pid: parent?.transport.pid, jobId: parent?.transport.jobId, slot: parent?.transport.slot, token: parent?.transport.token,
      output() {}, onChildClose: pid => broker.close(parent?.transport.pid ?? 1, pid),
      launch(meta, transport) {
        const filesystem = createFilesystemIdentity(parent?.filesystem ?? fs.client.connection);
        const child: Child = { host, handle: transport.pid, transport, filesystem, stdout: "", stderr: "" };
        children.set(transport.pid, child);
        broker.spawn({ executable: meta.executable!, argv: meta.argv, pid: transport.pid, parentPid: transport.parentPid, jobId: transport.jobId,
          cwd: meta.cwd ?? "/home/user", env: meta.env ?? {}, filesystem, child: transport, trace: false, spawnBroker: true });
        return { revoke() { fs.revoke(filesystem); }, terminate() {} };
      },
    });
    hosts.push(host); return host;
  }
  const root = makeHost();
  function spawn(executable: string, meta: Partial<SpawnMeta> = {}, parent?: Child): Child {
    const host = parent ? makeHost(parent) : root;
    const handle = host.spawn(JSON.stringify({ executable, argv: [executable], ...meta }));
    truth(handle > 0, `spawn must return a pid immediately: ${handle}`);
    const child = children.get(handle); truth(child, "launch must retain child transport before spawn returns"); return child;
  }
  return { broker, children, spawn, dispose() { broker.dispose(); for (const host of hosts.reverse()) host.dispose(); } };
}
function drain(child: Child) {
  for (const fd of [1, 2]) for (;;) {
    const bytes = child.host.read(child.host.pipe(child.handle, fd));
    if (!(bytes instanceof Uint8Array)) break;
    if (fd === 1) child.stdout += decoder.decode(bytes); else child.stderr += decoder.decode(bytes);
  }
}
async function until(condition: () => boolean, label: string) {
  const end = performance.now() + 10_000;
  for (;;) { if (condition()) return; if (performance.now() > end) throw new Error(`${label} timed out`); await pause(); }
}
async function ready(child: Child) { await until(() => { drain(child); return child.stdout.includes("ready\n"); }, `pid ${child.transport.pid} first output (${child.stderr})`); }
async function exit(child: Child, expected: number) {
  await until(() => { drain(child); return child.host.wait(child.handle) !== -2; }, `pid ${child.transport.pid} exit`);
  drain(child); equal(child.host.wait(child.handle), expected, `pid ${child.transport.pid} status (${child.stderr})`);
}
async function test(name: string, run: () => Promise<void>) { await run(); checks.push(name); }

try {
  truth(crossOriginIsolated, "process tests require cross-origin isolation");
  await fs.mkdirp("/home/user"); await fs.flush();
  await test("generic-preview1-without-bun-slots", async () => {
    truth(WebAssembly.Module.imports(module("exit")).every(entry => entry.module === "runtime_proc" || entry.module === "wasi_snapshot_preview1"), "fixture must not import Bun slots");
    const s = scope({ tiny: { module: module("exit"), adapter: "preview1", cooperative: true } });
    try { const child = s.spawn("tiny"); await exit(child, 0); equal(child.stdout, "ready\n", "preview1 stdout"); equal(child.stderr, "", "preview1 stderr"); }
    finally { s.dispose(); }
  });
  for (const [signal, status] of [[2, 130], [15, 143], [13, 141], [9, 137]]) {
    await test(`cpu-default-signal-${signal}-status-${status}`, async () => {
      const s = scope({ spin: { module: module("default"), adapter: "preview1", cooperative: true } });
      try {
        const child = s.spawn("spin"); await ready(child);
        const recorded = s.broker.wait(child.transport.pid);
        await s.broker.kill(child.transport.pid, signal!);
        await exit(child, status!);
        const result = await recorded;
        equal(result.kind, "signaled", "signal outcome kind"); equal(result.code, signal, "unregistered signal is claimed by the supervisor");
        equal(Atomics.load(new Int32Array(child.transport.signalState), signal!), 0, "default signal never becomes pending handled work");
        truth(Atomics.load(new Int32Array(child.filesystem.revocations[0]!), 0) !== 0, "signal default action revokes filesystem access");
      } finally { s.dispose(); }
    });
  }
  for (const mode of ["epipe", "epipe-ignored"] as const) await test(`${mode}-keeps-own-exit-42-not-SIGPIPE-141`, async () => {
    const s = scope({ epipe: { module: module(mode), adapter: "preview1", cooperative: true } });
    try {
      const child = s.spawn("epipe");
      // Close before async activation, guaranteeing the guest's ordinary fd_write sees EPIPE.
      equal(child.host.close(child.host.pipe(child.handle, 1)), 0, "close reader");
      const recorded = s.broker.wait(child.transport.pid); await exit(child, 42);
      equal((await recorded).kind, "exited", "handled EPIPE is not default SIGPIPE"); equal(child.stderr, "", "handled EPIPE stderr");
    } finally { s.dispose(); }
  });
  for (const [mode, signal, status] of [["handled", 2, 0], ["handled-term", 15, 0], ["handled-term-23", 15, 23], ["handled-term-143", 15, 143], ["handled-pipe", 13, 42]] as const) {
    await test(`${mode}-signal-${signal}-keeps-own-exit-${status}`, async () => {
      const s = scope({ handled: { module: module(mode), adapter: "preview1", cooperative: true } });
      try {
        const child = s.spawn("handled"); await ready(child); const recorded = s.broker.wait(child.transport.pid);
        equal(Atomics.load(new Int32Array(child.transport.signalState), signal), 2, "handler registered before readiness");
        await s.broker.kill(child.transport.pid, signal); await exit(child, status);
        const result = await recorded;
        equal(result.kind, "exited", "handled signal preserves ordinary exit kind"); equal(result.code, status, "own exit code is not inferred to be a signal");
      } finally { s.dispose(); }
    });
  }
  await test("ignored-PIPE-never-pends-or-revokes-and-guest-keeps-own-zero", async () => {
    const s = scope({ ignored: { module: module("ignored-pipe"), adapter: "preview1", cooperative: true } });
    try {
      const child = s.spawn("ignored"); await ready(child);
      const interruptBefore = Atomics.load(new Int32Array(child.transport.interrupt), 0);
      await s.broker.kill(child.transport.pid, 13);
      equal(Atomics.load(new Int32Array(child.transport.signalState), 13), 1, "ignored PIPE has no pending bit");
      equal(Atomics.load(new Int32Array(child.transport.interrupt), 0), interruptBefore, "ignored PIPE does not request an interrupt wake");
      equal(child.host.wait(child.handle), -2, "ignored PIPE leaves guest alive");
      equal(Atomics.load(new Int32Array(child.filesystem.revocations[0]!), 0), 0, "ignored PIPE does not revoke filesystem");
      const recorded = s.broker.wait(child.transport.pid);
      await s.broker.kill(child.transport.pid, 2); await exit(child, 0);
      equal((await recorded).kind, "exited", "ignored PIPE cannot overwrite later ordinary exit");
    } finally { s.dispose(); }
  });
  await test("last-handler-removal-restores-default-for-next-INT", async () => {
    const s = scope({ once: { module: module("removed"), adapter: "preview1", cooperative: true } });
    try {
      const child = s.spawn("once"); await ready(child);
      await s.broker.kill(child.transport.pid, 2);
      await until(() => { drain(child); return child.stdout.includes("handling\n"); }, "once handler removed acknowledgement");
      equal(Atomics.load(new Int32Array(child.transport.signalState), 2), 0, "last removal resets disposition and clears consumed pending");
      equal(child.host.wait(child.handle), -2, "removal cannot reinterpret already consumed first signal");
      const recorded = s.broker.wait(child.transport.pid);
      await s.broker.kill(child.transport.pid, 2); await exit(child, 130);
      equal((await recorded).kind, "signaled", "second INT applies restored default");
    } finally { s.dispose(); }
  });
  await test("explicit-default-signal-remains-typed-signal-outcome", async () => {
    const s = scope({ explicit: { module: module("explicit-default"), adapter: "preview1", cooperative: true } });
    try {
      const child = s.spawn("explicit"); await ready(child); const recorded = s.broker.wait(child.transport.pid);
      await s.broker.kill(child.transport.pid, 2); await exit(child, 130);
      const result = await recorded; equal(result.kind, "signaled", "explicit default trap is typed"); equal(result.code, 2, "explicit default signal");
    } finally { s.dispose(); }
  });
  await test("handled-INT-then-unrelated-trap-not-signal-default", async () => {
    const s = scope({ trap: { module: module("handled-trap"), adapter: "preview1", cooperative: true } });
    try {
      const child = s.spawn("trap"); await ready(child); const recorded = s.broker.wait(child.transport.pid);
      await s.broker.kill(child.transport.pid, 2); await exit(child, 1);
      equal((await recorded).kind, "exited", "arbitrary RuntimeError must not be inferred to be SIGINT");
    } finally { s.dispose(); }
  });
  await test("KILL-during-active-INT-handler-status-137", async () => {
    const s = scope({ handler: { module: module("handling"), adapter: "preview1", cooperative: true } });
    try {
      const child = s.spawn("handler"); await ready(child);
      equal(child.host.kill(child.handle, 2), 0, "guest SubprocessHost.kill publishes the shared request");
      await until(() => { drain(child); return child.stdout.includes("handling\n"); }, "signal handler output");
      // The acknowledgement proves dequeue completed; no arbitrary delay is needed.
      equal(Atomics.load(new Int32Array(child.transport.signalState), 2), 2, "INT pending bit was consumed, disposition remains handled");
      equal(child.host.wait(child.handle), -2, "catchable INT must not force termination");
      equal(Atomics.load(new Int32Array(child.filesystem.revocations[0]!), 0), 0, "handled INT must not revoke");
      const recorded = s.broker.wait(child.transport.pid); await s.broker.kill(child.transport.pid, 9); await exit(child, 137);
      equal((await recorded).code, 9, "KILL overrides an in-progress handler");
      equal(child.stdout.split("handling\n").length - 1, 1, "broker observation never redelivers a consumed INT request");
    } finally { s.dispose(); }
  });
  await test("mixed-job-members-apply-their-own-default-handled-ignored-dispositions", async () => {
    const s = scope({ active: { module: module("handling"), adapter: "preview1", cooperative: true }, unhandled: { module: module("default"), adapter: "preview1", cooperative: true }, ignored: { module: module("ignored-int"), adapter: "preview1", cooperative: true } });
    try {
      const parent = s.spawn("active", { job: 0 }); await ready(parent);
      const unhandled = s.spawn("unhandled", {}, parent), ignored = s.spawn("ignored", {}, parent);
      await Promise.all([ready(unhandled), ready(ignored)]);
      equal(unhandled.transport.jobId, parent.transport.jobId, "default child shares foreground job");
      equal(ignored.transport.jobId, parent.transport.jobId, "ignored child shares foreground job");
      const unhandledExit = s.broker.wait(unhandled.transport.pid);
      await s.broker.killJob(parent.transport.jobId, 2);
      await exit(unhandled, 130);
      await until(() => { drain(parent); return parent.stdout.includes("handling\n"); }, "mixed job handled acknowledgement");
      equal((await unhandledExit).kind, "signaled", "default member exits on INT");
      equal(parent.host.wait(parent.handle), -2, "handled member remains alive");
      equal(ignored.host.wait(ignored.handle), -2, "ignored member remains alive");
      equal(Atomics.load(new Int32Array(ignored.transport.signalState), 2), 1, "ignored member never queues INT");
      for (const child of [parent, ignored]) equal(Atomics.load(new Int32Array(child.filesystem.revocations[0]!), 0), 0, "nondefault member keeps filesystem capability");
      const remaining = Promise.all([s.broker.wait(parent.transport.pid), s.broker.wait(ignored.transport.pid)]);
      await s.broker.killJob(parent.transport.jobId, 9);
      for (const result of await remaining) { equal(result.kind, "signaled", "KILL ignores member dispositions"); equal(result.status, 137, "KILL member status"); }
      await exit(parent, 137);
      equal((await unhandledExit).status, 130, "later job KILL cannot overwrite completed INT outcome");
    } finally { s.dispose(); }
  });
  await test("delayed-first-activation-does-not-block-other-shell-task", async () => {
    let release!: () => void; let activationCalls = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const s = scope({ tiny: { module: module("exit"), adapter: "preview1", cooperative: true } }, { activate: async () => { activationCalls++; await gate; return import("../../runtime/proc"); } });
    try {
      const child = s.spawn("tiny");
      equal(child.host.wait(child.handle), -2, "delayed spawn returns before activation");
      let ticks = 0;
      for (let i = 0; i < 5; i++) { await pause(); ticks++; equal(child.host.wait(child.handle), -2, "unrelated async task can run before activation"); }
      equal(ticks, 5, "other shell task progressed"); equal(activationCalls, 1, "activation shared once");
      release(); await exit(child, 0);
    } finally { release(); s.dispose(); }
  });
  await test("shared-module-loader-compiles-once-for-concurrent-children", async () => {
    let loads = 0;
    const s = scope({ tiny: { module: async () => { loads++; await pause(); return module("exit"); }, adapter: "preview1", cooperative: true } });
    try { const children = [s.spawn("tiny"), s.spawn("tiny")]; await Promise.all(children.map(child => exit(child, 0))); equal(loads, 1, "registry caches compiled module promise"); }
    finally { s.dispose(); }
  });
  await test("start-failures-are-asynchronous-127-and-126", async () => {
    const s = scope({ broken: { module: async () => { throw new Error("deliberate executable load failure"); }, adapter: "preview1", cooperative: true }, unrunnable: { module: module("unrunnable"), adapter: "preview1", cooperative: true } });
    try {
      const missing = s.spawn("missing"); const broken = s.spawn("broken"); const unrunnable = s.spawn("unrunnable");
      await Promise.all([exit(missing, 127), exit(broken, 126), exit(unrunnable, 126)]);
      const missingResult = await s.broker.wait(missing.transport.pid), brokenResult = await s.broker.wait(broken.transport.pid);
      equal(missingResult.kind, "exited", "missing program is not signaled"); equal(missingResult.code, 127, "missing registry executable"); equal(brokenResult.code, 126, "failed compile/load");
      equal((await s.broker.wait(unrunnable.transport.pid)).code, 126, "unknown imports refuse registered executable at instantiation");
    } finally { s.dispose(); }
  });
  await test("foreground-descendants-reaped-background-survives-next-command", async () => {
    const s = scope({ spin: { module: module("default"), adapter: "preview1", cooperative: true }, tiny: { module: module("exit"), adapter: "preview1", cooperative: true } });
    try {
      const foreground = s.spawn("spin", { job: 0 }); await ready(foreground);
      const descendant = s.spawn("spin", {}, foreground);
      const background = s.spawn("spin", { job: -1 });
      await Promise.all([ready(descendant), ready(background)]);
      equal(descendant.transport.parentPid, foreground.transport.pid, "descendant parent");
      equal(descendant.transport.jobId, foreground.transport.jobId, "descendant inherits foreground job");
      truth(background.transport.jobId !== foreground.transport.jobId, "background has independent job");
      truth(descendant.transport.pid !== descendant.transport.jobId, "job identity is not child pid");
      // Register controller observations before completion can reap the orphan's record.
      // The foreground guest loses its child-control capability when its own process exits.
      const jobExits = Promise.all([s.broker.wait(foreground.transport.pid), s.broker.wait(descendant.transport.pid)]);
      await s.broker.killJob(foreground.transport.jobId, 2);
      for (const result of await jobExits) {
        equal(result.kind, "signaled", "foreground job member has a signal outcome");
        equal(result.code, 2, "foreground job member records INT");
        equal(result.status, 130, "controller observes foreground job member status");
      }
      await exit(foreground, 130);
      equal(descendant.host.wait(descendant.handle), -1, "exited parent cannot wait through its revoked guest capability");
      const supervisor = await s.broker.ready();
      await until(() => supervisor.get(descendant.transport.pid) === undefined, "completed foreground descendant record reaped");
      equal(background.host.wait(background.handle), -2, "Ctrl+C leaves unrelated background child alive");
      foreground.host.close(foreground.handle);
      const next = s.spawn("tiny", { job: 0 }); await exit(next, 0);
      equal(background.host.wait(background.handle), -2, "background survives subsequent command completion");
      await s.broker.killJob(background.transport.jobId, 15); await exit(background, 143);
    } finally { s.dispose(); }
  });
  await test("pids-never-reuse-when-budget-slot-recycles", async () => {
    const s = scope({ tiny: { module: module("exit"), adapter: "preview1", cooperative: true } });
    try {
      let previous = 1; let initialSlot: number | undefined;
      for (let index = 0; index < 8; index++) {
        const child = s.spawn("tiny"); truth(child.transport.pid > previous, "pids are monotonic"); previous = child.transport.pid;
        initialSlot ??= child.transport.slot; equal(child.transport.slot, initialSlot, "same budget slot reused");
        await exit(child, 0); child.host.close(child.handle);
      }
    } finally { s.dispose(); }
  });
  const query = new URLSearchParams(location.search);
  if (query.has("artifact")) {
    await test("actual-Bun-unawaited-child-survives-parent-and-releases-capacity-eight-times", async () => {
      const response = await fetch("/bun.wasm"); if (!response.ok) throw new Error(`existing bun.wasm: HTTP ${response.status}`);
      const compiled = await WebAssembly.compileStreaming(response);
      const s = scope({ bun: { module: compiled, adapter: "bun", engine: "quickjs" } });
      try {
        for (let iteration = 0; iteration < 8; iteration++) {
          const permit = `/orphan-permit-${iteration}`, marker = `/orphan-done-${iteration}`;
          const childCode = `const fs=require('node:fs'); while(!fs.existsSync(${JSON.stringify(permit)})) await Bun.sleep(2); fs.writeFileSync(${JSON.stringify(marker)},'done');`;
          const parentCode = `Bun.spawn(['bun','-e',${JSON.stringify(childCode)}],{stdin:'ignore',stdout:'ignore',stderr:'ignore'}).unref(); console.log('parent');`;
          const parent = s.spawn("bun", { argv: ["bun", "-e", parentCode] });
          await exit(parent, 0); equal(parent.stdout, "parent\n", "real guest parent exited without waiting for child");
          const slots = new Int32Array(parent.transport.budget).subarray(2);
          truth(slots.some(word => word !== 0), "unawaited child still owns capacity after its parent exits");
          equal(await fs.readFile(marker), undefined, "orphan has not been allowed to finish before parent exit");
          await fs.writeFile(permit, "go");
          const end = performance.now() + 10_000;
          while (decoder.decode(await fs.readFile(marker)) !== "done") { if (performance.now() > end) throw new Error(`orphan ${iteration} lost filesystem access after parent exit`); await pause(); }
          await until(() => slots.every(word => word === 0), "orphan completion releases capacity without a living parent waiter");
          parent.host.close(parent.handle);
          const supervisor = await s.broker.ready();
          await until(() => Array.from(supervisor.table.values()).length === 1, "closed parent and completed orphan release process metadata");
          equal(supervisor.get(parent.transport.pid), undefined, "closed parent record reaped");
        }
      } finally { s.dispose(); }
    });
  }
  let benchmark: Awaited<ReturnType<typeof measureProcessStarts>> | undefined;
  if (query.has("benchmark")) {
    benchmark = await measureProcessStarts(async (compiled, started) => {
      const s = scope({ bun: { module: compiled, adapter: "bun", engine: "quickjs" } });
      try {
        const child = s.spawn("bun", { argv: ["bun", "-e", "console.log('ready')"] });
        await ready(child); const firstOutputMs = performance.now() - started;
        await exit(child, 0); equal(child.stdout, "ready\n", "benchmark stdout"); equal(child.stderr, "", "benchmark stderr");
        return { firstOutputMs, exitMs: performance.now() - started };
      } finally { s.dispose(); }
    });
  }
  fs.dispose(); await pause();
  equal(activeWorkers.size, 0, "every task-created guest and filesystem worker was terminated");
  Object.assign(globalThis, { processResult: { ok: true, checks, benchmark, cleanup: { activeWorkers: activeWorkers.size } } });
} catch (error) {
  Object.assign(globalThis, { processResult: { ok: false, checks, error: error instanceof Error ? error.stack : String(error) } });
} finally { fs.dispose(); for (const worker of activeWorkers) worker.terminate(); globalThis.Worker = NativeWorker; }
