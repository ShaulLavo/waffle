import { SharedFilesystem } from "../src/shared-fs";
import type { Engine, RunRequest } from "../src/worker";
import { startRun, type Run } from "../src/runner";
import { preview1SignalClockGuest } from "./engine-interruption-preview1";
import { assertCausalIdleWake, assertFatalEngineCompletion, assertNativeEngineCompletion, engineInterruptionFailure, probeCell, probeLength, snapshotProbe, suppressBudgetNotifications } from "./engine-interruption-probe";
import { measureInterruptionOverhead } from "./engine-interruption-benchmark";
import { defaultSignalGuest, handledSignalGuest, idleSignalGuest } from "./engine-interruption-guests";
import { engineInterruptionTransport } from "./engine-interruption-transport";
import { createLegacyEngineScope, createRuntimeEngineScope, type EngineInterruptionChild as Child, type EngineInterruptionRoute, type EngineSignalDelivery } from "./engine-interruption-scope";
import { FunctionalCases, assertGuestQuiescence, cleanupFunctionalResources, waitFunctionalCondition, type FunctionalCaseIdentity } from "./engine-interruption-cases";

interface CaseResources {
  workers: Set<ObservedWorker>;
  contexts: { read: () => unknown; final?: unknown }[];
  cleanupErrors: unknown[];
}
let currentCase: CaseResources | undefined;
const functional = new FunctionalCases();
function captureContext(read: () => unknown): unknown {
  try { return read(); } catch (error) { return { diagnosticError: String(error) }; }
}
function cleanupCase(actions: readonly (() => void)[]): void {
  const errors: unknown[] = [];
  cleanupFunctionalResources(actions, error => { errors.push(error); });
  if (currentCase) currentCase.cleanupErrors.push(...errors);
  else if (errors.length) throw new AggregateError(errors, "owned cleanup failed");
}

const NativeWorker = globalThis.Worker;
const activeWorkers = new Set<ObservedWorker>();
const guestWorkers = new Map<number, ObservedWorker>();
let hooks = true;
let observeCheckpoints = true;
let idleWaitTimeoutMs = 0;
let instrumentPreview1Root = false;
class ObservedWorker extends NativeWorker {
  readonly probe = new Int32Array(new SharedArrayBuffer(probeLength * 4));
  deferStop = false;
  guestEngine?: Engine;
  guestAdapter?: string;
  exitObserved = false;
  transport?: ReturnType<typeof engineInterruptionTransport>;
  readonly diagnostics: unknown[] = [];
  constructor(url: string | URL, options?: WorkerOptions) {
    const target = new URL(url, location.href);
    super(instrumentPreview1Root && target.pathname.endsWith("/worker.js")
      ? new URL("./engine-interruption-worker.js", target).href : url, options);
    activeWorkers.add(this);
    this.addEventListener("error", event => this.diagnostics.push({ error: event.message }));
    this.addEventListener("message", event => {
      if (event.data?.type === "exit") this.exitObserved = true;
      if (["phase", "error", "exit"].includes(event.data?.type)) this.diagnostics.push(event.data);
    });
  }
  override postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions): void {
    if (message && typeof message === "object" && "module" in message && "engine" in message) {
      const request = message as RunRequest;
      this.deferStop = request.engine !== "browser" || request.adapter === "preview1";
      this.guestEngine = request.engine; this.guestAdapter = request.adapter;
      currentCase?.workers.add(this);
      this.transport = engineInterruptionTransport(request);
      guestWorkers.set(request.child?.pid ?? request.pid!, this);
      message = { ...request, engineInterruption: { evidence: this.probe.buffer, hooks, observeCheckpoints, idleWaitTimeoutMs } };
    }
    if (Array.isArray(options)) super.postMessage(message, options);
    else super.postMessage(message, options);
  }
  override terminate(): void {
    Atomics.add(this.probe, probeCell.terminateRequests, 1);
    if (!this.deferStop) this.forceTerminate();
  }
  forceTerminate(): void { super.terminate(); activeWorkers.delete(this); }
}
// Install teardown before creating the filesystem or any guest worker. In particular,
// default-action tests deliberately suppress the supervisor's physical backstop.
globalThis.Worker = ObservedWorker;
let filesystem: SharedFilesystem | undefined;
const scopes = new Set<Awaited<ReturnType<typeof scope>>>();
let destroyed = false;
let watchdogExpired = false;
const destroyErrors: string[] = [];
function destroy(): void {
  if (destroyed) return;
  destroyed = true;
  for (const owned of Array.from(scopes)) {
    try { owned.dispose(); } catch (error) { destroyErrors.push(String(error)); }
  }
  try { filesystem?.dispose(); } catch (error) { destroyErrors.push(String(error)); }
  for (const worker of Array.from(activeWorkers)) {
    try { worker.forceTerminate(); } catch (error) { destroyErrors.push(String(error)); }
  }
  globalThis.Worker = NativeWorker;
}
addEventListener("pagehide", destroy, { once: true });
Object.assign(globalThis, { engineInterruptionHarness: { destroy } });
const watchdog = setTimeout(() => { watchdogExpired = true; destroy(); }, new URLSearchParams(location.search).has("benchmark") ? 480_000 : 600_000);
const decoder = new TextDecoder();
const checks: { engine: Engine; name: string; route?: EngineInterruptionRoute; delivery?: string; evidence: unknown; elapsedMs?: number }[] = [];
function guestFinished(worker: ObservedWorker | undefined): boolean {
  // The exit message follows stdout/stderr on the same Worker message channel.
  // Wait for that FIFO barrier as well as actual unwind before declaring a marker
  // impossible; runReturned alone can beat queued generic/root output delivery.
  return Boolean(worker?.exitObserved && (worker.guestEngine === "browser" && worker.guestAdapter !== "preview1"
    || Atomics.load(worker.probe, probeCell.runReturned) === 1));
}
function equal(actual: unknown, expected: unknown, label: string): void { if (actual !== expected) throw new Error(`${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`); }
function truth(value: unknown, label: string): asserts value { if (!value) throw new Error(label); }
async function until(condition: () => boolean, label: string | (() => string), timeout = 15_000, completed?: () => boolean): Promise<void> {
  await waitFunctionalCondition(condition, label, { timeoutMs: timeout, completed, aborted: () => destroyed });
}
function assertDeferredHandledSignal(worker: ObservedWorker): void {
  const evidence = snapshotProbe(worker.probe);
  equal(evidence.handledSignal, 2, "event-loop mode0 call dequeued SIGINT after yield");
  truth(evidence.pendingPreservedBeforeLoopFinished > 0, "mode4 checkpoint preserved authoritative pending SIGINT during synchronous CPU work");
  equal(evidence.pendingLostAtCheckpoint, 0, "mode4 never consumes the shared pending bit");
  equal(evidence.handledBeforeLoopFinished, 0, "no mode0 dequeue before synchronous CPU work yields");
  equal(evidence.checkpointNonzero, 0, "mode4 is a non-dequeue fatal checkpoint");
}
async function scope(module: WebAssembly.Module, engine: Engine, route: EngineInterruptionRoute = "legacy", adapter: "bun" | "preview1" = "bun") {
  const workerName = engine === "browser" && adapter !== "preview1" ? "worker.js" : "engine-interruption-worker.js";
  const base = route === "runtimeProcess" ? await createRuntimeEngineScope(module, engine, filesystem!)
    : createLegacyEngineScope(module, engine, filesystem!, new URL(`./${workerName}`, location.href).href, adapter);
  const resources = currentCase;
  const context = { read: () => Array.from(base.children.values(), child => ({
    pid: child.pid, engine, route, adapter, requestedSignal: Atomics.load(child.requestedSignal, 0),
    ordinaryStatus: base.wait(child), stdout: child.stdout, stderr: child.stderr,
    evidence: guestWorkers.has(child.pid) ? snapshotProbe(guestWorkers.get(child.pid)!.probe) : null,
  })), final: undefined as unknown };
  resources?.contexts.push(context);
  let disposed = false;
  const owned = { ...base,
    async ready(child: Child): Promise<ObservedWorker> {
      try { await until(() => { base.drain(child); return child.stderr.includes("ready\n"); }, "guest ready", 15_000, () => guestFinished(guestWorkers.get(child.pid))); }
      catch (error) {
        base.drain(child);
        const worker = guestWorkers.get(child.pid);
        throw new Error(`${String(error)}; route=${route} stdout=${JSON.stringify(child.stdout)} stderr=${JSON.stringify(child.stderr)} status=${base.wait(child)} worker=${JSON.stringify(worker?.diagnostics)} probe=${JSON.stringify(worker && snapshotProbe(worker.probe))}`);
      }
      const worker = guestWorkers.get(child.pid); truth(worker, "guest worker not observed");
      equal(worker.transport?.route, route, "actual production request follows selected route");
      return worker;
    },
    async exit(child: Child, status: number): Promise<void> {
      await until(() => { base.drain(child); return base.wait(child) !== -2; }, `guest exit (${child.stderr})`, 15_000, () => guestFinished(guestWorkers.get(child.pid)));
      base.drain(child); equal(base.wait(child), status, `exit status (${child.stderr})`);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // Preserve diagnostics before broker disposal can forget process metadata.
      context.final = captureContext(context.read);
      const children = Array.from(base.children.values());
      const errors: unknown[] = [];
      try { base.dispose(); } catch (error) { errors.push(error); }
      for (const child of children) {
        try { guestWorkers.get(child.pid)?.forceTerminate(); } catch (error) { errors.push(error); }
        guestWorkers.delete(child.pid);
      }
      scopes.delete(owned);
      if (errors.length) {
        if (resources) resources.cleanupErrors.push(...errors);
        else throw new AggregateError(errors, "owned scope cleanup failed");
      }
    },
  };
  scopes.add(owned); return owned;
}
async function runCase(identity: FunctionalCaseIdentity, body: () => Promise<unknown>) {
  const resources: CaseResources = { workers: new Set(), contexts: [], cleanupErrors: [] };
  const beforeWorkers = new Set(activeWorkers), beforeScopes = new Set(scopes);
  const settings = { hooks, observeCheckpoints, idleWaitTimeoutMs, instrumentPreview1Root, notify: Atomics.notify };
  let passed = false;
  currentCase = resources;
  try {
    return await functional.run(identity, async () => {
      const result = await body(); passed = true; return result;
    }, () => ({
      processes: resources.contexts.map(context => context.final ?? captureContext(context.read)),
      workers: Array.from(resources.workers, worker => ({ engine: worker.guestEngine, adapter: worker.guestAdapter,
        evidence: snapshotProbe(worker.probe), exitObserved: worker.exitObserved, diagnostics: worker.diagnostics })),
    }), () => {
      for (const owned of Array.from(scopes)) if (!beforeScopes.has(owned)) {
        try { owned.dispose(); } catch (error) { resources.cleanupErrors.push(error); }
      }
      for (const worker of Array.from(activeWorkers)) if (!beforeWorkers.has(worker)) {
        try { worker.forceTerminate(); } catch (error) { resources.cleanupErrors.push(error); }
      }
      for (const [pid, worker] of guestWorkers) if (resources.workers.has(worker)) guestWorkers.delete(pid);
      if (hooks !== settings.hooks || observeCheckpoints !== settings.observeCheckpoints
        || idleWaitTimeoutMs !== settings.idleWaitTimeoutMs || instrumentPreview1Root !== settings.instrumentPreview1Root || Atomics.notify !== settings.notify) {
        resources.cleanupErrors.push(new Error("case instrumentation settings were not restored"));
      }
      if (Array.from(activeWorkers).some(worker => !beforeWorkers.has(worker))
        || Array.from(scopes).some(owned => !beforeScopes.has(owned))) resources.cleanupErrors.push(new Error("case-owned resources remain"));
      if (resources.cleanupErrors.length) throw new AggregateError(resources.cleanupErrors, "case cleanup failed");
      // A logical dispose/Worker.terminate call cannot certify a failed CPU guest
      // stopped. Continue only after the instrumented execution really unwound.
      if (!passed) assertGuestQuiescence(Array.from(resources.workers, worker => ({
        evidence: snapshotProbe(worker.probe),
      })));
    });
  } finally { currentCase = undefined; }
}
async function testDefault(module: WebAssembly.Module, engine: Engine, signal: 2 | 15, nestedHandler = false, route: EngineInterruptionRoute = "legacy"): Promise<void> {
  const owned = await scope(module, engine, route);
  let diagnostics: () => unknown = () => ({ phase: "before guest spawn" });
  try {
    // fd 1 is buffered even through fs.writeSync; fd 2 is unbuffered here.
    const child = owned.spawn(nestedHandler ? handledSignalGuest(true) : defaultSignalGuest());
    diagnostics = () => {
      const worker = guestWorkers.get(child.pid);
      return { evidence: worker ? snapshotProbe(worker.probe) : null, requestedSignal: Atomics.load(child.requestedSignal, 0),
        ordinaryStatus: owned.wait(child), stdout: child.stdout, stderr: child.stderr };
    };
    const worker = await owned.ready(child);
    // Let the synchronous readiness import return before signaling pure-JS work.
    // Default cases never yield; nested cases first finish finite CPU work, then
    // dispatch handled SIGINT on the event loop before entering the guarded loop.
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    equal(Atomics.load(worker.probe, probeCell.startLeft), 0, "guest is still executing before the signal");
    if (nestedHandler) {
      equal(await owned.kill(child, 2), 0, "initial handled SIGINT accepted");
      await until(() => { owned.drain(child); return child.stderr.includes("handler-ready\n"); }, "CPU loop entered registered SIGINT handler", 15_000, () => guestFinished(worker));
      equal(owned.wait(child), -2, "registered handler remains alive inside its nested CPU loop");
      assertDeferredHandledSignal(worker);
      equal(child.stderr, "ready\nloop-finished\nhandler-ready\n", "handler entered only after synchronous CPU work yielded");
      await new Promise<void>(resolve => setTimeout(resolve, 20));
    }
    const started = performance.now();
    equal(await owned.kill(child, signal), 0, "signal accepted");
    await owned.exit(child, 128 + signal);
    const result = await owned.broker.wait(child.pid);
    equal(result.kind, "signaled", "typed signal outcome"); equal(result.code, signal, "selected signal");
    if (engine === "browser") {
      await until(() => !activeWorkers.has(worker), "Bun light physical termination requested");
      truth(Atomics.load(worker.probe, probeCell.terminateRequests) > 0, "Bun light still calls native Worker.terminate");
    } else {
      await until(() => Atomics.load(worker.probe, probeCell.runReturned) === 1,
        () => `${engine} real _start unwind after signal ${signal}; evidence=${JSON.stringify(snapshotProbe(worker.probe))}`);
      const evidence = snapshotProbe(worker.probe);
      assertFatalEngineCompletion(evidence, signal);
      truth(evidence.checkpointAfterSignal > 0, "CPU-bound engine entered actual slot18 checkpoint after signal");
      equal(evidence.checkpointSignal, signal, "checkpoint observed selected signal");
      truth(evidence.checkpointThrew > 0, "host callback propagated terminal unwind");
      equal(evidence.checkpointNonzero, 0, "mode4 checkpoint does not dequeue handled signals");
      equal(evidence.startEntered, 1, "real _start called once"); equal(evidence.startLeft, 1, "real _start returned/unwound");
      equal(evidence.catchWrites, 0, "catch cannot attempt output after default action");
      equal(evidence.finallyWrites, 0, "finally cannot attempt output after default action");
      equal(evidence.afterWrites, 0, "code after default action cannot attempt output");
      truth(activeWorkers.has(worker), "proof obtained while native terminate remained disabled");
    }
    checks.push({ engine, route, delivery: route === "legacy" ? "host" : "page-kill",
      name: `${route === "runtimeProcess" ? "runtimeProcess-page-" : ""}${nestedHandler ? "nested-SIGINT-handler-" : ""}default-${signal}-status-${128 + signal}`,
      evidence: snapshotProbe(worker.probe), elapsedMs: performance.now() - started });
  } catch (error) {
    throw engineInterruptionFailure(`${engine}/${route} ${nestedHandler ? "nested-handler " : ""}default signal ${signal} proof failed`, error, diagnostics);
  } finally { owned.dispose(); }
}
async function testNativeInterrupt(module: WebAssembly.Module, engine: Engine): Promise<void> {
  const owned = await scope(module, engine);
  let diagnostics: () => unknown = () => ({ phase: "before guest spawn" });
  try {
    const child = owned.spawn(defaultSignalGuest());
    diagnostics = () => ({ stdout: child.stdout, stderr: child.stderr });
    const worker = await owned.ready(child);
    diagnostics = () => ({ evidence: snapshotProbe(worker.probe), requestedSignal: Atomics.load(child.requestedSignal, 0),
      ordinaryStatus: owned.wait(child), stdout: child.stdout, stderr: child.stderr });
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    equal(Atomics.load(worker.probe, probeCell.startLeft), 0, "native interrupt guest remains CPU-bound");
    Atomics.store(worker.probe, probeCell.nativeInterruptRequested, 1);
    await until(() => Atomics.load(worker.probe, probeCell.runReturned) === 1,
      () => `${engine} native true-return callback _start unwind; evidence=${JSON.stringify(snapshotProbe(worker.probe))}`);
    await until(() => { owned.drain(child); return owned.wait(child) !== -2; }, "native interrupt ordinary outcome", 15_000, () => guestFinished(worker));
    const result = await owned.broker.wait(child.pid);
    equal(result.kind, "exited", "native interrupt does not fabricate a selected fatal host outcome");
    equal(Atomics.load(child.requestedSignal, 0), 0, "no host signal was requested");
    const evidence = snapshotProbe(worker.probe);
    assertNativeEngineCompletion(evidence);
    if (evidence.startWasiExit) equal(evidence.startWasiExitCode, result.code, "typed WASI exit matches ordinary process outcome");
    equal(evidence.nativeInterruptInjected, 1, "exactly one real op4 negative response injected");
    equal(evidence.checkpointNonzero, 1, "actual callback returned one native termination request");
    truth(evidence.checkpointReturned > 0, "callback returned rather than throwing");
    equal(evidence.checkpointThrew, 0, "no checkpoint host exception caused native-path unwind");
    equal(evidence.startEntered, 1, "native path entered real _start once"); equal(evidence.startLeft, 1, "native engine left real _start");
    equal(evidence.catchWrites, 0, "interrupted frame catch did not run");
    equal(evidence.finallyWrites, 0, "interrupted frame finally did not run");
    equal(evidence.afterWrites, 0, "interrupted frame continuation did not run");
    truth(activeWorkers.has(worker), "native-path proof obtained without physical Worker.terminate");
    // This covers this interrupted frame, not a prohibition on future VM entries
    // used by runtime error reporting or cleanup after native termination.
    checks.push({ engine, route: "legacy", delivery: "native-callback", name: "native-interrupt-true-unwinds-current-frame", evidence: { ...evidence, outcome: result } });
  } catch (error) {
    throw engineInterruptionFailure(`${engine} native true-return proof failed`, error, diagnostics);
  } finally { owned.dispose(); }
}
async function testHandled(module: WebAssembly.Module, engine: Engine, route: EngineInterruptionRoute = "legacy"): Promise<void> {
  const owned = await scope(module, engine, route);
  try {
    const child = owned.spawn(handledSignalGuest());
    const worker = await owned.ready(child);
    equal(Atomics.load(child.signalState, 2) & 3, 2, "handler registered before readiness");
    equal(await owned.kill(child, 2), 0, "handled SIGINT accepted");
    await owned.exit(child, 23);
    await until(() => Atomics.load(worker.probe, probeCell.runReturned) === 1, "handled loop returned from _start");
    const result = await owned.broker.wait(child.pid);
    equal(result.kind, "exited", "handler retains ordinary chosen exit"); equal(result.code, 23, "handler chosen status");
    equal(child.stdout, "continued 1 true\n", "ordinary continuation after queued handler");
    equal(child.stderr, "ready\nloop-finished\nhandled\n", "Node ordering: synchronous work finishes before handled callback");
    assertDeferredHandledSignal(worker);
    checks.push({ engine, route, delivery: route === "legacy" ? "host" : "page-kill",
      name: `${route === "runtimeProcess" ? "runtimeProcess-page-" : ""}handled-SIGINT-queued-until-yield-and-exits-23`, evidence: snapshotProbe(worker.probe) });
  } finally { owned.dispose(); }
}
async function testIdleHandled(module: WebAssembly.Module, engine: Engine, route: EngineInterruptionRoute = "legacy", pageDelivered = false): Promise<void> {
  async function runTrial(suppressNotify: boolean, delivery: EngineSignalDelivery) {
    const owned = await scope(module, engine, route);
    let mutation: ReturnType<typeof suppressBudgetNotifications> | undefined;
    try {
      const child = owned.spawn(idleSignalGuest);
      const worker = await owned.ready(child);
      equal(Atomics.load(child.signalState, 2) & 3, 2, "idle SIGINT handler registered");
      await until(() => Atomics.load(worker.probe, probeCell.idleWaiting) === 1, "guest entered stretched ordinary event-loop budget wait", 15_000, () => guestFinished(worker));
      const generation = Atomics.load(worker.probe, probeCell.idleWaitActiveGeneration);
      await new Promise<void>(resolve => setTimeout(resolve, 20));
      equal(Atomics.load(worker.probe, probeCell.idleWaitActiveGeneration), generation, "same long wait generation remains entered");
      equal(Atomics.load(worker.probe, probeCell.idleWaiting), 1, "idle wait is still entered immediately before kill");
      Atomics.store(worker.probe, probeCell.idleWaitSampleGeneration, generation);
      if (suppressNotify) mutation = suppressBudgetNotifications(worker.transport!.waitWord);
      const started = performance.now();
      equal(await owned.kill(child, 2, delivery), 0, "idle handled SIGINT accepted");
      await until(() => { owned.drain(child); return child.stderr.includes("idle-handled\n"); }, "idle event-loop dispatched SIGINT", 15_000, () => guestFinished(worker));
      const handlerLatencyMs = performance.now() - started;
      await owned.exit(child, 23);
      await until(() => Atomics.load(worker.probe, probeCell.runReturned) === 1, "idle handler guest _start returned");
      const result = await owned.broker.wait(child.pid);
      equal(result.kind, "exited", "idle handler retains ordinary exit"); equal(result.code, 23, "idle chosen status");
      equal(child.stderr, "ready\nidle-handled\n", "idle handler output");
      const evidence = snapshotProbe(worker.probe);
      equal(evidence.handledSignal, 2, "idle event loop dequeued authoritative pending SIGINT with mode0");
      equal(Atomics.load(child.signalState, 2) & 4, 0, "idle event loop cleared shared pending bit");
      equal(evidence.checkpointNonzero, 0, "idle mode4 checkpoint never dequeues");
      let causalRejection: string | undefined;
      if (suppressNotify) {
        truth(mutation!.count() > 0, "negative control actually suppressed process-budget notification");
        try { assertCausalIdleWake(evidence, generation); } catch (error) { causalRejection = String(error); }
        truth(causalRejection, "notify-removal mutant must fail the identical positive causal-wake admission");
        equal(evidence.idleWaitSampleCompleted, generation, "negative control completed sampled native wait");
        equal(evidence.idleWaitSampleResult, 2, "notify-removal mutant timed out rather than receiving native ok");
        truth(handlerLatencyMs >= 250, "removed notify must not hide behind production4ms timeout");
      } else assertCausalIdleWake(evidence, generation);
      return { delivery, handlerLatencyMs, generation, suppressedNotifications: mutation?.count() ?? 0, causalRejection, evidence };
    } finally { cleanupCase([() => mutation?.restore(), () => owned.dispose()]); }
  }
  // Only idle test workers receive this long timeout. Production scheduling and
  // all other waits remain unchanged; CPU benchmark interception stays disabled.
  idleWaitTimeoutMs = 1_000;
  try {
    const deliveries: EngineSignalDelivery[] = pageDelivered ? ["page-kill", "page-killJob"] : ["host"];
    const negativeControls: Awaited<ReturnType<typeof runTrial>>[] = [];
    const trials: (Awaited<ReturnType<typeof runTrial>> & { warmup: boolean })[] = [];
    let complete = true;
    for (const delivery of deliveries) {
      const identity = { engine, route, name: "idle-handled-SIGINT", delivery };
      const negative = await runCase({ ...identity, control: "notify-removal" }, () => runTrial(true, delivery));
      if (negative.ok) negativeControls.push(negative.result as Awaited<ReturnType<typeof runTrial>>);
      else complete = false;
      for (let trial = 0; trial < 8; trial++) {
        const positive = await runCase({ ...identity, control: "positive", trial }, () => runTrial(false, delivery));
        if (positive.ok) trials.push({ warmup: trial === 0, ...positive.result as Awaited<ReturnType<typeof runTrial>> });
        else complete = false;
      }
    }
    if (!complete) return;
    const times = trials.filter(trial => !trial.warmup).map(trial => trial.handlerLatencyMs);
    times.sort((a, b) => a - b);
    const medianMs = times[Math.floor(times.length / 2)]!, maxMs = times[times.length - 1]!;
    const enforceLatency = new URLSearchParams(location.search).has("benchmark");
    const admission = await runCase({ engine, route, name: "idle-latency-summary", delivery: deliveries.join("+") }, async () => {
      if (enforceLatency) {
        truth(medianMs < 10, `${engine} idle SIGINT median ${medianMs}ms must be <10ms on a quiet benchmark host`);
        truth(maxMs < 50, `${engine} idle SIGINT max ${maxMs}ms must be <50ms on a quiet benchmark host`);
      }
    });
    if (!admission.ok) return;
    checks.push({ engine, route, delivery: deliveries.join("+"),
      name: `${pageDelivered ? `${route}-page-kill-and-killJob-` : ""}idle-handled-SIGINT-notifies-blocked-generation-and-exits-23`, evidence: {
      nativeWaitTimeoutMs: 1_000, warmupTrials: deliveries.length, measuredTrials: 7 * deliveries.length, medianMs, maxMs,
      medianBudgetMs: 10, maxBudgetMs: 50, latencyGateEnforced: enforceLatency, negativeControl: negativeControls[0], negativeControls, trials,
      method: `${route}/${deliveries.join("+")} to unbuffered handler stderr, drained every2ms; idle-only native process-budget wait stretched to1s; exact sampled generation must return native ok; notify-removal negative control must time out and fail identical causal admission; pending-state dequeue remains separate from wake generation`,
    } });
  } finally { idleWaitTimeoutMs = 0; }
}
async function testPreview1Clock(root: boolean): Promise<void> {
  const module = new WebAssembly.Module(preview1SignalClockGuest());
  async function runTrial(suppressNotify: boolean) {
    let owned: Awaited<ReturnType<typeof scope>> | undefined;
    let run: Run | undefined;
    let rootSettled = false;
    let worker: ObservedWorker | undefined;
    let mutation: ReturnType<typeof suppressBudgetNotifications> | undefined;
    let child: Child | undefined;
    let stdout = "", stderr = "";
    const context = { read: () => ({ root, stdout: child?.stdout ?? stdout, stderr: child?.stderr ?? stderr,
      requestedSignal: child ? Atomics.load(child.requestedSignal, 0) : undefined,
      ordinaryStatus: child ? owned?.wait(child) : undefined,
      evidence: (worker ?? (root ? guestWorkers.get(1) : undefined)) ? snapshotProbe((worker ?? guestWorkers.get(1))!.probe) : null }), final: undefined as unknown };
    currentCase?.contexts.push(context);
    try {
      if (root) {
        instrumentPreview1Root = true;
        try {
          run = startRun({ engine: "browser", adapter: "preview1", module, args: [], env: { PWD: "/home/user" },
            filesystem: filesystem!, moduleScope: false }, {
            stdout(bytes) { stdout += decoder.decode(bytes); }, stderr(bytes) { stderr += decoder.decode(bytes); },
          });
        } finally { instrumentPreview1Root = false; }
        void run.done.then(() => { rootSettled = true; });
        await until(() => stderr.includes("ready\n"), "actual legacy Preview1 root ready", 15_000, () => guestFinished(guestWorkers.get(1)));
        worker = guestWorkers.get(1);
      } else {
        owned = await scope(module, "browser", "legacy", "preview1");
        child = owned.spawn(""); worker = await owned.ready(child);
      }
      truth(worker, "actual Preview1 production worker observed");
      const observed = worker;
      equal(observed.transport?.route, "legacy", "signal-only imports retain legacy route");
      await until(() => Atomics.load(observed.probe, probeCell.idleWaiting) === 1, "Preview1 clock entered actual shared interrupt wait", 15_000, () => guestFinished(observed));
      const generation = Atomics.load(observed.probe, probeCell.idleWaitActiveGeneration);
      await new Promise<void>(resolve => setTimeout(resolve, 20));
      equal(Atomics.load(observed.probe, probeCell.idleWaitActiveGeneration), generation, "same Preview1 clock wait remains entered");
      equal(Atomics.load(observed.probe, probeCell.idleWaiting), 1, "Preview1 clock is blocked before page kill");
      Atomics.store(observed.probe, probeCell.idleWaitSampleGeneration, generation);
      if (suppressNotify) mutation = suppressBudgetNotifications(observed.transport!.waitWord);
      const started = performance.now();
      if (root) run!.kill(2); else equal(await owned!.kill(child!, 2, "page-kill"), 0, "page Preview1 SIGINT accepted");
      await until(() => {
        if (!root) { owned!.drain(child!); stdout = child!.stdout; stderr = child!.stderr; }
        return stderr.includes("poll-eintr\n");
      }, "Preview1 poll_oneoff returned EINTR and dequeued SIGINT", 15_000, () => guestFinished(observed));
      const latencyMs = performance.now() - started;
      if (root) {
        const result = await run!.done; equal(result.error, undefined, "Preview1 root did not crash");
        equal(result.code, 23, "Preview1 root ordinary exit");
      } else { await owned!.exit(child!, 23); owned!.drain(child!); stdout = child!.stdout; stderr = child!.stderr; }
      await until(() => Atomics.load(observed.probe, probeCell.runReturned) === 1, "Preview1 actual _start returned");
      equal(stdout, "", "Preview1 stdout is empty");
      equal(stderr, "ready\npoll-eintr\npoll-clean\n", "EINTR, authoritative dequeue and final nonsticky clock wait");
      equal(Atomics.load(observed.transport!.signalState, 2) & 4, 0, "Preview1 pending bit consumed only by interrupted");
      const evidence = snapshotProbe(observed.probe);
      assertNativeEngineCompletion(evidence);
      let causalRejection: string | undefined;
      if (suppressNotify) {
        truth(mutation!.count() > 0, "Preview1 mutant suppressed exact interrupt notification");
        try { assertCausalIdleWake(evidence, generation); } catch (error) { causalRejection = String(error); }
        truth(causalRejection, "Preview1 notify-removal mutant fails identical causal admission");
        equal(evidence.idleWaitSampleResult, 2, "Preview1 notify-removal native wait timed out");
        truth(latencyMs >= 250, "Preview1 removed notify cannot hide behind short rescan");
      } else {
        assertCausalIdleWake(evidence, generation);
        if (new URLSearchParams(location.search).has("benchmark")) truth(latencyMs < 50, "Preview1 page signal must wake clock promptly");
      }
      return { root, latencyMs, generation, suppressedNotifications: mutation?.count() ?? 0, causalRejection, evidence };
    } finally {
      context.final = captureContext(context.read);
      instrumentPreview1Root = false;
      cleanupCase([
        () => mutation?.restore(),
        () => { if (run && !rootSettled) run.kill(9); },
        () => owned?.dispose(),
        () => { if (root) { (worker ?? guestWorkers.get(1))?.forceTerminate(); guestWorkers.delete(1); } },
      ]);
    }
  }
  idleWaitTimeoutMs = 1_000;
  try {
    const identity = { engine: "browser", route: "legacy", name: `preview1-${root ? "root" : "child"}-clock`, delivery: root ? "real-startRun-killJob" : "page-kill" };
    const negative = await runCase({ ...identity, control: "notify-removal" }, () => runTrial(true));
    const positiveCase = await runCase({ ...identity, control: "positive" }, () => runTrial(false));
    if (!negative.ok || !positiveCase.ok) return;
    const negativeControl = negative.result, positive = positiveCase.result;
    checks.push({ engine: "browser", route: "legacy", delivery: root ? "real-startRun-killJob" : "page-kill",
      name: `legacy-preview1-${root ? "root" : "child"}-clock-EINTR-dequeue-and-nonsticky-wait`,
      evidence: { nativeWaitTimeoutMs: 1_000, negativeControl, positive } });
  } finally { idleWaitTimeoutMs = 0; }
}
async function benchmark(module: WebAssembly.Module, engine: Engine, pristine?: WebAssembly.Module): Promise<object> {
  // Correctness cases observe real callbacks. Do NOT add per-checkpoint Atomics,
  // decoder or proxy work to the timed production import path.
  observeCheckpoints = false;
  try {
    const result = await measureInterruptionOverhead(async (mode, source) => {
      hooks = mode !== "candidate-masked";
      const owned = await scope(mode === "pristine" ? pristine! : module, engine);
      try {
        const child = owned.spawn(source);
        await owned.exit(child, 0);
        const worker = guestWorkers.get(child.pid); truth(worker, "benchmark worker missing");
        await until(() => Atomics.load(worker.probe, probeCell.runReturned) === 1, "benchmark _start returned");
        const match = /BENCH (\d+) (\d+)/.exec(child.stdout); truth(match, `benchmark output: ${child.stdout} ${child.stderr}`);
        equal(Atomics.load(worker.probe, probeCell.slotMasked), hooks ? 0 : 1, "disabled baseline masks optional signal slot before _start");
        return { milliseconds: Number(match[1]), checksum: Number(match[2]) };
      } finally { owned.dispose(); }
    }, Boolean(pristine));
    return { engine, ...result };
  } finally { hooks = true; observeCheckpoints = true; }
}

void (async () => {
  const benchmarks: unknown[] = [];
  const artifacts: { engine: Engine; name: string; sha256: string }[] = [];
  const modules: { engine: Engine; name: string; hash: string; module: WebAssembly.Module }[] = [];
  let fatalError: unknown;
  let functionalComplete = false;
  try {
    truth(crossOriginIsolated, "engine interruption requires cross-origin isolation");
    filesystem = new SharedFilesystem();
    await filesystem.mkdirp("/home/user"); await filesystem.flush();
    for (const [engine, name] of [["quickjs", "bun.wasm"], ["jsc", "bun-jsc.wasm"], ["browser", "bun-browser.wasm"]] as const) {
      let module: WebAssembly.Module | undefined, hash = "";
      await runCase({ engine, route: "artifact", name: "load-candidate" }, async () => {
        const response = await fetch(`/${name}`); truth(response.ok, `fresh artifact ${name}: HTTP ${response.status}`);
        const bytes = await response.arrayBuffer();
        hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
        artifacts.push({ engine, name, sha256: hash });
        module = await WebAssembly.compile(bytes);
      });
      // Other engines and Preview1 remain independent of an unavailable artifact.
      if (!module) continue;
      const loaded = module;
      modules.push({ engine, name, hash, module: loaded });
      await runCase({ engine, route: "legacy", name: "boot" }, async () => {
        const boot = await scope(loaded, engine);
        try {
          const child = boot.spawn("require('node:fs').writeSync(2,'boot\\n');");
          await boot.exit(child, 0);
          equal(child.stderr, "boot\n", `${engine} guest bootstrap`);
        } finally { boot.dispose(); }
      });
      for (const signal of [2, 15] as const) await runCase({ engine, route: "legacy", name: `default-${signal}` }, () => testDefault(loaded, engine, signal));
      if (engine !== "browser") {
        await runCase({ engine, route: "legacy", name: "native-true-return" }, () => testNativeInterrupt(loaded, engine));
        await runCase({ engine, route: "legacy", name: "handled-SIGINT" }, () => testHandled(loaded, engine));
        await runCase({ engine, route: "legacy", name: "nested-SIGINT-default-15" }, () => testDefault(loaded, engine, 15, true));
        await testIdleHandled(loaded, engine);
        for (const signal of [2, 15] as const) await runCase({ engine, route: "runtimeProcess", name: `default-${signal}` }, () => testDefault(loaded, engine, signal, false, "runtimeProcess"));
        await runCase({ engine, route: "runtimeProcess", name: "handled-SIGINT" }, () => testHandled(loaded, engine, "runtimeProcess"));
        await runCase({ engine, route: "runtimeProcess", name: "nested-SIGINT-default-15" }, () => testDefault(loaded, engine, 15, true, "runtimeProcess"));
        await testIdleHandled(loaded, engine, "legacy", true);
        await testIdleHandled(loaded, engine, "runtimeProcess", true);
      }
    }
    await testPreview1Clock(true); await testPreview1Clock(false);
    functionalComplete = true;
    // Never start timings when even one functional scenario is RED. Functional
    // matrix runs have already retained every safely reachable independent case.
    const query = new URLSearchParams(location.search);
    if (functional.ok && query.has("benchmark")) {
      for (const { engine, name, hash, module } of modules) {
        if (engine === "browser") continue;
        let pristine: WebAssembly.Module | undefined, pristineSha256: string | undefined;
        if (query.has("baseline")) {
          const response = await fetch(`/baseline/${name}`); truth(response.ok, `pristine baseline ${name}: HTTP ${response.status}`);
          const bytes = await response.arrayBuffer();
          pristineSha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
          truth(pristineSha256 !== hash, "pristine baseline must not reuse candidate bytes");
          pristine = await WebAssembly.compile(bytes);
        }
        benchmarks.push({ wasmSha256: hash, pristineSha256, ...await benchmark(module, engine, pristine) });
      }
    }
  } catch (error) { fatalError = error; }
  finally {
    destroy(); clearTimeout(watchdog);
    const safe = functional.safe && destroyErrors.length === 0 && activeWorkers.size === 0 && !watchdogExpired;
    Object.assign(globalThis, { engineInterruptionResult: {
      ok: !fatalError && functional.ok && safe,
      artifacts, checks, outcomes: functional.outcomes, benchmarks, functionalComplete,
      incomplete: !functionalComplete,
      incompleteReason: functionalComplete ? undefined : "Remaining independent cases were not run after a safety, setup or deadline abort; outcomes retain every completed case.",
      error: fatalError instanceof Error ? fatalError.stack : fatalError ? String(fatalError) : undefined,
      cleanup: { activeWorkers: activeWorkers.size, safe, errors: destroyErrors, watchdogExpired },
      unsafeCleanup: safe ? undefined : "case execution quiescence or owned resource cleanup is unproved",
    } });
  }
})();
