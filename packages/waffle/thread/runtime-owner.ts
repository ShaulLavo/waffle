import { createSharedControlAllocator } from "../memory/control.js";
import {
  type RuntimeReservations,
  type SharedGuestAlias,
  type SharedGuestBacking,
  type BackingContinuation,
  type LaunchedTicket,
  type Headroom,
} from "../memory/reservations.js";
import type { ThreadModuleDeclaration } from "../memory/declarations.js";
import { WAIT_REGISTRATION_WORDS } from "../interrupt/wait.js";
import { readOutcome, serializeOutcome } from "../proc/outcome.js";
import { workerProcessDirectoryId, type WorkerProcessTransport } from "../proc/worker-client.js";
import { ProcessError, ProcessErrno, type ProcessContext } from "../proc/types.js";
import type { FilesystemConnection } from "../fs/protocol.js";
import {
  createThreadLaneOwner,
  ThreadWaitOwner,
  THREAD_LANE_BYTES,
  type ThreadRequest,
} from "./lane.js";
import type { GuestEntry } from "./entry.js";
import type { GuestWorkerEvent, GuestWorkerRequest } from "./guest-worker.js";
import type { ThreadKey, CallKey, ThreadResult } from "./protocol.js";
import type {
  ThreadLaunchOptions,
  ThreadServiceCommand,
  ThreadServiceEvent,
} from "./runtime-protocol.js";

interface Guest {
  readonly thread: ThreadKey;
  readonly worker: Worker;
  readonly alias: SharedGuestAlias;
  readonly control: BackingContinuation;
  readonly lane: ReturnType<typeof createThreadLaneOwner>;
  readonly wait: ThreadWaitOwner;
  readonly idle: ReturnType<typeof Promise.withResolvers<void>>;
  readonly ready: ReturnType<typeof Promise.withResolvers<"ready" | "closed">>;
  phase: "starting" | "running" | "idle" | "stopped" | "retained";
  stopped?: Promise<void>;
}
interface OwnerOptions {
  readonly context: ProcessContext;
  readonly transport: WorkerProcessTransport;
  readonly reservations: RuntimeReservations;
  readonly declaration: ThreadModuleDeclaration;
  readonly urls: ThreadLaunchOptions;
  connect(headroom: Headroom | null): FilesystemConnection;
  filesystemFence(): Promise<void>;
  cleanup(): void;
  failed(error: unknown): void;
}
class NoThreadOwner {
  constructor(
    readonly cause: unknown,
    readonly rollback: () => Promise<void>,
  ) {}
}
const capacities = new WeakMap<RuntimeReservations, { processes: number; guests: number }>();
/** Page-only owner. The sole ledger owns bytes; this counter bounds admitted actors. */
export class RuntimeThreadOwner {
  private readonly backing: SharedGuestBacking;
  private readonly serviceAlias: SharedGuestAlias;
  private readonly service: Worker;
  private readonly serviceTicket: LaunchedTicket;
  private readonly directory: string;
  private readonly guests = new Map<number, Guest>();
  private readonly starting = new Map<number, SharedGuestAlias>();
  private readonly rollbacks = new Set<Promise<void>>();
  private readonly calls = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<ThreadResult>>
  >();
  private readonly controls = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();
  private readonly serviceReady = Promise.withResolvers<void>();
  private readonly capacity: { processes: number; guests: number };
  private sequence = 0;
  private tid = 0;
  private phase: "open" | "draining" | "stopped" | "debt" = "open";
  private fencing?: Promise<void>;
  private stopping?: Promise<void>;
  private serviceFailure: unknown;
  private serviceSafe = false;

  static async create(options: OwnerOptions): Promise<RuntimeThreadOwner | undefined> {
    try {
      return new RuntimeThreadOwner(options);
    } catch (error) {
      if (!(error instanceof NoThreadOwner)) throw error;
      options.failed(error.cause);
      await error.rollback();
    }
  }

  private constructor(private readonly options: OwnerOptions) {
    const { reservations, context, transport } = options;
    this.directory = workerProcessDirectoryId(transport);
    this.capacity = capacities.get(reservations) ?? { processes: 0, guests: 0 };
    capacities.set(reservations, this.capacity);
    this.backing = this.createBacking();
    try {
      this.serviceAlias = this.backing.alias({ kind: "service", incarnation: context.pid });
    } catch (error) {
      throw new NoThreadOwner(error, () => this.rollbackBacking());
    }
    const ticket = this.admitService();
    let worker: Worker | undefined;
    let connection: FilesystemConnection | undefined;
    try {
      connection = options.connect(ticket.arena);
      worker = new Worker(options.urls.serviceWorkerUrl, { type: "module" });
      this.service = worker;
      this.serviceTicket = ticket.launched();
      this.capacity.processes++;
      worker.onmessage = ({ data }: MessageEvent<ThreadServiceEvent>) => this.receiveService(data);
      worker.onerror = (event) => {
        event.preventDefault();
        this.fail(new Error(event.message));
      };
    } catch (error) {
      if (worker) {
        this.backing.fail(error);
        ticket.launched().failed([error]);
        throw error;
      }
      throw new NoThreadOwner(error, () =>
        this.rollbackBacking(() => {
          connection?.port.close();
          ticket.abort();
        }),
      );
    }
    try {
      const memory = this.serviceAlias.transfer().memory;
      worker.postMessage(
        {
          kind: "thread-service",
          directory: this.directory,
          pid: context.pid,
          memory,
          filesystem: connection,
          transport,
          controlGrant: ticket.control,
        } satisfies ThreadServiceCommand,
        [connection.port],
      );
    } catch (error) {
      this.fail(error);
    }
    void this.startInitial().catch((error) => this.fail(error));
    context.registerRevocation(() => this.terminal());
    if (readOutcome(context.outcome)) this.terminal();
  }
  private createBacking(): SharedGuestBacking {
    try {
      if (this.capacity.processes >= 2) throw new Error("thread process capacity exhausted");
      return this.options.reservations.sharedGuests.create({
        owner: { directory: this.directory, pid: this.options.context.pid },
        ...this.options.declaration,
      });
    } catch (error) {
      throw new NoThreadOwner(error, async () => {
        await this.options.filesystemFence();
        this.options.cleanup();
      });
    }
  }
  private admitService() {
    try {
      return this.ticket(this.serviceAlias, true);
    } catch (error) {
      throw new NoThreadOwner(error, () =>
        this.rollbackBacking(() => this.serviceAlias.abortBeforeTransfer()),
      );
    }
  }
  private async rollbackBacking(abort?: () => void): Promise<void> {
    try {
      abort?.();
      const winner = readOutcome(this.options.context.outcome);
      if (!winner) throw new Error("unstarted thread has no terminal outcome");
      this.backing.seal(winner);
      await this.backing.fence({ kind: "no-agent" });
      await this.options.filesystemFence();
      this.options.cleanup();
      if (this.backing.retire().kind !== "awaiting-collection")
        throw new Error("unstarted thread backing did not retire");
    } catch (error) {
      this.backing.fail(error);
      throw error;
    }
  }
  private async startInitial(): Promise<void> {
    await deadline(this.serviceReady.promise, "thread service ready");
    if (this.phase !== "open" || readOutcome(this.options.context.outcome)) return;
    const guest = this.launch({ kind: "initial" });
    if (!guest) {
      this.options.context.startFailed(
        new ProcessError(ProcessErrno.AGAIN, "initial thread admission failed"),
      );
      this.terminal();
      return;
    }
    await deadline(guest.ready.promise, "initial thread ready");
  }
  private ticket(alias: SharedGuestAlias, connection: boolean) {
    return this.options.reservations.admit({
      pid: this.options.context.pid,
      executable: this.options.context.request.executable,
      guest: {
        kind: "shared-alias",
        alias,
        owner: { directory: this.directory, pid: this.options.context.pid },
      },
      group: "none",
      connection,
      controls: true,
    });
  }
  private fail(error: unknown): void {
    if (this.phase === "debt" || this.phase === "stopped") return;
    this.serviceFailure = error;
    this.backing.fail(error);
    this.phase = "debt";
    this.serviceReady.reject(error);
    for (const call of this.calls.values()) call.reject(error);
    for (const control of this.controls.values()) control.reject(error);
    this.options.failed(error);
    this.terminal();
  }
  private receiveService(event: ThreadServiceEvent): void {
    if (event.kind === "control-allocation")
      return this.serviceTicket.controlAllocated(event.buffer);
    if (event.kind === "service-error") return this.fail(new Error(event.message));
    if (event.kind === "service-ready") return this.serviceReady.resolve();
    if (event.kind === "result") {
      this.calls.get(event.id)?.resolve(event.result);
      this.calls.delete(event.id);
      return;
    }
    this.controls.get(event.id)?.resolve();
    this.controls.delete(event.id);
  }
  private async control(kind: "drain" | "dispose"): Promise<void> {
    if (this.serviceFailure) throw this.serviceFailure;
    const id = ++this.sequence;
    const result = Promise.withResolvers<void>();
    this.controls.set(id, result);
    this.service.postMessage({ kind, id } satisfies ThreadServiceCommand);
    await deadline(result.promise, `thread service ${kind}`);
  }
  private async dispatch(call: CallKey, request: ThreadRequest): Promise<ThreadResult> {
    if (this.phase !== "open") return { kind: "error", errno: 11 };
    const continuation = this.backing.continuation(call);
    try {
      if (request.kind === "spawn") {
        const tid = this.tid + 1;
        const guest = this.launch({ kind: "secondary", tid, startArg: request.startArg });
        if (!guest) return { kind: "error", errno: 6 };
        const ready = await deadline(guest.ready.promise, "thread ready");
        if (ready !== "ready") return { kind: "error", errno: 11 };
        if (this.phase !== "open" || readOutcome(this.options.context.outcome))
          return { kind: "error", errno: 11 };
        this.enter(guest);
        return { kind: "ok", value: tid };
      }
      const id = ++this.sequence;
      const result = Promise.withResolvers<ThreadResult>();
      this.calls.set(id, result);
      this.service.postMessage({ kind: "call", call, request, id } satisfies ThreadServiceCommand);
      return await result.promise;
    } finally {
      await continuation.settle(() => {});
    }
  }
  private launch(entry: GuestEntry): Guest | undefined {
    if (this.phase !== "open" || readOutcome(this.options.context.outcome)) return;
    if (
      this.guests.size + this.starting.size >= 4 ||
      this.capacity.guests >= 8 ||
      this.tid >= 0x1fffffff
    )
      return;
    const thread = { directory: this.directory, pid: this.options.context.pid, tid: ++this.tid };
    const alias = this.backing.alias({ kind: "guest", thread });
    let ticket: ReturnType<RuntimeThreadOwner["ticket"]>;
    try {
      ticket = this.ticket(alias, false);
    } catch {
      alias.abortBeforeTransfer();
      return;
    }
    this.starting.set(thread.tid, alias);
    this.capacity.guests++;
    let worker: Worker | undefined;
    let channel: MessageChannel | undefined;
    let control: BackingContinuation | undefined;
    let posted = false;
    try {
      channel = new MessageChannel();
      worker = new Worker(this.options.urls.guestWorkerUrl, { type: "module" });
      const launched = ticket.launched();
      if (this.phase !== "open" || readOutcome(this.options.context.outcome))
        throw new Error("thread admission sealed during construction");
      const allocate = createSharedControlAllocator(ticket.control, (buffer) =>
        launched.controlAllocated(buffer),
      );
      const waits = new Int32Array(allocate(WAIT_REGISTRATION_WORDS * 4));
      const signal = allocate(4);
      const reply = allocate(THREAD_LANE_BYTES);
      const route = this.backing.continuation({ thread, sequence: 0 });
      control = route;
      const memory = alias.transfer().memory;
      const lane = createThreadLaneOwner({
        thread,
        lane: { port: channel.port1, reply },
        dispatcher: { dispatch: (call, request) => this.dispatch(call, request) },
        terminal: () => this.phase !== "open",
        failed: (error) => this.fail(error),
      });
      const wait = new ThreadWaitOwner({
        thread,
        memory,
        waits,
        terminal: () => !!readOutcome(this.options.context.outcome),
        retain: (registration) => route.retain(registration.buffer),
        failed: (error) => {
          route.failed(error);
          this.fail(error);
        },
      });
      const guest: Guest = {
        thread,
        alias,
        worker,
        control: route,
        lane,
        wait,
        idle: Promise.withResolvers<void>(),
        ready: Promise.withResolvers<"ready" | "closed">(),
        phase: "starting",
      };
      // A bootstrap error can precede the fence that joins this original promise.
      void guest.idle.promise.catch(() => {});
      this.guests.set(thread.tid, guest);
      this.starting.delete(thread.tid);
      worker.onmessage = ({ data }: MessageEvent<GuestWorkerEvent>) =>
        this.receiveGuest(guest, data);
      worker.onerror = (event) => {
        event.preventDefault();
        guest.phase = "retained";
        guest.idle.reject(new Error(event.message));
        this.fail(new Error(event.message));
      };
      posted = true;
      worker.postMessage(
        {
          module: this.options.context.module,
          memory,
          thread,
          entry,
          outcome: serializeOutcome(this.options.context.outcome),
          signal,
          waits: waits.buffer,
          lane: { port: channel.port2, reply },
          args: this.options.context.request.argv,
          env: this.options.context.request.env,
        } satisfies GuestWorkerRequest,
        [channel.port2],
      );
      return guest;
    } catch (error) {
      if (posted) {
        this.fail(error);
        return;
      }
      const cleanup = () => {
        channel?.port1.close();
        channel?.port2.close();
      };
      if (!worker) {
        cleanup();
        ticket.abort();
        this.starting.delete(thread.tid);
        this.capacity.guests--;
        return;
      }
      const constructed = worker;
      const rollback = Promise.resolve().then(async () => {
        await control?.settle(cleanup);
        await alias.stop({ idle: () => {}, terminate: () => constructed.terminate(), cleanup });
        this.starting.delete(thread.tid);
        this.capacity.guests--;
      });
      this.rollbacks.add(rollback);
      void rollback.then(
        () => this.rollbacks.delete(rollback),
        (failure) => this.fail(failure),
      );
      return;
    }
  }

  private enter(guest: Guest): void {
    if (this.phase !== "open" || readOutcome(this.options.context.outcome)) return;
    guest.phase = "running";
    guest.worker.postMessage({ kind: "enter" });
  }
  private receiveGuest(guest: Guest, event: GuestWorkerEvent): void {
    if (!sameThread(guest.thread, event.thread) || guest.phase === "stopped") return;
    guest.wait.receive(event);
    if (event.kind === "ready") {
      guest.ready.resolve("ready");
      if (guest.thread.tid === 1) this.enter(guest);
      return;
    }
    if (event.kind === "process-terminal") {
      this.terminal();
      const winner = readOutcome(this.options.context.outcome);
      if (winner?.kind === "signaled") this.options.context.defaultSignal(winner.code);
      else if (winner?.kind === "start-failed")
        this.options.context.startFailed(new Error("thread guest startup failed"));
      else if (winner) this.options.context.exit(winner.code);
      return;
    }
    if (event.kind !== "host-idle") return;
    guest.phase = "idle";
    guest.worker.onmessage = null;
    void guest.control
      .settle(() => guest.lane.retire())
      .then(
        () => {
          guest.idle.resolve();
          if (this.phase === "open") void this.stopGuest(guest).catch((error) => this.fail(error));
        },
        (error) => {
          guest.idle.reject(error);
          this.fail(error);
        },
      );
  }
  terminal(): void {
    const winner = readOutcome(this.options.context.outcome);
    if (!winner) return;
    this.backing.seal(winner);
    if (this.phase === "open") this.phase = "draining";
    for (const guest of this.guests.values()) {
      guest.ready.resolve("closed");
      guest.wait.beginTerminal();
      guest.worker.postMessage({ kind: "close" });
      void guest.lane.retire().catch((error) => this.fail(error));
    }
  }
  fence(): Promise<void> {
    return (this.fencing ??= Promise.resolve().then(() => this.safety()));
  }
  private async safety(): Promise<void> {
    try {
      this.terminal();
      await this.backing.fence({
        kind: "service",
        alias: this.serviceAlias,
        drain: async () => {
          await this.control("drain");
          await Promise.all(this.rollbacks);
          await Promise.all(
            Array.from(this.guests.values(), (guest) =>
              deadline(guest.idle.promise, "guest host-idle"),
            ),
          );
        },
        filesystem: () => this.options.filesystemFence(),
        dispose: () => this.control("dispose"),
      });
      this.serviceSafe = true;
    } catch (error) {
      this.fail(error);
      throw error;
    }
  }
  private stopGuest(guest: Guest): Promise<void> {
    return (guest.stopped ??= guest.alias
      .stop({
        idle: () => deadline(guest.idle.promise, "guest host-idle"),
        terminate: () => guest.worker.terminate(),
        cleanup: () => {
          guest.worker.onmessage = null;
          guest.worker.onerror = null;
        },
      })
      .then(() => {
        guest.phase = "stopped";
        this.guests.delete(guest.thread.tid);
        this.capacity.guests--;
      }));
  }
  stop(): Promise<void> {
    return (this.stopping ??= Promise.resolve().then(() => this.stopAll()));
  }
  private async stopAll(): Promise<void> {
    const errors: unknown[] = [];
    try {
      await this.fence();
    } catch (error) {
      errors.push(error);
    }
    const results = await Promise.allSettled(
      Array.from(this.guests.values(), (guest) => this.stopGuest(guest)),
    );
    for (const result of results) if (result.status === "rejected") errors.push(result.reason);
    try {
      await this.serviceAlias.stop({
        idle: () => this.fence(),
        terminate: () => {
          if (!this.serviceSafe) throw new Error("service safety fence has not passed");
          return this.service.terminate();
        },
        cleanup: () => {
          this.service.onmessage = null;
          this.service.onerror = null;
        },
      });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) {
      this.backing.fail(errors);
      throw new AggregateError(errors, "thread aggregate stop failed");
    }
    try {
      this.options.cleanup();
      if (this.backing.retire().kind !== "awaiting-collection")
        throw new Error("thread backing did not retire");
    } catch (error) {
      this.backing.fail(error);
      throw error;
    }
    this.capacity.processes--;
    this.phase = "stopped";
  }
}
function sameThread(a: ThreadKey, b: unknown): boolean {
  return (
    !!b &&
    typeof b === "object" &&
    "directory" in b &&
    "pid" in b &&
    "tid" in b &&
    a.directory === b.directory &&
    a.pid === b.pid &&
    a.tid === b.tid
  );
}
function deadline<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} deadline`)), 5000);
    }),
  ]).finally(() => clearTimeout(timer));
}
