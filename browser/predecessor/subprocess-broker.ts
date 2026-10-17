// Runnable page-side adapter. The generic process service is loaded only on first spawn;
// blocked guest workers never have to activate a MessageChannel or a nested Worker.
import type { ChildExitEvent, ProcessContext, ProcessExit, ProcessSupervisor, RootProcessOptions, Signal } from "../../runtime/proc";
import { checkedSignal } from "../../runtime/proc/types";
import { createSignalState, requestSignal, type SignalTransport } from "../../runtime/proc/signals";
import { isRevoked } from "../../runtime/fs/protocol";
import { claimOutcome, outcomeWord, readOutcome } from "../../runtime/proc/outcome";
import type { SharedFilesystem } from "./shared-fs";
import { childTransport } from "./subprocess.ts";
import type { Engine, RunRequest, SpawnRequest, WorkerMessage } from "./worker";

type Proc = typeof import("../../runtime/proc");
type CompiledExecutable = WebAssembly.Module | (() => Promise<WebAssembly.Module>);
export type ExecutableRegistration =
  | { module: CompiledExecutable; adapter: "bun"; engine?: Engine }
  // This is an assertion by the trusted host, never a filename-based exemption. Our own shell
  // has engine/checkpoint support; renaming arbitrary third-party bytes to "bun" grants nothing.
  | { module: CompiledExecutable; adapter: "preview1"; cooperative: true }
  | { bytes: Uint8Array | (() => Uint8Array | Promise<Uint8Array>); adapter: "preview1"; cooperative?: false };

function executableModule(entry: ExecutableRegistration, refused: (error: unknown) => void): CompiledExecutable {
  if (entry.adapter === "bun" || entry.cooperative === true) return entry.module;
  return async () => {
    try {
      if (!("bytes" in entry)) throw new TypeError("third-party preview1 executables require source bytes for interrupt instrumentation");
      const bytes = typeof entry.bytes === "function" ? await entry.bytes() : entry.bytes;
      if (!(bytes instanceof Uint8Array)) throw new TypeError("preview1 executable loader must return source bytes as Uint8Array");
      const { compileInterruptible } = await import("../../runtime/interrupt/loader");
      return await compileInterruptible(bytes);
    } catch (error) { refused(error); throw error; }
  };
}
interface Child {
  spawn: SpawnRequest;
  context?: ProcessContext;
  worker?: Worker;
  request?: RunRequest;
  signal: number;
  acknowledged: boolean;
  closed: boolean;
  stopped: boolean;
  stopping?: Promise<void>;
}

export class SubprocessBroker {
  private disposed = false;
  private children = new Map<number, Child>();
  private registrations = new Map<string, ExecutableRegistration>();
  private loaderErrors = new Map<string, string>();
  private activation?: Promise<ProcessSupervisor>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private root?: SignalTransport & { pid: number; job: number };
  constructor(private workerUrl: string, private filesystem: SharedFilesystem,
    private options: { activate?: () => Promise<Proc>; root?: RootProcessOptions } = {}) {
    // Root control is available before the optional process service is imported. Non-isolated
    // runs never supply shared root words and never allocate them unless they activate spawning.
    if (options.root) this.rootTransport();
  }

  private rootTransport(): SignalTransport & { pid: number; job: number } {
    const source = this.options.root;
    return this.root ??= {
      pid: source?.pid ?? 1, job: source?.job ?? 1,
      signalState: createSignalState(source?.signalState), outcome: outcomeWord(source?.outcome),
      interrupt: source?.interrupt instanceof Int32Array ? source.interrupt : new Int32Array(source?.interrupt ?? new SharedArrayBuffer(4)),
      requestedSignal: source?.requestedSignal instanceof Int32Array ? source.requestedSignal : new Int32Array(source?.requestedSignal ?? new SharedArrayBuffer(4)),
    };
  }

  register(name: string, entry: ExecutableRegistration): void {
    if (this.activation) throw new Error("Register executables before the first spawn");
    this.registrations.set(name, entry);
  }

  ready(): Promise<ProcessSupervisor> {
    return this.activation ??= (this.options.activate?.() ?? import("../../runtime/proc")).then(proc => {
      const registry = new proc.ExecutableRegistry();
      for (const [name, entry] of this.registrations) registry.register(name, {
        module: executableModule(entry, error => this.loaderErrors.set(name, String(error))),
        adapter: entry.adapter === "preview1" ? "preview1" : `bun:${entry.engine ?? "browser"}`,
      });
      const supervisor = new proc.ProcessSupervisor({ registry, launch: context => this.launch(context), onError: error => this.report(error) });
      supervisor.createRoot({ ...this.options.root, ...this.rootTransport() });
      supervisor.onChildExit(event => this.exited(supervisor, event));
      return supervisor;
    });
  }

  private exited(supervisor: ProcessSupervisor, event: ChildExitEvent): void {
    const child = this.children.get(event.pid);
    if (child) {
      const refused = this.loaderErrors.get(child.spawn.executable);
      if (refused && !child.worker && event.result.kind === "exited" && event.result.code === 126) {
        childTransport(child.spawn.child).stderr.write(new TextEncoder().encode(`bun-wasm: ${child.spawn.executable}: ${refused}\n`));
      }
      childTransport(child.spawn.child).finish(event.result.status, event.result.kind === "signaled" ? event.result.code : undefined);
      if (!child.acknowledged) this.filesystem.revoke(child.spawn.filesystem);
      if (!child.worker) this.children.delete(event.pid);
    }
    const parent = supervisor.get(event.parentPid);
    // A live parent owns its waitable result until it closes the handle. Orphans have no
    // possible waiter; reap their metadata without turning parent exit into background kill.
    if (child?.closed || !parent || parent.result) supervisor.reap(event.parentPid, event.pid);
    const completed = Array.from(supervisor.table.values()).filter(record => record.parentPid === event.pid && record.result);
    for (const record of completed) supervisor.reap(event.pid, record.pid);
  }

  spawn(spawn: SpawnRequest): void {
    if (this.disposed) { this.cancel(spawn); return; }
    this.rootTransport();
    const child: Child = { spawn, signal: 0, acknowledged: false, closed: false, stopped: false };
    this.children.set(spawn.pid, child);
    // No import, compile, worker startup or wait is on the synchronous spawn path.
    void this.ready().then(supervisor => {
      if (this.disposed) return;
      // This request was admitted while its sender still held filesystem authority. A root
      // exit during lazy activation must not erase an already accepted independent job.
      supervisor.reserveAdmittedSpawn(spawn.parentPid, {
        executable: spawn.executable, argv: spawn.argv, env: spawn.env, cwd: spawn.cwd,
        job: spawn.job ?? spawn.jobId, fds: [],
      }, { pid: spawn.pid, job: spawn.jobId, interrupt: spawn.child.interrupt, requestedSignal: spawn.child.requestedSignal, signalState: spawn.child.signalState, outcome: spawn.child.outcome });
      const signal = Atomics.load(new Int32Array(spawn.child.requestedSignal), 0);
      if (signal) { child.signal = signal; supervisor.observeSignal(spawn.pid, signal); }
      return supervisor.start(spawn.pid);
    }).catch(error => {
      childTransport(spawn.child).stderr.write(new TextEncoder().encode(`bun-wasm: process start failed: ${String(error)}\n`));
      childTransport(spawn.child).finish(126);
      this.filesystem.revoke(spawn.filesystem);
      this.children.delete(spawn.pid);
    });
    this.watch();
  }

  private launch(context: ProcessContext) {
    const child = this.children.get(context.pid);
    if (!child || this.disposed) throw new Error("Process no longer has a live controller");
    const spawn = child.spawn;
    child.context = context;
    const preview1 = context.adapter === "preview1";
    const registration = this.registrations.get(spawn.executable);
    const interruptible = registration?.adapter === "preview1" && registration.cooperative !== true;
    const engine = preview1 ? "browser" : context.adapter.slice(4) as Engine;
    const request: RunRequest = {
      module: context.module, engine, adapter: preview1 ? "preview1" : "bun", interruptible,
      args: spawn.argv, env: { ...spawn.env, PWD: spawn.cwd },
      filesystem: this.filesystem.connect(spawn.filesystem), child: spawn.child,
      pid: spawn.pid, jobId: spawn.jobId, identity: spawn.child.identity, interrupt: spawn.child.interrupt,
      signalState: spawn.child.signalState, requestedSignal: spawn.child.requestedSignal, outcome: spawn.child.outcome,
      trace: spawn.trace, slots: spawn.slots, spawnBroker: true, net: null, moduleCache: null,
    };
    if (!preview1 && engine === "browser" && new URL(this.workerUrl).pathname.endsWith("/__bunwasm/worker.js")) request.moduleCache = `bunwasm-m-${crypto.randomUUID()}`;
    child.request = request;
    let worker: Worker;
    try { worker = new Worker(this.workerUrl, { type: "module" }); }
    catch (error) { request.filesystem.port.close(); throw error; }
    child.worker = worker;
    context.registerRevocation(() => {
      this.filesystem.revoke(spawn.filesystem);
      const transport = childTransport(spawn.child);
      if (!spawn.child.inheritedStdin) transport.stdin.close();
      transport.stdout.close(); transport.stderr.close();
    });
    worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
      const selected = readOutcome(outcomeWord(spawn.child.outcome));
      if (selected?.kind === "signaled" && data.type !== "exit" && data.type !== "error") {
        // Reject queued capabilities even when fatal publication preceded filesystem revocation.
        if (data.type === "spawn") this.cancel(data.request);
        return;
      }
      if (data.type === "spawn") {
        if (isRevoked(spawn.filesystem) || data.request.parentPid !== context.pid) this.cancel(data.request);
        else this.spawn(data.request);
        return;
      }
      if (data.type === "child-close") {
        if (!isRevoked(spawn.filesystem) && data.parentPid === context.pid) this.close(data.parentPid, data.pid);
        return;
      }
      if (data.type !== "exit" && data.type !== "error") return;
      child.acknowledged = true;
      this.filesystem.reap(spawn.filesystem);
      if (data.type === "exit" && data.signal) context.defaultSignal(data.signal as Signal);
      else if (data.type === "exit") context.exit(data.code);
      else context.fail(new Error(data.message));
      this.stopSafely(child);
    };
    worker.onerror = event => {
      event.preventDefault();
      childTransport(spawn.child).stderr.write(new TextEncoder().encode(`bun-wasm: child worker failed: ${event.message}\n`));
      context.fail(new Error(event.message));
      // Error events are not quiescent acknowledgements. Logical exit is already visible,
      // but a filesystem critical section must finish before physical termination.
      this.stopSafely(child);
    };
    try { worker.postMessage(request, [request.filesystem.port]); }
    catch (error) {
      request.filesystem.port.close();
      this.stopSafely(child);
      throw error;
    }
    return { terminate: () => this.stop(child) };
  }

  async wait(pid: number): Promise<ProcessExit> {
    const child = this.children.get(pid);
    const supervisor = await this.ready();
    return supervisor.waitForExit(child?.spawn.parentPid ?? supervisor.get(pid)?.parentPid ?? this.options.root?.pid ?? 1, pid);
  }
  private childSignalTransport(child: Child): SignalTransport {
    const transport = child.spawn.child;
    return { signalState: createSignalState(transport.signalState), interrupt: new Int32Array(transport.interrupt),
      requestedSignal: new Int32Array(transport.requestedSignal), outcome: outcomeWord(transport.outcome) };
  }
  private deliver(targets: { pid: number; transport: SignalTransport; child?: Child }[], signal: number): Promise<void> {
    // Publication has no callbacks. Every default member's terminal choice precedes any revoke,
    // stream closure, or worker stop, including reentrant exits caused by those operations.
    const deliveries = targets.map(target => ({ ...target, delivery: requestSignal(target.transport, signal) }));
    for (const { child, delivery } of deliveries) {
      if (!child) continue;
      if (delivery.action !== "ignore") child.signal = Atomics.load(new Int32Array(child.spawn.child.requestedSignal), 0);
      if (delivery.outcome) {
        this.filesystem.revoke(child.spawn.filesystem);
        childTransport(child.spawn.child).finish(delivery.outcome.status, delivery.outcome.kind === "signaled" ? delivery.outcome.code : undefined);
        if (child.worker) this.stopSafely(child);
      }
    }
    if (!this.activation) return Promise.resolve();
    return this.activation.then(supervisor => {
      for (const { pid, delivery } of deliveries) {
        if (delivery.action !== "ignore" && supervisor.get(pid)) supervisor.observeSignal(pid, signal);
      }
    });
  }
  kill(pid: number, signal: number): Promise<void> {
    const sig = checkedSignal(signal), child = this.children.get(pid);
    if (child) return this.deliver([{ pid, child, transport: this.childSignalTransport(child) }], sig);
    if (this.root?.pid === pid) return this.deliver([{ pid, transport: this.root }], sig);
    return this.ready().then(supervisor => supervisor.kill(pid, sig));
  }
  killJob(job: number, signal: number): Promise<void> {
    const sig = checkedSignal(signal);
    const targets = Array.from(this.children.values()).filter(child => child.spawn.jobId === job)
      .map(child => ({ pid: child.spawn.pid, child, transport: this.childSignalTransport(child) }));
    // Root and child workers share these exact words with a later lazy supervisor instance.
    // Never publish locally and then call supervisor.killJob: that could replay a consumed bit.
    const root: { pid: number; transport: SignalTransport; child?: Child }[] = this.root?.job === job
      ? [{ pid: this.root.pid, transport: this.root }] : [];
    return this.deliver(root.concat(targets), sig);
  }
  /** Guest handle ownership, not process ancestry. Close makes an existing wait resolve before
   * reaping; closing a completed child simply releases its retained argv/env/job metadata.
   */
  close(parentPid: number, pid: number): void {
    const child = this.children.get(pid);
    if (child && child.spawn.parentPid !== parentPid) return;
    if (child) child.closed = true;
    if (!this.activation) return;
    void this.activation.then(supervisor => {
      const record = supervisor.get(pid);
      if (!record || record.parentPid !== parentPid) return;
      if (!record.result) {
        // Completion reaches the parent through shared memory before this page necessarily
        // receives the worker's exit message. Preserve that acknowledgement's outcome kind.
        const completed = child && Atomics.load(new Int32Array(child.spawn.child.control), 0);
        const killed = child && Atomics.load(new Int32Array(child.spawn.child.requestedSignal), 0) === 9;
        if (completed && !killed) return;
        supervisor.kill(pid, 9);
      }
      if (supervisor.get(pid)?.result) supervisor.reap(parentPid, pid);
    }).catch(error => this.report(error));
  }
  /** Parent exit is not job teardown: independently running/background children stay alive. */
  rootExit(code: number): void {
    if (this.activation) void this.activation.then(supervisor => supervisor.exit(this.options.root?.pid ?? 1, code)).catch(error => this.report(error));
  }

  private cleanupCache(child: Child): void { if (child.request?.moduleCache) void caches.delete(child.request.moduleCache); }
  private physicallyStop(child: Child): void {
    if (child.stopped) return;
    child.stopped = true;
    child.worker?.terminate();
    this.cleanupCache(child);
    this.children.delete(child.spawn.pid);
  }
  private stop(child: Child): void | Promise<void> {
    if (child.stopped) return;
    if (child.acknowledged) { this.physicallyStop(child); return; }
    return child.stopping ??= this.filesystem.quiesce(child.spawn.filesystem).then(() => this.physicallyStop(child));
  }
  private stopSafely(child: Child): void {
    try { const pending = this.stop(child); if (pending) void pending.catch(error => this.report(error)); }
    catch (error) { this.report(error); }
  }
  private report(error: unknown): void { console.error("bun-wasm: process controller failed", error); }
  /** Release an unadmitted request whose sender has already lost process authority. */
  rejectSpawn(spawn: SpawnRequest): void { this.cancel(spawn); }
  private cancel(spawn: SpawnRequest): void {
    const result = claimOutcome(outcomeWord(spawn.child.outcome), { kind: "signaled", code: 9 });
    if (result.kind === "signaled" && result.code === 9) {
      Atomics.store(new Int32Array(spawn.child.requestedSignal), 0, 9);
      Atomics.store(new Int32Array(spawn.child.interrupt), 0, 9);
    }
    this.filesystem.revoke(spawn.filesystem);
    childTransport(spawn.child).finish(result.status, result.kind === "signaled" ? result.code : undefined);
  }
  private watch(): void {
    if (this.timer !== null || this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.ready().then(supervisor => {
        for (const [pid, child] of this.children) {
          const record = supervisor.get(pid);
          if (!record || record.result) continue;
          // A publisher can stop after the atomic decision but before writing the wake header.
          // Adopt that decision; physical teardown still waits for filesystem quiescence.
          const result = readOutcome(record.outcome);
          if (result) {
            if (result.kind === "signaled") supervisor.defaultSignal(pid, result.code);
            else supervisor.exit(pid, result.code);
            continue;
          }
          const signal = Atomics.load(new Int32Array(child.spawn.child.requestedSignal), 0);
          if (!signal || signal === child.signal) continue;
          child.signal = signal;
          supervisor.observeSignal(pid, signal);
        }
      }).catch(error => this.report(error));
      if (this.children.size) this.watch();
    }, 4);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    for (const child of Array.from(this.children.values())) {
      this.cancel(child.spawn);
      if (child.worker) this.stopSafely(child);
      else this.children.delete(child.spawn.pid);
    }
    if (this.activation) void this.activation.then(supervisor => supervisor.dispose()).catch(error => this.report(error));
  }
}
