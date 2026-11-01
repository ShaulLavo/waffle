import { SharedFilesystem } from "../browser/shared-fs.ts";
import { PipeController } from "../proc/pipes.ts";
import {
  claimOutcome,
  outcomeWord,
  processOutcome,
  readOutcome,
  serializeOutcome,
} from "../proc/outcome.ts";
import { compileThreadGuest } from "../thread/guest-module.ts";
import type { GuestEntry } from "../thread/entry.ts";
import type { GuestWorkerEvent, GuestWorkerRequest } from "../thread/guest-worker.ts";
import { THREAD_LANE_BYTES } from "../thread/lane.ts";
import { readWaitRegistration, WAIT_REGISTRATION_WORDS } from "../interrupt/wait.ts";
import { guestModule, i32, store, wait32, wait64, call } from "./threads-guest-module.ts";
import {
  check,
  type ServiceCommand,
  type ServiceEvent,
  type ThreadBrowserMode,
} from "./threads-browser-contract.ts";

interface Guest {
  readonly tid: number;
  readonly worker: Worker;
  readonly waits: Int32Array;
  readonly ready: Promise<void>;
  readonly idle: Promise<void>;
  readonly events: GuestWorkerEvent[];
  phase: "starting" | "running" | "idle" | "stopped";
  enter(): void;
}
function bounded<T>(promise: Promise<T>, label: string, milliseconds = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} deadline`)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
function until(predicate: () => boolean, label: string): Promise<void> {
  const result = Promise.withResolvers<void>();
  const timer = setInterval(() => {
    if (predicate()) result.resolve();
  }, 5);
  return bounded(result.promise, label, 2000).finally(() => clearInterval(timer));
}
class BrowserEmbedding {
  readonly memory = new WebAssembly.Memory({ initial: 17, maximum: 512, shared: true });
  readonly initialBuffer = this.memory.buffer;
  readonly outcome = outcomeWord();
  readonly guests: Guest[] = [];
  readonly serviceEvents: ServiceEvent[] = [];
  readonly failures: string[] = [];
  readonly serviceWaiters = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<ServiceEvent>>
  >();
  readonly liveWorkers = new Set<Worker>();
  nextTid = 1;
  peakGuests = 0;
  returned = 0;
  fileBytes = "";
  private module: WebAssembly.Module | undefined;
  private closing = false;
  private disposal:
    | Promise<{ liveWorkers: number; serviceLanes: number; filesystem: string; nativeStop: string }>
    | undefined;
  static async create() {
    const filesystem = new SharedFilesystem({ mode: "memory", workerURL: "/fs-worker.js" });
    let pipe: PipeController | undefined;
    let reader: ReturnType<PipeController["retain"]> | undefined;
    let writer: ReturnType<PipeController["retain"]> | undefined;
    let service: Worker | undefined;
    try {
      pipe = new PipeController({ relay: "manual" });
      reader = pipe.retain(2, "read");
      writer = pipe.retain(1, "write");
      service = new Worker("/threads-service.js", { type: "module" });
      return new BrowserEmbedding(filesystem, pipe, reader, writer, service);
    } catch (error) {
      service?.terminate();
      reader?.close();
      writer?.close();
      pipe?.dispose();
      await filesystem.dispose();
      throw error;
    }
  }
  private constructor(
    readonly filesystem: SharedFilesystem,
    readonly pipe: PipeController,
    readonly reader: ReturnType<PipeController["retain"]>,
    readonly writer: ReturnType<PipeController["retain"]>,
    readonly service: Worker,
  ) {
    this.liveWorkers.add(service);
    this.service.onmessage = ({ data }: MessageEvent<ServiceEvent>) => this.receiveService(data);
    this.service.onerror = (error) => this.fail(error.message);
  }
  private send(message: ServiceCommand, transfer: Transferable[] = []) {
    this.service.postMessage(message, transfer);
  }
  private receiveService(event: ServiceEvent) {
    this.serviceEvents.push(event);
    if (event.kind === "error") return this.fail(event.message);
    if (event.kind === "spawn") {
      void this.spawn(event).catch((error: unknown) => this.fail(String(error)));
      return;
    }
    const key = event.kind === "retired" ? `retired-${event.tid}` : event.kind;
    this.serviceWaiters.get(key)?.resolve(event);
    this.serviceWaiters.delete(key);
  }
  private serviceEvent(kind: "ready" | "stopped" | "retired", tid = 0): Promise<ServiceEvent> {
    const found = this.serviceEvents.find(
      (event) => event.kind === kind && (event.kind !== "retired" || event.tid === tid),
    );
    if (found) return Promise.resolve(found);
    const pending = Promise.withResolvers<ServiceEvent>();
    this.serviceWaiters.set(kind === "retired" ? `retired-${tid}` : kind, pending);
    return bounded(pending.promise, `service ${kind}`);
  }
  async start(module: WebAssembly.Module) {
    this.module = module;
    await this.filesystem.writeFile("/probe", "thread-browser-file");
    const connection = this.filesystem.fork();
    const ready = this.serviceEvent("ready");
    try {
      this.send({ kind: "init", connection, memory: this.memory, stdout: this.writer.handle() }, [
        connection.port,
      ]);
    } catch (error) {
      connection.port.close();
      throw error;
    }
    const event = await ready;
    check(event.kind === "ready", "wrong service readiness event");
    this.fileBytes = event.fileBytes;
  }
  launch(entry: GuestEntry, args: readonly string[] = ["control"]): Guest {
    check(this.module, "module is missing");
    check(!this.closing, "entry after teardown");
    const tid = entry.kind === "initial" ? 1 : entry.tid;
    const thread = { directory: "browser-proof", pid: 1, tid };
    const worker = new Worker("/threads-guest.js", { type: "module" });
    this.liveWorkers.add(worker);
    const channel = new MessageChannel();
    const reply = new SharedArrayBuffer(THREAD_LANE_BYTES);
    const waits = new Int32Array(new SharedArrayBuffer(WAIT_REGISTRATION_WORDS * 4));
    const ready = Promise.withResolvers<void>();
    const idle = Promise.withResolvers<void>();
    void ready.promise.catch(() => {});
    void idle.promise.catch(() => {});
    const guest: Guest = {
      tid,
      worker,
      waits,
      ready: ready.promise,
      idle: idle.promise,
      events: [],
      phase: "starting",
      enter: () => {
        guest.phase = "running";
        worker.postMessage({ kind: "enter" });
      },
    };
    worker.onmessage = ({ data }: MessageEvent<GuestWorkerEvent>) => {
      guest.events.push(data);
      if (data.kind === "ready") ready.resolve();
      if (data.kind === "host-idle") {
        ready.reject(new Error("idled before ready"));
        void this.retire(guest).then(idle.resolve, idle.reject);
      }
    };
    worker.onerror = (error) => {
      ready.reject(new Error(error.message));
      idle.reject(new Error(error.message));
      this.fail(error.message);
    };
    this.guests.push(guest);
    this.peakGuests = Math.max(
      this.peakGuests,
      this.guests.filter((value) => value.phase !== "stopped").length,
    );
    const request: GuestWorkerRequest = {
      module: this.module,
      memory: this.memory,
      thread,
      entry,
      outcome: serializeOutcome(this.outcome),
      signal: new SharedArrayBuffer(4),
      waits: waits.buffer,
      lane: { port: channel.port2, reply },
      args,
      env: {},
    };
    try {
      this.send({ kind: "lane", thread, lane: { port: channel.port1, reply } }, [channel.port1]);
      worker.postMessage(request, [channel.port2]);
    } catch (error) {
      channel.port1.close();
      channel.port2.close();
      ready.reject(error);
      idle.reject(error);
      throw error;
    }
    return guest;
  }
  private async spawn(event: Extract<ServiceEvent, { kind: "spawn" }>) {
    const live = this.guests.filter((guest) => guest.phase !== "stopped").length;
    if (this.closing || readOutcome(this.outcome) || live >= 4) {
      this.send({ kind: "spawned", request: event.request, tid: -6 });
      return;
    }
    const tid = ++this.nextTid;
    const guest = this.launch({ kind: "secondary", tid, startArg: event.startArg });
    await bounded(guest.ready, "secondary ready");
    this.send({ kind: "spawned", request: event.request, tid });
    guest.enter();
  }
  private async retire(guest: Guest) {
    guest.phase = "idle";
    if (guest.events.some((event) => event.kind === "thread-returned")) this.returned++;
    const retired = this.serviceEvent("retired", guest.tid);
    this.send({ kind: "retire", tid: guest.tid });
    await retired;
    this.terminate(guest.worker);
    guest.phase = "stopped";
  }
  private fail(message: string) {
    this.failures.push(message);
    for (const waiter of this.serviceWaiters.values()) waiter.reject(new Error(message));
    claimOutcome(this.outcome, processOutcome({ kind: "exited", code: 1 }));
  }
  private terminate(worker: Worker) {
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
    this.liveWorkers.delete(worker);
  }
  output(): string {
    const bytes: number[] = [];
    const chunk = new Uint8Array(4096);
    for (;;) {
      const size = this.reader.tryRead([chunk]);
      if (size <= 0) break;
      for (let index = 0; index < size; index++) bytes.push(chunk[index]!);
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  }
  async finish() {
    await bounded(Promise.all(this.guests.map((guest) => guest.idle)), "all guests idle");
    check(!this.failures.length, this.failures.join("\n"));
  }
  dispose() {
    return (this.disposal ??= this.cleanup());
  }
  private async cleanup() {
    this.closing = true;
    const errors: unknown[] = [];
    claimOutcome(this.outcome, processOutcome({ kind: "exited", code: 1 }));
    for (const guest of this.guests) guest.worker.postMessage({ kind: "close" });
    const wake = setInterval(() => this.wake(), 5);
    try {
      await bounded(Promise.all(this.guests.map((guest) => guest.idle)), "cleanup idle", 1500);
    } catch (error) {
      errors.push(error);
    }
    clearInterval(wake);
    try {
      const stopped = this.serviceEvent("stopped");
      this.send({ kind: "stop" });
      const event = await stopped;
      check(
        event.kind === "stopped" && event.lanes === 0 && event.pendingSpawns === 0,
        "service lanes leaked",
      );
    } catch (error) {
      errors.push(error);
    }
    for (const worker of this.liveWorkers) this.terminate(worker);
    this.reader.close();
    this.writer.close();
    this.pipe.dispose();
    try {
      await this.filesystem.dispose();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "browser embedding cleanup failed");
    check(
      this.liveWorkers.size === 0 && this.filesystem.state.status === "disposed",
      "workers retained after teardown",
    );
    return {
      liveWorkers: this.liveWorkers.size,
      serviceLanes: 0,
      filesystem: this.filesystem.state.status,
      nativeStop: "requested after host-idle; not OS reclamation",
    };
  }
  private wake() {
    for (const guest of this.guests) {
      const registration = readWaitRegistration(guest.waits);
      if (registration)
        Atomics.notify(new Int32Array(this.memory.buffer), registration.address / 4);
    }
  }
}
async function readiness(width: 4 | 8) {
  const body = store(264, i32(42)).concat(
    store(300, i32(320)),
    store(304, i32(4)),
    store(320, i32(0x0a6b6f21)),
    i32(1),
    i32(300),
    i32(1),
    i32(308),
    call(0),
    [0x1a],
  );
  const module = await compileThreadGuest(
    guestModule({
      imports: [{ name: "fd_write", params: [0x7f, 0x7f, 0x7f, 0x7f] }],
      start: width === 4 ? wait32(256) : wait64(256),
      initial: body,
    }),
  );
  const fixture = await BrowserEmbedding.create();
  try {
    await fixture.start(module);
    const guest = fixture.launch({ kind: "initial" });
    await until(
      () => readWaitRegistration(guest.waits)?.width === width,
      `start-section wait${width * 8} registration`,
    );
    check(
      !guest.events.some((event) => event.kind === "ready"),
      "ready preceded start-section wait",
    );
    const wake = setInterval(
      () => Atomics.notify(new Int32Array(fixture.memory.buffer), 256 / 4),
      5,
    );
    try {
      await bounded(guest.ready, "wait-ready handoff");
    } finally {
      clearInterval(wake);
    }
    check(new Int32Array(fixture.memory.buffer)[264 / 4] === 0, "entry ran before permission");
    guest.enter();
    await fixture.finish();
    check(new Int32Array(fixture.memory.buffer)[264 / 4] === 42, "entry permission did not run");
    check(readOutcome(fixture.outcome)?.kind === "exited", "readiness outcome missing");
    check(fixture.output() === "!ok\n", "guest lane did not reach canonical pipe");
    return {
      width,
      fileBytes: fixture.fileBytes,
      waitBeforeReady: true,
      entryAfterPermission: true,
      cleanup: await fixture.dispose(),
    };
  } catch (error) {
    try {
      await fixture.dispose();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "browser proof and cleanup failed");
    }
    throw error;
  }
}
async function runRust(module: WebAssembly.Module, mode: ThreadBrowserMode) {
  const fixture = await BrowserEmbedding.create();
  try {
    await fixture.start(module);
    const main = fixture.launch({ kind: "initial" }, ["threads", mode]);
    await bounded(main.ready, "initial ready");
    main.enter();
    await bounded(main.idle, `Rust ${mode}`);
    await fixture.finish();
    const stdout = fixture.output();
    const outcome = readOutcome(fixture.outcome);
    const expected = `threads-ok mode=${mode} main-static=1369948382 main-tls=901\n`;
    const children = mode === "repeat" ? 16 : 2;
    check(
      outcome?.kind === "exited" && outcome.code === 0,
      `Rust ${mode} outcome ${JSON.stringify(outcome)}`,
    );
    check(stdout === expected, `Rust ${mode} stdout ${JSON.stringify(stdout)}`);
    check(
      fixture.nextTid - 1 === children && fixture.returned === children,
      "spawn or return count changed",
    );
    check(fixture.memory.buffer.byteLength > 17 * 65536, "stock Rust did not grow memory");
    return {
      mode,
      stdout,
      outcome,
      children,
      returned: fixture.returned,
      peakGuestWorkers: fixture.peakGuests,
      initialPages: 17,
      maximumPages: 512,
      currentPages: fixture.memory.buffer.byteLength / 65536,
      bufferReplaced: fixture.initialBuffer !== fixture.memory.buffer,
      cleanup: await fixture.dispose(),
    };
  } catch (error) {
    try {
      await fixture.dispose();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "browser proof and cleanup failed");
    }
    throw error;
  }
}
async function terminalControl() {
  const module = await compileThreadGuest(
    guestModule({
      imports: [
        { module: "wasi", name: "thread-spawn", params: [0x7f] },
        { name: "proc_exit", params: [0x7f], result: false },
      ],
      initial: i32(0).concat(call(0), [0x1a], wait64(512)),
      secondary: wait32(520).concat(i32(0), call(1)),
    }),
  );
  const fixture = await BrowserEmbedding.create();
  try {
    await fixture.start(module);
    const main = fixture.launch({ kind: "initial" });
    await bounded(main.ready, "terminal control ready");
    main.enter();
    await until(
      () =>
        fixture.guests.length === 2 &&
        readWaitRegistration(main.waits)?.width === 8 &&
        readWaitRegistration(fixture.guests[1]!.waits)?.width === 4,
      "parked main and child",
    );
    Atomics.store(new Int32Array(fixture.memory.buffer), 520 / 4, 1);
    Atomics.notify(new Int32Array(fixture.memory.buffer), 520 / 4);
    await until(() => readOutcome(fixture.outcome) !== null, "child proc_exit");
    const outcome = readOutcome(fixture.outcome);
    check(outcome?.kind === "exited" && outcome.code === 0, "child zero exit was replaced");
    const cleanup = await fixture.dispose();
    check(
      fixture.guests.every((guest) => guest.events.some((event) => event.kind === "host-idle")),
      "terminal control missed host-idle",
    );
    return {
      outcome,
      mainParkedInWait64: true,
      childParkedInWait32: true,
      cleanup,
      qualification: "bounded guest terminal control, not Runtime two-step-kill",
    };
  } catch (error) {
    try {
      await fixture.dispose();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "browser proof and cleanup failed");
    }
    throw error;
  }
}
/** @browserEntry Low-level service proof only. No Runtime launcher or page ledger is installed. */
export async function runThreadsBrowser(
  modes: readonly ThreadBrowserMode[] = ["pair", "repeat", "nested"],
) {
  check(
    crossOriginIsolated && typeof SharedArrayBuffer === "function",
    "COOP/COEP or SharedArrayBuffer missing",
  );
  const controls = [await readiness(4), await readiness(8)];
  const terminal = await terminalControl();
  const source = new Uint8Array(await (await fetch("/threads.wasm")).arrayBuffer());
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", source)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const module = await compileThreadGuest(source);
  const results = [];
  for (const mode of modes) results.push(await runRust(module, mode));
  return {
    qualification: "low-level browser embedding only",
    userAgent: navigator.userAgent,
    timeOrigin: performance.timeOrigin,
    url: location.href,
    crossOriginIsolated,
    fixtureSha256: sha256,
    controls,
    terminal,
    results,
    compilerInvoked: false,
  };
}
