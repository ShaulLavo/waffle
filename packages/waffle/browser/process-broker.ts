import { ReadyWorkerPool } from "./worker-pool.js";
import { createNotificationBridge, type NotificationBridge } from "./notification-relay.js";
import { snapshotHostIdentity, type RuntimeHostIdentity } from "./process-context.js";
import { drainDiagnostic } from "./diagnostic.js";
import { WorkerExecutableAccess, rejectWorkerAccess } from "../proc/worker-access.js";
import { directoryGroups, directoryProcesses, isCollectedProcess } from "../proc/directory.js";
import { type ControlCells, TaggedCells, controlLoad, controlStore } from "../proc/control.js";
import { type FilesystemConnection, type FilesystemIdentity, isRevoked } from "../fs/protocol.js";

import type { ProcessSupervisor, RootProcessOptions } from "../proc/supervisor.js";
import type { ExecutableRegistry } from "../proc/registry.js";
import type { ProcessIdentityAllocator } from "../proc/identity.js";
import type { ProcessTable } from "../proc/table.js";
import {
  type ChildExitEvent,
  type ProcessContext,
  type ProcessHandle,
  checkedSignal,
  checkedProcessCwd,
  ProcessErrno,
  ProcessError,
} from "../proc/types.js";
import { requestSignal, createSignalState, type SignalTransport } from "../proc/signals.js";
import {
  claimOutcome,
  outcomeWord,
  readOutcome,
  startStatus,
  serializeOutcome,
} from "../proc/outcome.js";
import { WorkerProcessBroker } from "../proc/worker-broker.js";
import {
  reportProcessAdmission,
  type ProcessAdmissionEvent,
  type ProcessAdmissionObserver,
} from "../proc/admission.js";
import {
  confirmWorkerProcessJob,
  installWorkerBindings,
  wakeWorkerProcess,
  workerProcessDirectoryId,
  workerProcessState,
  type WorkerDescriptorCodec,
  type WorkerProcessMessage,
  type WorkerProcessTransport,
} from "../proc/worker-client.js";
import { createFilesystemDescriptorCodec } from "../proc/filesystem-codec.js";
import { WorkerPipeBroker } from "../proc/worker-pipes.js";
import {
  attachPipePublicationRegistry,
  PipeEndpoint,
  PipePublicationRegistry,
} from "../proc/pipes.js";
import { createRuntimeTerminalCodec } from "./runtime-terminals.js";
import type { RuntimeWorkerRequest } from "./worker.js";

export interface ProcessFilesystem {
  fork?(): FilesystemConnection;
  connect(identity: FilesystemIdentity): FilesystemConnection;
  revoke(identity: FilesystemIdentity): void;
  reap(identity: FilesystemIdentity): void;
  quiesce(identity: FilesystemIdentity): Promise<void>;
  sweep?(): void;
}
export interface ProcessController {
  filesystem?: FilesystemIdentity;
  acknowledged?(): boolean;
  launch?(context: ProcessContext): ProcessHandle | Promise<ProcessHandle>;
  startFailed?(error: unknown, active: () => boolean): void | Promise<void>;
  canConfirmExit?(): boolean;
  quiesce?(): void | Promise<void>;
  exited?(event: ChildExitEvent): void;
  revoke?(): void;
  /** Physical consumer cleanup, after its filesystem admission fence. */
  stop?(): void | Promise<void>;
  wake?(): void;
  /** Release adapter ancestry after this root and its descendants no longer need it. */
  retired?(): void;
}
export interface BrowserProcessBrokerOptions {
  hostIdentity?: RuntimeHostIdentity | null;
  filesystem: ProcessFilesystem;
  /** Injectable lazy supervisor module loader; pipe-only roots never invoke it. */
  activate?: () => Promise<typeof import("../proc/index.js")>;
  identities: ProcessIdentityAllocator;
  registry: ExecutableRegistry;
  table: ProcessTable;
  launch(context: ProcessContext): ProcessHandle | Promise<ProcessHandle>;
  onError?(error: unknown): void;
  /** Opt-in metadata only; observers must not reenter process control. Exceptions are ignored. */
  onProcessAdmission?: ProcessAdmissionObserver;
}
/** A reserved, admitted descendant of a runtime root whose guest has not been launched. */
export interface RuntimeDescendant {
  readonly pid: number;
  readonly parentPid: number;
  readonly job: number;
  /** A structured clone of the spawn's metadata without the runtime-owned `filesystem` and
   * `pipeRegistry` fields. Inherited fields are claims from the parent, not proof of authority. */
  readonly data: Readonly<Record<string, unknown>>;
}
/** The root controller's preparation of one descendant. */
export interface RuntimeDescendantPreparation {
  /** Structured-cloneable fields merged into the descendant's metadata before its adapter
   * launches. `filesystem` and `pipeRegistry` stay runtime-owned and are rejected. */
  readonly data?: Readonly<Record<string, unknown>>;
  /** Runs once, before the root's `retired()`, if the descendant ends without entering its
   * guest: publication or launch failure, start failure, a kill before entry, or disposal. */
  cancel?(): void;
}
export interface RuntimeRootOptions {
  filesystem?: FilesystemIdentity;
  acknowledged?(): boolean;
  output?(fd: 1 | 2, data: Uint8Array): void;
  quiesce?(): void | Promise<void>;
  stop?(): void | Promise<void>;
  wake?(): void;
  retired?(): void;
  /** Called once for every transport-backed descendant of this root, after the runtime admits
   * its reservation and before its adapter launches, so its guest cannot enter first. The
   * descendant's directory row exists for the whole call. The launch awaits the result; a
   * throw or rejection fails the descendant's start and the hook owns its own partial work.
   * Captured when the root is adopted. Process control may be reentered. */
  prepareDescendant?(
    descendant: RuntimeDescendant,
  ): RuntimeDescendantPreparation | void | Promise<RuntimeDescendantPreparation | void>;
}
export interface WorkerLaunchOptions<T extends RuntimeWorkerRequest = RuntimeWorkerRequest> {
  /** Module entry stays inert until its first request; unused workers may be prestarted. */
  workerUrl: string;
  notificationWorkerUrl?: string;
  request: Omit<
    T,
    "filesystem" | "runtimeProcess" | "startupStderr" | "hostIdentity" | "notifications"
  >;
  cleanup?(): void;
  onMessage?(message: unknown, context: ProcessContext): void;
  wake?(): void;
  executableName?(name: string): string;
}
interface RuntimeChild {
  notifications?: NotificationBridge;
  filesystem: FilesystemIdentity;
  context: ProcessContext;
  worker?: Worker;
  acknowledged: boolean;
  failed: boolean;
  stopped: boolean;
  quiescence?: Promise<void>;
  stopping?: Promise<void>;
  startupStderr?: PipeEndpoint;
  cleanup?(): void;
  wake?(): void;
}

/** Page-owned process admission and descriptor transport. Guest adapter policy is injected. */
export class BrowserProcessBroker {
  private readonly hostIdentity: RuntimeHostIdentity | null;
  private suspended = false;
  private readonly retirementGate = Promise.withResolvers<void>();
  private disposing?: Promise<void>;
  private activation?: Promise<ProcessSupervisor>;
  private supervisor?: ProcessSupervisor;
  private readonly pipes = new WorkerPipeBroker();
  private readonly workers = new ReadyWorkerPool();
  private readonly roots = new Map<number, WorkerProcessTransport>();
  private readonly reservedRoots = new Map<
    number,
    RootProcessOptions & SignalTransport & { pid: number; job: number }
  >();
  private readonly completedRoots = new Set<number>();
  private readonly rootLeases = new Map<number, number>();
  private readonly controllers = new Map<number, ProcessController>();
  private revokedControllers?: Set<number>;
  private readonly quiescedControllers = new Set<number>();
  private controllerStops?: Map<number, { pending: Promise<void>; controllerStop: boolean }>;
  private launches?: Set<number>;
  private pendingLaunches?: Map<number, { acquired: Promise<void>; settled: Promise<void> }>;
  private readonly outputs = new Map<number, RuntimeRootOptions["output"]>();
  private readonly registries = new Map<number, PipePublicationRegistry>();
  private readonly children = new Map<number, RuntimeChild>();
  private readonly fences = new Map<number, Promise<void>>();
  private readonly startupDiagnostics = new Set<Promise<void>>();
  private readonly rejectedTransfers = new Map<string, Promise<void>>();
  private cleanupCodec?: WorkerDescriptorCodec;
  private readonly acquiredProcesses = new Map<number, string>();
  private readonly stopTrackingConsumers: () => void;
  private readonly accesses = new WorkerExecutableAccess({
    active: (sender) => !this.suspended && !isRevoked(this.filesystem(sender)),
    check: async (_sender, path, cwd, active) => {
      await this.options.registry.check(path, cwd, active);
      return 0;
    },
  });
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly transport: WorkerProcessBroker;
  constructor(private readonly options: BrowserProcessBrokerOptions) {
    void this.retirementGate.promise.catch(() => {});
    this.hostIdentity = snapshotHostIdentity(options.hostIdentity);
    this.transport = new WorkerProcessBroker({
      supervisor: () => this.ready(),
      codec: (transport) => this.descriptorCodec(transport),
      discard: (token) => this.discardCodec().discard(token),
      onPipe: (handle) =>
        this.pipes.attach(handle as import("../proc/pipes.js").PipeEndpointHandle),
      pumpPipes: () => this.pipes.pump(),
      onError: (error) => this.report(error),
      onAdmission: options.onProcessAdmission,
      onAdmitted: (transport) => this.acquireProcess(transport),
      quiesce: (_pid, transport) => this.quiesceUnstarted(transport),
    });
    this.stopTrackingConsumers = options.table.onRemove((record) =>
      this.releaseAcquiredProcess(record.pid),
    );
  }
  ready(): Promise<ProcessSupervisor> {
    return (this.activation ??= (this.options.activate?.() ?? import("../proc/index.js")).then(
      (proc) => {
        const supervisor = (this.supervisor = new proc.ProcessSupervisor({
          registry: this.options.registry,
          table: this.options.table,
          launch: (context) => {
            if (this.suspended) throw new Error("Process broker is disposed");
            this.traceProcess(context, "launching");
            (this.launches ??= new Set()).add(context.pid);
            let acquireLaunch!: () => void, settleLaunch!: () => void;
            // A launcher may select an outcome synchronously before returning its handle.
            // Retain its cleanup authority before invoking any adapter code.
            (this.pendingLaunches ??= new Map()).set(context.pid, {
              acquired: new Promise<void>((resolve) => {
                acquireLaunch = resolve;
              }),
              settled: new Promise<void>((resolve) => {
                settleLaunch = resolve;
              }),
            });
            const settled = () => {
              this.pendingLaunches?.delete(context.pid);
              this.releaseAcquiredProcess(context.pid);
              acquireLaunch();
              settleLaunch();
            };
            let launched: ProcessHandle | Promise<ProcessHandle>;
            try {
              launched =
                this.controllers.get(context.pid)?.launch?.(context) ??
                this.options.launch(context);
            } catch (error) {
              this.launches.delete(context.pid);
              settled();
              throw error;
            }
            const track = (handle: ProcessHandle): ProcessHandle => {
              this.traceProcess(context, "launched");
              if (this.children.has(context.pid) || !this.controllers.has(context.pid)) {
                this.launches?.delete(context.pid);
                settled();
                return handle;
              }
              acquireLaunch();
              // External launchers own their physical handle. Keep controller authority until
              // that handle's asynchronous cleanup settles, not merely its child-exit event.
              return {
                terminate: () => {
                  let pending: void | Promise<void>;
                  try {
                    pending = handle.terminate();
                  } catch (error) {
                    settled();
                    throw error;
                  }
                  if (pending) {
                    const stopping = pending
                      .then(() => {
                        this.controllerStops?.delete(context.pid);
                        this.launches?.delete(context.pid);
                        this.retireChildController(context.pid);
                      })
                      .finally(settled);
                    (this.controllerStops ??= new Map()).set(context.pid, {
                      pending: stopping,
                      controllerStop: false,
                    });
                    return stopping;
                  }
                  this.launches?.delete(context.pid);
                  this.retireChildController(context.pid);
                  settled();
                },
              };
            };
            if (!("then" in launched)) return track(launched);
            // Disposal owns late external handles too. Settlement follows physical cleanup,
            // not just promise resolution, so retirement cannot outrun a pending launcher.
            return Promise.resolve(launched).then(track, (error) => {
              this.launches?.delete(context.pid);
              settled();
              // A terminal outcome can win while this external launcher is still pending.
              if (readOutcome(context.outcome))
                void this.stopController(context.pid)?.catch((error) => this.report(error));
              throw error;
            });
          },
          canConfirmExit: (pid) => {
            const child = this.children.get(pid);
            return (
              this.suspended ||
              (child
                ? child.acknowledged || child.failed
                : (this.controllers.get(pid)?.canConfirmExit?.() ?? true))
            );
          },
          quiesce: (pid) => this.quiesceProcess(pid),
          retire: (pid) => this.retireProcess(pid),
          startFailed: (pid, error, active) => this.writeStartupDiagnostic(pid, error, active),
          onError: (error) => this.report(error),
        }));
        supervisor.onChildExit((event) => {
          this.revokeRuntimeProcess(event.pid);
          const transport = this.transport.get(event.pid);
          if (transport && !this.children.get(event.pid)?.acknowledged)
            this.options.filesystem.revoke(this.filesystem(transport));
          void (async () => {
            try {
              this.controllers.get(event.pid)?.exited?.(event);
            } finally {
              // Notification failures cannot skip failed-start cleanup. Report them only
              // after the same fenced physical stop used by successful notifications.
              const child = this.children.get(event.pid);
              if (child) await this.stop(child);
              else {
                await this.pendingLaunches?.get(event.pid)?.settled;
                if (!this.launches?.has(event.pid)) await this.stopController(event.pid);
              }
              this.retireRoots();
            }
          })().catch((error) => this.report(error));
        });
        supervisor.onProcessQuiescent((event) => {
          this.fences.delete(event.pid);
          this.releaseAcquiredProcess(event.pid);
        });
        supervisor.onJobReap(() => this.retireRoots());
        for (const root of this.reservedRoots.values())
          if (!supervisor.get(root.pid)) {
            supervisor.createRoot(root);
            supervisor.registerRevocation(root.pid, () => this.revokeController(root.pid));
          }
        for (const transport of this.roots.values())
          this.activateRuntimeRoot(supervisor, transport);
        if (this.suspended) supervisor.dispose();
        return supervisor;
      },
    ));
  }
  /** Register an explicit adapter controller (including legacy transports), not a default adapter. */
  registerController(pid: number, controller: ProcessController): void {
    if (this.suspended) throw new Error("Process broker is disposed");
    if (this.controllers.has(pid)) throw new Error(`Process ${pid} already has a controller`);
    this.controllers.set(pid, controller);
    this.acquireController(pid);
    if (this.supervisor?.get(pid))
      this.supervisor.registerRevocation(pid, () => this.revokeController(pid));
  }
  /** Reserve an externally executed root without activating the optional supervisor. */
  reserveRoot(root: RootProcessOptions, controller: ProcessController = {}): number {
    if (this.suspended) throw new Error("Process broker is disposed");
    const initialCwd = root.cwd;
    const cwd = checkedProcessCwd(initialCwd === undefined ? "/" : initialCwd);
    const pid = root.pid ?? this.options.identities.pid(),
      job = root.job ?? this.options.identities.job();
    this.options.identities.observePid(pid);
    this.options.identities.observeJob(job);
    const word = (value?: ControlCells | SharedArrayBuffer) =>
      value instanceof TaggedCells
        ? value
        : value instanceof Int32Array
          ? value
          : new Int32Array(value ?? new SharedArrayBuffer(4));
    const reserved = {
      ...root,
      pid,
      job,
      cwd,
      signalState: createSignalState(root.signalState),
      outcome: outcomeWord(root.outcome),
      interrupt: word(root.interrupt),
      requestedSignal: word(root.requestedSignal),
    };
    this.registerController(pid, controller);
    this.reservedRoots.set(pid, reserved);
    if (this.supervisor) {
      this.supervisor.createRoot(reserved);
      this.supervisor.registerRevocation(pid, () => this.revokeController(pid));
    }
    return pid;
  }
  /** Keep an accepted external spawn's ancestry until its asynchronous admission finishes. */
  retainRoot(pid: number): () => void {
    if (this.suspended) throw new Error("Process broker is disposed");
    if (!this.reservedRoots.has(pid)) throw new Error(`Unknown root process ${pid}`);
    this.rootLeases.set(pid, (this.rootLeases.get(pid) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.rootLeases.get(pid) ?? 1) - 1;
      if (remaining) this.rootLeases.set(pid, remaining);
      else this.rootLeases.delete(pid);
      this.retireRoots();
    };
  }
  private retainsRoot(
    transport: WorkerProcessTransport,
    pid: number,
    job: number | undefined,
  ): boolean {
    if (Array.from(directoryGroups(transport.directory)).some((group) => group.id !== job))
      return true;
    return Array.from(directoryProcesses(transport.directory)).some((state) => {
      try {
        return (
          state.pid !== pid &&
          (controlLoad(state.confirmed, 0) === 0 ||
            (state.job !== job && controlLoad(state.jobPending, 0) >= 0))
        );
      } catch (error) {
        if (!isCollectedProcess(error)) throw error;
        return false;
      }
    });
  }
  private retireRoots(): void {
    if (this.suspended) return;
    for (const pid of this.completedRoots) {
      if (this.rootLeases.has(pid)) continue;
      // Control ancestry is compressed past exited parents. Immutable rootPid, not that
      // mutable chain, owns controller/output lifetime until the last descendant is safe.
      if (
        Array.from(this.options.table.values()).some(
          (record) => record.pid !== pid && record.rootPid === pid && !record.result,
        )
      )
        continue;
      const transport = this.roots.get(pid),
        root = this.reservedRoots.get(pid);
      if (transport && this.retainsRoot(transport, pid, root?.job)) continue;
      const controller = this.controllers.get(pid);
      this.transport.releaseRoot(pid);
      this.options.table.remove(pid);
      if (root && !this.options.table.job(root.job)?.members.size)
        this.options.table.removeJob(root.job);
      this.completedRoots.delete(pid);
      this.reservedRoots.delete(pid);
      this.controllers.delete(pid);
      this.quiescedControllers.delete(pid);
      this.revokedControllers?.delete(pid);
      this.roots.delete(pid);
      this.outputs.delete(pid);
      this.registries.delete(pid);
      this.fences.delete(pid);
      this.releaseAcquiredProcess(pid);
      try {
        controller?.retired?.();
      } catch (error) {
        this.report(error);
      }
    }
  }
  async adoptRoot(root: RootProcessOptions, controller: ProcessController = {}): Promise<number> {
    const pid = this.reserveRoot(root, controller);
    // Reservation transfers an external consumer's teardown capabilities to this owner.
    // Activation may fail after creating its table record; keep those capabilities until
    // disposal even when the caller observes a rejected admission promise.
    await this.ready();
    if (this.suspended) throw new Error("Process broker is disposed");
    return pid;
  }
  async adoptRuntimeRoot(
    transport: WorkerProcessTransport,
    options: RuntimeRootOptions = {},
  ): Promise<void> {
    if (this.suspended) throw new Error("Process broker is disposed");
    const cwd = checkedProcessCwd(transport.cwd);
    if (transport.identity !== this.options.identities.buffer)
      throw new TypeError("root must borrow the runtime identity allocator");
    this.filesystem(transport);
    const state = workerProcessState(transport);
    this.transport.adoptRoot(transport);
    this.roots.set(state.pid, transport);
    this.outputs.set(state.pid, options.output);
    const data = transport.data as {
      filesystem: FilesystemIdentity;
      pipeRegistry?: import("../proc/pipes.js").PipePublicationRegistryHandle;
    };
    const registry = data.pipeRegistry
      ? attachPipePublicationRegistry(data.pipeRegistry)
      : new PipePublicationRegistry({ wake: state.wake });
    registry.registerProcess(state.pid);
    this.registries.set(state.pid, registry);
    transport.data = { ...data, pipeRegistry: registry.handle() };
    this.reserveRoot({ pid: state.pid, job: state.job, cwd, ...state.signals }, options);
    if (this.activation) {
      const supervisor = await this.activation;
      if (this.suspended) throw new Error("Process broker is disposed");
      this.activateRuntimeRoot(supervisor, transport);
    }
  }
  private activateRuntimeRoot(
    supervisor: ProcessSupervisor,
    transport: WorkerProcessTransport,
  ): void {
    const state = workerProcessState(transport);
    if (!supervisor.get(state.pid))
      supervisor.createRoot({
        pid: state.pid,
        job: state.job,
        cwd: transport.cwd,
        ...state.signals,
      });
    supervisor.registerRevocation(state.pid, () => this.revokeRuntimeProcess(state.pid));
    installWorkerBindings(
      transport,
      supervisor.get(state.pid)!.descriptors,
      this.descriptorCodec(transport),
    );
    const result = readOutcome(state.signals.outcome);
    if (result?.kind === "signaled") supervisor.defaultSignal(state.pid, result.code);
    else if (result) supervisor.exit(state.pid, result.code);
  }
  private filesystem(transport: WorkerProcessTransport): FilesystemIdentity {
    const identity = (transport.data as { filesystem?: FilesystemIdentity } | undefined)
      ?.filesystem;
    if (
      !identity ||
      typeof identity !== "object" ||
      !Number.isSafeInteger(identity.owner) ||
      identity.owner <= 0 ||
      ![
        identity.epoch,
        identity.signal,
        identity.shared,
        identity.capabilities,
        identity.sections,
        identity.ownerStates,
      ].every((buffer) => buffer instanceof SharedArrayBuffer && buffer.byteLength >= 4) ||
      identity.ownerStates.byteLength < (identity.owner + 1) * 4 ||
      !Array.isArray(identity.revocations) ||
      !identity.revocations.length ||
      !identity.revocations.every(
        (buffer) => buffer instanceof SharedArrayBuffer && buffer.byteLength >= 4,
      ) ||
      !Array.isArray(identity.segments) ||
      !identity.segments.every((buffer) => buffer instanceof SharedArrayBuffer) ||
      !Array.isArray(identity.reservations) ||
      !Number.isFinite(identity.maxBytes)
    )
      throw new TypeError("runtime process has no valid filesystem identity");
    return identity;
  }
  private descriptorCodec(transport: WorkerProcessTransport) {
    return this.pipes.codec(
      createRuntimeTerminalCodec({
        fallback: createFilesystemDescriptorCodec(this.filesystem(transport), undefined, () =>
          this.options.filesystem.sweep?.(),
        ),
        output: (fd, bytes) => this.outputFor(workerProcessState(transport).pid)?.(fd, bytes),
      }),
    );
  }
  private discardCodec() {
    return (this.cleanupCodec ??= this.pipes.codec(
      createRuntimeTerminalCodec({
        fallback: createFilesystemDescriptorCodec(undefined, undefined, () =>
          this.options.filesystem.sweep?.(),
        ),
      }),
    ));
  }
  private processLifetime(transport: WorkerProcessTransport): string {
    return `${workerProcessDirectoryId(transport)}:${transport.slot}:${transport.pid}`;
  }
  private runtimeProcessLifetime(pid: number): string | undefined {
    // Only adopted directories can resolve a controller registered before publication.
    for (const root of this.roots.values()) {
      const state = Array.from(directoryProcesses(root.directory)).find(
        (state) => state.pid === pid,
      );
      if (state) return `${workerProcessDirectoryId(root)}:${state.slot}:${pid}`;
    }
    return undefined;
  }
  private acquireProcess(transport: WorkerProcessTransport): void {
    const lifetime = this.processLifetime(transport);
    const acquired = this.acquiredProcesses.get(transport.pid);
    if (acquired && acquired !== lifetime)
      throw new Error("process consumer belongs to another lifetime");
    this.acquiredProcesses.set(transport.pid, lifetime);
  }
  private acquireController(pid: number): void {
    if (this.acquiredProcesses.has(pid) || !this.controllers.has(pid)) return;
    const lifetime = this.runtimeProcessLifetime(pid);
    if (lifetime) this.acquiredProcesses.set(pid, lifetime);
  }
  private releaseAcquiredProcess(pid: number): void {
    if (
      this.options.table.get(pid) ||
      this.controllers.has(pid) ||
      this.children.has(pid) ||
      this.launches?.has(pid) ||
      this.pendingLaunches?.has(pid) ||
      this.fences.has(pid)
    )
      return;
    this.acquiredProcesses.delete(pid);
  }
  private async quiesceUnstarted(transport: WorkerProcessTransport): Promise<void> {
    // prepareSpawn may register before publication; resolve against our adopted roots.
    this.acquireController(transport.pid);
    const acquired = this.acquiredProcesses.get(transport.pid) === this.processLifetime(transport);
    let filesystem: FilesystemIdentity | undefined;
    try {
      filesystem = this.filesystem(transport);
    } catch (error) {
      // Invalid metadata proves nothing about an acquired consumer, but foreign PID
      // aliases never inherit a local lifetime's physical cleanup obligations.
      if (acquired) throw error;
    }
    const pending: Promise<void>[] = [];
    if (filesystem) {
      this.options.filesystem.revoke(filesystem);
      pending.push(this.options.filesystem.quiesce(filesystem));
    }
    // The payload's identity cannot replace a controller's distinct identity or adapter fence.
    if (acquired) pending.push(Promise.resolve(this.quiesceProcess(transport.pid)));
    await Promise.all(pending);
    this.collectRuntimeProcess(transport.pid, workerProcessDirectoryId(transport));
  }
  private outputFor(pid: number): RuntimeRootOptions["output"] {
    const rootPid = this.options.table.get(pid)?.rootPid;
    if (rootPid !== undefined && this.outputs.has(rootPid)) return this.outputs.get(rootPid);
    for (;;) {
      if (this.outputs.has(pid)) return this.outputs.get(pid);
      const parent = this.options.table.parentOf(pid);
      if (!parent) return undefined;
      pid = parent;
    }
  }
  revokeRuntimeProcess(pid: number, directoryId?: string): void {
    this.accesses.revoke(pid, directoryId);
    if (directoryId === undefined) this.disposeNotifications(this.children.get(pid));
    // A root directory owns its publication registry. Rejected foreign identities cannot
    // revoke an admitted or still-pending process that happens to use the same numeric PID.
    for (const [rootPid, transport] of this.roots) {
      if (directoryId !== undefined && workerProcessDirectoryId(transport) !== directoryId)
        continue;
      for (const state of directoryProcesses(transport.directory))
        if (state.pid === pid) {
          this.disposeNotifications(this.children.get(pid));
          this.registries.get(rootPid)?.revoke(pid);
          return;
        }
    }
  }
  async runtimeMessage(message: WorkerProcessMessage, senderPid: number): Promise<void> {
    this.traceSpawn(message, "received");
    const sender = this.transport.getIdentity(senderPid);
    let result: ReturnType<typeof readOutcome> = null;
    try {
      if (sender) result = readOutcome(workerProcessState(sender).signals.outcome);
    } catch (error) {
      if (
        !(error instanceof ProcessError) ||
        (error.errno !== ProcessErrno.SRCH && error.errno !== ProcessErrno.CHILD)
      )
        throw error;
    }
    // A published spawn or consuming receipt can arrive after its original sender's
    // process row was collected. The still-live directory and captured PID authenticate
    // the notice, never the process now occupying its old slot.
    let retainedNotice = false;
    if (
      !sender &&
      (message.operation === "spawn" ||
        message.operation === "reap-job" ||
        message.operation === "reap-process")
    ) {
      const directory = workerProcessDirectoryId(message.transport);
      const root = Array.from(this.roots.values()).find(
        (root) => workerProcessDirectoryId(root) === directory,
      );
      if (root) {
        if (message.operation === "reap-job" || message.operation === "reap-process")
          retainedNotice = message.transport.pid === senderPid;
        else {
          try {
            retainedNotice = workerProcessState(message.transport).parentPid === senderPid;
          } catch (error) {
            if (
              !(error instanceof ProcessError) ||
              (error.errno !== ProcessErrno.SRCH && error.errno !== ProcessErrno.CHILD)
            )
              throw error;
          }
        }
      }
    }
    const revoked = this.senderRevoked(message, senderPid, sender, result);
    if ((!sender && !retainedNotice) || this.suspended || revoked) {
      this.rejectMessage(
        message,
        senderPid,
        this.suspended
          ? "broker-disposed"
          : !sender
            ? "unknown-sender"
            : result?.kind === "signaled"
              ? "sender-signaled"
              : "sender-revoked",
      );
      return;
    }
    if (message.operation === "access" || message.operation === "access-cancel") {
      if (
        !sender ||
        result ||
        workerProcessState(message.transport).pid !== senderPid ||
        workerProcessDirectoryId(sender) !== workerProcessDirectoryId(message.transport)
      ) {
        this.rejectMessage(message, senderPid, "wrong-sender");
        return;
      }
      await this.accesses.handle(message, sender);
      return;
    }
    await this.transport.handle(message, senderPid);
    this.retireRoots();
    if (message.operation !== "pipe") this.watch();
  }
  private senderRevoked(
    message: WorkerProcessMessage,
    senderPid: number,
    sender: WorkerProcessTransport | undefined,
    result: ReturnType<typeof readOutcome>,
  ): boolean {
    if (!sender || message.operation === "reap-job" || message.operation === "reap-process")
      return false;
    try {
      return result?.kind === "signaled" || (!result && isRevoked(this.filesystem(sender)));
    } catch (error) {
      // Sender validation owns rejection cleanup for any incoming transferred resources.
      this.rejectMessage(message, senderPid, "sender-revoked");
      throw error;
    }
  }
  rejectRuntimeMessage(
    message: WorkerProcessMessage,
    senderPid?: number,
    reason: ProcessAdmissionEvent["reason"] = "external-rejection",
  ): void {
    this.traceSpawn(message, "received");
    this.rejectMessage(message, senderPid, reason);
  }
  private traceProcess(
    identity: Pick<ProcessAdmissionEvent, "pid" | "parentPid" | "job">,
    stage: ProcessAdmissionEvent["stage"],
    reason?: ProcessAdmissionEvent["reason"],
  ): void {
    if (!this.options.onProcessAdmission) return;
    const transport = this.transport.getIdentity(identity.pid);
    reportProcessAdmission(
      this.options.onProcessAdmission,
      identity,
      stage,
      reason,
      transport ? workerProcessDirectoryId(transport) : undefined,
    );
  }
  private traceSpawn(
    message: WorkerProcessMessage,
    stage: ProcessAdmissionEvent["stage"],
    reason?: ProcessAdmissionEvent["reason"],
  ): void {
    if (message.operation !== "spawn" || !this.options.onProcessAdmission) return;
    try {
      reportProcessAdmission(
        this.options.onProcessAdmission,
        workerProcessState(message.transport),
        stage,
        reason,
        workerProcessDirectoryId(message.transport),
      );
    } catch (error) {
      if (
        !(error instanceof ProcessError) ||
        (error.errno !== ProcessErrno.SRCH && error.errno !== ProcessErrno.CHILD)
      )
        throw error;
    }
  }
  private rejectMessage(
    message: WorkerProcessMessage,
    senderPid: number | undefined,
    reason: ProcessAdmissionEvent["reason"],
  ): void {
    if (message.operation === "access" || message.operation === "access-cancel") {
      rejectWorkerAccess(message);
      return;
    }
    if (message.operation === "reap-job") {
      if (!this.suspended && senderPid !== undefined)
        void this.transport.handle(message, senderPid).catch((error) => this.report(error));
      return;
    }
    if (message.operation !== "spawn") return;
    const transport = message.transport;
    let state: ReturnType<typeof workerProcessState>;
    try {
      state = workerProcessState(transport);
    } catch (error) {
      if (
        error instanceof ProcessError &&
        (error.errno === ProcessErrno.SRCH || error.errno === ProcessErrno.CHILD)
      )
        return;
      throw error;
    }
    const directory = workerProcessDirectoryId(transport);
    const key = `${directory}:${state.pid}`;
    if (this.transport.getIdentity(state.pid, directory) || this.rejectedTransfers.has(key)) {
      this.traceSpawn(message, "dropped", "already-registered");
      return;
    }
    this.traceSpawn(message, "rejected", reason);
    requestSignal(state.signals, 9);
    this.revokeRuntimeProcess(state.pid, workerProcessDirectoryId(transport));
    let resolve!: () => void, reject!: (error: unknown) => void;
    const pending = new Promise<void>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    this.rejectedTransfers.set(key, pending);
    void this.releaseRejectedTransfer(transport).then(resolve, reject);
    void pending.then(
      () => this.rejectedTransfers.delete(key),
      (error) => this.report(error),
    );
  }
  private async releaseRejectedTransfer(transport: WorkerProcessTransport): Promise<void> {
    let cleaned = true;
    const codec = this.discardCodec();
    for (const token of transport.resources) {
      try {
        codec.discard(token);
      } catch (error) {
        cleaned = false;
        this.report(error);
      }
    }
    wakeWorkerProcess(transport);
    await this.quiesceUnstarted(transport);
    if (!cleaned) return;
    controlStore(workerProcessState(transport).confirmed, 0, 1);
    confirmWorkerProcessJob(transport);
  }

  transportFor(pid: number): WorkerProcessTransport | undefined {
    return this.transport.get(pid);
  }
  /** Legacy handle ABIs have no job waiter; release their empty, unshared completion metadata. */
  releaseLegacyJob(job: number): void {
    this.retireRoots();
    const record = this.options.table.job(job);
    if (
      !record ||
      record.members.size ||
      record.pendingMembers ||
      this.states().some((state) => state.job === job)
    )
      return;
    this.supervisor?.reapJob(record.ownerPid, job);
  }
  /**
   * A single-use module worker for a root the consumer launches itself, from the same precreated
   * pool as broker-launched children. It stays inert until the consumer posts its request; the
   * consumer owns its termination. Idle pool workers stop when the broker is disposed.
   */
  takeWorker(workerUrl: string): Worker {
    if (this.suspended) throw new Error("Process broker is disposed");
    return this.workers.take(workerUrl);
  }
  /** Whether this already-observed worker is still inert and owned by this broker's pool. */
  isIdleWorker(worker: Worker): boolean {
    return this.workers.isIdle(worker);
  }
  launchWorker<T extends RuntimeWorkerRequest>(
    context: ProcessContext,
    options: WorkerLaunchOptions<T>,
  ): ProcessHandle {
    if (this.suspended) throw new Error("Process broker is disposed");
    const transport = this.transport.get(context.pid);
    if (!transport) throw new Error("process has no admitted worker transport");
    const filesystem = this.filesystem(transport);
    // Record cleanup ownership before either connection or Worker construction can throw.
    const child: RuntimeChild = {
      filesystem,
      context,
      acknowledged: false,
      failed: false,
      stopped: false,
      cleanup: options.cleanup,
      wake: options.wake,
    };
    this.children.set(context.pid, child);
    let connection: FilesystemConnection | undefined;
    let worker: Worker;
    try {
      const stderr = context.descriptors.get(2)?.resource;
      if (stderr instanceof PipeEndpoint) {
        // Imported page/worker descriptions share one close-once lifetime. Keep an independent
        // diagnostic capability through worker cleanup; bootstrap closes it at executable entry
        // so it cannot postpone ordinary guest fd2 closure or EOF.
        child.startupStderr = this.pipes.attach(stderr.handle()).duplicate(stderr);
        context.registerRevocation(() => child.startupStderr!.close());
      }
      if (options.notificationWorkerUrl)
        child.notifications = createNotificationBridge(options.notificationWorkerUrl);
      context.registerRevocation(() => {
        this.revokeRuntimeProcess(context.pid);
        this.options.filesystem.revoke(filesystem);
      });
      connection = this.options.filesystem.connect(filesystem);
      worker = child.worker = this.workers.take(options.workerUrl);
    } catch (error) {
      child.failed = true;
      this.disposeNotifications(child);
      connection?.port.close();
      throw error;
    }
    const request = {
      ...options.request,
      hostIdentity: this.hostIdentity,
      filesystem: connection,
      runtimeProcess: transport,
      outcome: serializeOutcome(context.outcome),
      startupStderr: child.startupStderr?.handle(),
      notifications: child.notifications?.connection,
    };
    this.watch();
    worker.onmessage = ({ data }: MessageEvent<any>) => {
      let selected: ReturnType<typeof readOutcome>,
        entered = false;
      try {
        selected = readOutcome(context.outcome);
        if (data.type === "error") entered = startStatus(context.outcome) === 0;
      } catch (error) {
        if (
          !(error instanceof ProcessError) ||
          (error.errno !== ProcessErrno.SRCH && error.errno !== ProcessErrno.CHILD)
        )
          throw error;
        if (data.type !== "runtime-proc") return;
        selected = null;
      }
      if (data.type === "runtime-proc") {
        if (workerProcessDirectoryId(data.transport) !== workerProcessDirectoryId(transport))
          return;
        if (selected?.kind === "signaled" || (!selected && isRevoked(filesystem)))
          this.rejectRuntimeMessage(
            data,
            context.pid,
            selected?.kind === "signaled" ? "sender-signaled" : "sender-revoked",
          );
        else {
          const message =
            data.operation === "spawn" && options.executableName
              ? {
                  ...data,
                  request: {
                    ...data.request,
                    executable: options.executableName(data.request.executable),
                  },
                }
              : data;
          void this.runtimeMessage(message, context.pid).catch((error) => this.report(error));
        }
        return;
      }
      if (data.type === "cleanup-error") {
        child.failed = true;
        this.report(new Error(`${data.message}: ${data.cleanupErrors.join("; ")}`));
        if (data.signal) context.defaultSignal(data.signal);
        else context.exit(data.code);
        this.stopSafely(child);
        return;
      }
      if (selected?.kind === "signaled" && data.type !== "exit" && data.type !== "error") {
        options.onMessage?.(data, context);
        return;
      }
      if (data.type === "stdout" || data.type === "stderr") {
        if (!this.suspended)
          this.outputFor(context.pid)?.(data.type === "stderr" ? 2 : 1, data.data);
        return;
      }
      if (data.type !== "exit" && data.type !== "error") {
        options.onMessage?.(data, context);
        return;
      }
      this.disposeNotifications(child);
      child.acknowledged = true;
      this.options.filesystem.reap(filesystem);
      if (data.cleanupErrors?.length)
        this.report(new Error(`Worker cleanup: ${data.cleanupErrors.join("; ")}`));
      if (data.type === "exit" && data.signal) context.defaultSignal(data.signal);
      else if (data.type === "exit") context.exit(data.code);
      else if (!entered)
        context.startFailed(Object.assign(new Error(data.message), { code: data.errno }));
      else context.fail(new Error(data.message));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      child.failed = true;
      let status: number;
      try {
        status = startStatus(context.outcome);
      } catch (error) {
        // Browser error delivery may outlive collection; it cannot target a recycled row.
        if (
          error instanceof ProcessError &&
          (error.errno === ProcessErrno.SRCH || error.errno === ProcessErrno.CHILD)
        )
          return;
        throw error;
      }
      if (status !== 0) context.startFailed(event.error ?? new Error(event.message));
      else context.fail(new Error(event.message));
    };
    try {
      const ports = [request.filesystem.port];
      if (request.notifications) ports.push(request.notifications.port);
      worker.postMessage(request, ports);
    } catch (error) {
      child.failed = true;
      this.disposeNotifications(child);
      request.filesystem.port.close();
      throw error;
    }
    return { terminate: () => this.stop(child) };
  }
  private writeStartupDiagnostic(
    pid: number,
    error: unknown,
    active: () => boolean,
  ): void | Promise<void> {
    const record = this.options.table.get(pid);
    if (record?.state === "starting") this.traceProcess(record, "rejected", "start-failed");
    // Host spawns can also have a bookkeeping parent. Only an admitted runtime_proc child
    // has a parent consuming START_FAILED; keep its full diagnostic on the host, not fd 2.
    const runtimeChild =
      record !== undefined && record.parentPid !== 0 && this.transport.get(pid) !== undefined;
    if (runtimeChild) this.report(error);
    const controller = this.controllers.get(pid);
    if (controller?.startFailed) return controller.startFailed(error, active);
    if (runtimeChild) return;
    const stderr = this.children.get(pid)?.startupStderr ?? record?.descriptors.get(2)?.resource;
    if (stderr?.kind !== "pipe" && stderr?.kind !== "terminal") return;
    const bytes = new TextEncoder().encode(`runtime: process start failed: ${String(error)}\n`);
    const write = stderr.tryWrite;
    if (!write)
      throw new ProcessError(
        ProcessErrno.NOTSUP,
        "startup diagnostic requires immediate stderr writes",
      );
    const pending = drainDiagnostic(
      bytes,
      (bytes) => write.call(stderr, [bytes]),
      () => active() && !this.suspended,
    );
    if (pending) {
      // Await only our cancellable drains during broker teardown, never an arbitrary adapter
      // promise. The supervisor explicitly retires custom sink ownership on disposal.
      this.startupDiagnostics.add(pending);
      void pending.finally(() => this.startupDiagnostics.delete(pending)).catch(() => {});
    }
    return pending;
  }
  private collectRuntimeProcess(pid: number, directory?: string): void {
    for (const [rootPid, transport] of this.roots) {
      if (directory !== undefined && workerProcessDirectoryId(transport) !== directory) continue;
      const root = this.options.table.get(pid)?.rootPid;
      if (root !== undefined && root !== rootPid) continue;
      this.registries.get(rootPid)?.collectProcess(pid);
    }
  }
  private quiesceProcess(pid: number): void | Promise<void> {
    const pending = this.fences.get(pid);
    if (pending) return pending;
    const controller = this.controllers.get(pid);
    // The supervisor drops settled fence promises before physical stop is scheduled.
    // Retain completion only while this process still owns its controller.
    if (controller && this.quiescedControllers.has(pid)) return;
    const complete = () => {
      this.collectRuntimeProcess(pid);
      if (controller) this.quiescedControllers.add(pid);
    };
    let fence: void | Promise<void>;
    try {
      fence = this.processFence(pid);
    } catch (error) {
      fence = Promise.reject(error);
    }
    if (fence) {
      const pending = Promise.resolve(fence).then(complete);
      this.fences.set(pid, pending);
      return pending;
    }
    complete();
  }
  private revokeController(pid: number): void {
    const controller = this.controllers.get(pid);
    if (!controller || this.revokedControllers?.has(pid)) return;
    (this.revokedControllers ??= new Set()).add(pid);
    if (controller.filesystem) this.options.filesystem.revoke(controller.filesystem);
    controller.revoke?.();
  }
  private processFence(pid: number): void | Promise<void> {
    // Lazy/external roots may have no supervisor record to invoke their revocation hook.
    this.revokeController(pid);
    const controller = this.controllers.get(pid);
    const pending: Promise<void>[] = [];
    const adapter = controller?.quiesce?.();
    if (adapter) pending.push(adapter);
    if (controller?.filesystem && !controller.acknowledged?.())
      pending.push(this.options.filesystem.quiesce(controller.filesystem));
    const child = this.children.get(pid);
    if (child) {
      const filesystem = this.quiesceChild(child);
      if (filesystem) pending.push(filesystem);
    } else {
      const transport = this.transport.get(pid);
      if (transport) {
        const filesystem = this.filesystem(transport);
        // An adapter acknowledgement covers only its own identity, not another transport.
        if (!controller?.filesystem || filesystem.sections !== controller.filesystem.sections) {
          pending.push(this.options.filesystem.quiesce(filesystem));
        }
      }
    }
    if (pending.length) return Promise.all(pending).then(() => {});
  }
  private quiesceChild(child: RuntimeChild): void | Promise<void> {
    if (child.acknowledged) return;
    return (child.quiescence ??= this.options.filesystem.quiesce(child.filesystem));
  }
  private disposeNotifications(child: RuntimeChild | undefined): void {
    void child?.notifications?.dispose().catch((error) => this.report(error));
  }
  private stop(child: RuntimeChild): void | Promise<void> {
    if (child.stopping) return child.stopping;
    if (child.stopped) return;
    const stop = async () => {
      if (child.stopped) return;
      child.stopped = true;
      const errors: unknown[] = [];
      const notifications = child.notifications;
      if (notifications) await settleStop(() => notifications.dispose(), errors);
      await settleStop(() => child.worker?.terminate(), errors);
      await settleStop(() => child.cleanup?.(), errors);
      this.children.delete(child.context.pid);
      this.retireChildController(child.context.pid);
      if (errors.length) throw new AggregateError(errors, "Child physical stop failed");
    };
    const fence = this.quiesceProcess(child.context.pid);
    return (child.stopping = fence ? fence.then(stop) : stop());
  }
  private retireChildController(pid: number): void {
    // Generic child controllers have no external root ancestry to retain. During disposal,
    // keep them until every controller's physical stop and retirement have been attempted.
    if (this.suspended || this.reservedRoots.has(pid)) return;
    const controller = this.controllers.get(pid);
    this.controllers.delete(pid);
    this.quiescedControllers.delete(pid);
    this.revokedControllers?.delete(pid);
    this.fences.delete(pid);
    this.releaseAcquiredProcess(pid);
    try {
      controller?.retired?.();
    } catch (error) {
      this.report(error);
    }
  }
  private stopController(pid: number): Promise<void> | undefined {
    if (this.suspended || this.reservedRoots.has(pid)) return;
    const pending = this.controllerStops?.get(pid);
    if (pending) return pending.pending;
    const controller = this.controllers.get(pid);
    if (!controller) return;
    const stopping = Promise.resolve(this.quiesceProcess(pid))
      .then(() => controller.stop?.())
      .then(() => {
        this.controllerStops?.delete(pid);
        this.retireChildController(pid);
      });
    (this.controllerStops ??= new Map()).set(pid, { pending: stopping, controllerStop: true });
    return stopping;
  }
  private async retireProcess(pid: number): Promise<void> {
    await this.pendingLaunches?.get(pid)?.acquired;
    if (this.suspended) {
      await this.retirementGate.promise;
      return;
    }
    const child = this.children.get(pid);
    if (child) await this.stop(child);
    else await this.stopController(pid);
  }
  private stopSafely(child: RuntimeChild): void {
    try {
      const pending = this.stop(child);
      if (pending) void pending.catch((error) => this.report(error));
    } catch (error) {
      this.report(error);
    }
  }
  private states() {
    return Array.from(this.roots.values()).flatMap((root) =>
      Array.from(directoryProcesses(root.directory)),
    );
  }
  async kill(pid: number, signal: number): Promise<void> {
    const sig = checkedSignal(signal),
      state = this.states().find((state) => state.pid === pid);
    const target = state?.signals ?? this.options.table.get(pid) ?? this.reservedRoots.get(pid);
    if (target) {
      requestSignal(target, sig);
      if (readOutcome(target.outcome)?.kind === "signaled") this.revokeRuntimeProcess(pid);
      this.wake();
    }
    const supervisor = await this.ready();
    if (this.suspended) return;
    if (supervisor.get(pid)) supervisor.observeSignal(pid, sig);
    else if (!state && !target) supervisor.kill(pid, sig);
  }
  private requestSignalIfPresent(target: SignalTransport, signal: number): void {
    try {
      requestSignal(target, signal);
    } catch (error) {
      // Captured members can be collected after enumeration. Their vanished authority
      // must not prevent signalling/fencing the remaining consumers of a job or runtime.
      if (!isCollectedProcess(error)) throw error;
    }
  }
  async killJob(
    job: number,
    signal: number,
    reserved: readonly { pid: number; signals: SignalTransport }[] = [],
  ): Promise<void> {
    const sig = checkedSignal(signal),
      states = this.states().filter((state) => state.job === job);
    const seen = new Set(states.map((state) => state.pid));
    const records = Array.from(this.options.table.values()).filter(
      (record) => record.job === job && !seen.has(record.pid),
    );
    // Generic reservations and admitted legacy processes select all terminal winners before
    // any callback can revoke capabilities. Observation never publishes the signal twice.
    for (const state of states) this.requestSignalIfPresent(state.signals, sig);
    for (const record of records) this.requestSignalIfPresent(record, sig);
    const published = new Set(
      states.map((state) => state.pid).concat(records.map((record) => record.pid)),
    );
    const roots = Array.from(this.reservedRoots.values()).filter(
      (root) => root.job === job && !published.has(root.pid),
    );
    const reservations = roots
      .map<{ pid: number; signals: SignalTransport }>((root) => ({ pid: root.pid, signals: root }))
      .concat(reserved);
    for (const target of reservations)
      if (!published.has(target.pid)) {
        this.requestSignalIfPresent(target.signals, sig);
        published.add(target.pid);
      }
    // Directory reservations can own pipe endpoints before a spawn message reaches the
    // supervisor. Freeze those rows too, after every member has selected its outcome.
    for (const state of states) {
      try {
        if (readOutcome(state.signals.outcome)?.kind === "signaled")
          this.revokeRuntimeProcess(state.pid);
      } catch (error) {
        if (!isCollectedProcess(error)) throw error;
      }
    }
    this.wake();
    const supervisor = await this.ready();
    if (this.suspended) return;
    for (const pid of published) if (supervisor.get(pid)) supervisor.observeSignal(pid, sig);
  }
  private wake(): void {
    for (const root of this.roots.values()) wakeWorkerProcess(root);
    for (const controller of this.controllers.values()) controller.wake?.();
    for (const child of this.children.values()) child.wake?.();
  }
  async rootExit(pid: number, code: number): Promise<void> {
    this.revokeRuntimeProcess(pid);
    if (!this.activation) {
      const root = this.reservedRoots.get(pid);
      if (root) claimOutcome(root.outcome, { kind: "exited", code });
      await this.quiesceProcess(pid);
      const transport = this.roots.get(pid);
      if (transport) {
        controlStore(workerProcessState(transport).confirmed, 0, 1);
        confirmWorkerProcessJob(transport);
      }
      if (root) this.completedRoots.add(pid);
      this.retireRoots();
      return;
    }
    let supervisor: ProcessSupervisor | undefined;
    try {
      supervisor = await this.activation;
    } catch (error) {
      this.report(error);
      supervisor = this.supervisor;
    }
    if (supervisor?.get(pid)) {
      supervisor.exit(pid, code);
      await supervisor.waitForExit(0, pid);
    } else await this.quiesceProcess(pid);
    const transport = this.roots.get(pid);
    if (transport) {
      controlStore(workerProcessState(transport).confirmed, 0, 1);
      confirmWorkerProcessJob(transport);
    }
    if (this.reservedRoots.has(pid)) this.completedRoots.add(pid);
    this.retireRoots();
  }
  private watch(): void {
    if (this.timer !== null || this.suspended) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.transport.pump();
      } catch (error) {
        this.report(error);
      }
      if (this.children.size) this.watch();
    }, 4);
  }
  suspend(): void {
    if (this.suspended) return;
    this.suspended = true;
    this.workers.dispose();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    // Publish every outcome before running user revocation callbacks.
    for (const state of this.states()) this.requestSignalIfPresent(state.signals, 9);
    for (const root of this.reservedRoots.values()) this.requestSignalIfPresent(root, 9);
    for (const record of this.options.table.values()) this.requestSignalIfPresent(record, 9);
    for (const state of this.states()) {
      this.revokeRuntimeProcess(state.pid);
      const transport = this.transport.get(state.pid);
      if (transport) this.options.filesystem.revoke(this.filesystem(transport));
    }
    for (const pid of this.controllers.keys()) {
      try {
        this.revokeController(pid);
      } catch (error) {
        this.report(error);
      }
    }
    // Retain every fence before transport disposal drops reservations and supervisor disposal
    // removes table records. Neither logical death nor terminate() proves admission quiescence.
    const pids = new Set(
      Array.from(this.options.table.values(), (record) => record.pid).concat(
        Array.from(this.controllers.keys()),
        this.states().map((state) => state.pid),
      ),
    );
    for (const pid of pids)
      try {
        const pending = this.quiesceProcess(pid);
        if (pending) void pending.catch((error) => this.report(error));
      } catch (error) {
        this.fences.set(pid, Promise.reject(error));
      }
    this.transport.dispose();
    this.supervisor?.dispose();
  }
  async quiesce(): Promise<void> {
    await this.transport.settled();
    await Promise.all(this.rejectedTransfers.values());
    const pids = new Set(
      Array.from(this.options.table.values(), (record) => record.pid).concat(
        Array.from(this.controllers.keys()),
        Array.from(this.children.keys()),
      ),
    );
    for (const pid of pids) this.quiesceProcess(pid);
    await Promise.all(this.fences.values());
  }
  dispose(): Promise<void> {
    if (this.disposing) return this.disposing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    const disposal = (this.disposing = new Promise<void>((accept, fail) => {
      resolve = accept;
      reject = fail;
    }));
    // Revocation callbacks may synchronously dispose their owner again.
    try {
      this.suspend();
    } catch (error) {
      reject(error);
      return disposal;
    }
    void (async () => {
      if (this.activation) {
        try {
          await this.activation;
        } catch (error) {
          this.report(error);
        }
        this.supervisor?.dispose();
      }
      await Promise.allSettled(this.startupDiagnostics);
      await this.quiesce();
      // A controller stop may release a physical handle, but cannot consume authority
      // before a pending launcher acquires it. Then settle both stops before retirement.
      await Promise.all(
        Array.from(this.pendingLaunches?.values() ?? [], (launch) => launch.acquired),
      );
      const physicalHandles = this.supervisor?.retireFencedProcesses();
      // Suspension freezes every owned pipe cursor; the filesystem fence above is still
      // mandatory. Attempt and settle every physical stop even if another consumer fails.
      const stops = Array.from(this.children.values(), (child) =>
        Promise.resolve().then(() => this.stop(child)),
      ).concat(
        Array.from(this.controllers, ([pid, controller]) => {
          const stopping = this.controllerStops?.get(pid);
          return stopping?.controllerStop
            ? stopping.pending
            : Promise.resolve().then(() => controller.stop?.());
        }),
        Array.from(this.controllerStops?.values() ?? [], (stopping) => stopping.pending),
        Array.from(this.pendingLaunches?.values() ?? [], (launch) => launch.settled),
      );
      if (physicalHandles) stops.push(physicalHandles);
      const errors: unknown[] = [];
      for (const result of await Promise.allSettled(stops))
        if (result.status === "rejected") errors.push(result.reason);
      try {
        this.pipes.dispose();
      } catch (error) {
        errors.push(error);
      }
      for (const controller of this.controllers.values()) {
        try {
          controller.retired?.();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        const failure = new AggregateError(errors, "Process broker cleanup failed");
        this.retirementGate.reject(failure);
        throw failure;
      }
      this.retirementGate.resolve();
      this.reservedRoots.clear();
      this.completedRoots.clear();
      this.rootLeases.clear();
      this.roots.clear();
      this.outputs.clear();
      this.registries.clear();
      this.controllers.clear();
      this.quiescedControllers.clear();
      this.revokedControllers?.clear();
      this.controllerStops?.clear();
      this.launches?.clear();
      this.pendingLaunches?.clear();
      this.fences.clear();
      this.acquiredProcesses.clear();
      this.stopTrackingConsumers();
      if (errors.length) throw new AggregateError(errors, "Process broker cleanup failed");
    })().then(resolve, reject);
    return disposal;
  }
  private report(error: unknown): void {
    try {
      if (this.options.onError) this.options.onError(error);
      else console.error("runtime: process controller failed", error);
    } catch {
      /* Diagnostics must not interrupt consumer fencing or cleanup. */
    }
  }
}

async function settleStop(stop: () => void | Promise<void>, errors: unknown[]): Promise<void> {
  try {
    await stop();
  } catch (error) {
    errors.push(error);
  }
}
