import {
  commandExecTransfer,
  commandTransferFailed,
  initializeCommandExec,
  readCommandTransferFailure,
} from "../proc/command-transfer.js";
import { WorkerStartError } from "../proc/start-diagnostic.ts";
import { requireGroupPlan } from "../link/issuance.js";
import type { SharedLinkPlan } from "../link/image.js";
import {
  admitProcessObservation,
  captureNativeReturn,
  type ProcessObservationTransfer,
} from "../proc/observation.js";
import {
  bindGraphicsLaunch,
  graphicsLaunchRetention,
  retainAllocationReceipts,
} from "./display/launch-retention.js";
import type { GraphicsGrant } from "./display/protocol.js";
import { allocateSharedControl, type SharedControlGrant } from "../memory/control.js";
import {
  bytes,
  type Headroom,
  type RuntimeReservations,
  type Ticket,
  type LaunchedTicket,
  type ProcessGuestPlan,
  type ProcessPlan,
} from "../memory/reservations.js";
import type { ThreadAggregate, ThreadLaunchOptions } from "../thread/runtime-protocol.js";
import {
  threadModuleDeclaration,
  moduleMemoryDeclarations,
  type MemoryDeclaration,
} from "../memory/declarations.js";
import type { Preview1Network } from "./preview1-network-types.js";
import {
  prepareTerminalDescendant,
  terminalPreparationReceipt,
  type TerminalAuthority,
  type TerminalControlTurn,
  type TerminalControlReceipt,
  type TerminalResult,
  type TerminalFailure,
} from "./terminal-session.js";
import {
  atomicsWaitAsync,
  atomicsLoad,
  BigInt64ArrayConstructor,
  reflectApply,
  observeRejectedPromise,
  isInstance,
  PromiseConstructor,
} from "../proc/intrinsics.js";
import { ReadyWorkerPool } from "./worker-pool.js";
import {
  markStart,
  observeStart,
  processStartRecord,
  startMessage,
  startSnapshot,
  type ProcessStartRecord,
  type ProcessStartState,
} from "./process-start.js";
import { createNotificationBridge, type NotificationBridge } from "./notification-relay.js";
import { snapshotHostIdentity, type RuntimeHostIdentity } from "./process-context.js";
import { drainDiagnostic } from "./diagnostic.js";
import {
  MemoryGroups,
  type MemberLease,
  type MemoryGroupHandle,
  type MemoryGroupPolicyOptions,
  type MemoryGroupSnapshot,
} from "../group/state.js";
import type { MemoryGroupMemberRequest } from "../group/protocol.js";
import { WorkerExecutableAccess, rejectWorkerAccess } from "../proc/worker-access.js";
import {
  directoryGroups,
  directoryCapacity,
  collectDirectoryJob,
  idleDirectoryAdmission,
  directoryProcesses,
  directoryAdmissionVersion,
  commitDirectoryAdmission,
  isCollectedProcess,
  wakeDirectory,
} from "../proc/directory.js";
import {
  type ControlCells,
  TaggedCells,
  controlLoad,
  controlStore,
  controlCas,
} from "../proc/control.js";
import { type FilesystemConnection, type FilesystemIdentity, isRevoked } from "../fs/protocol.js";

import type { ProcessSupervisor, RootProcessOptions } from "../proc/supervisor.js";
import type { ExecutableRegistry, ResolvedExecutable } from "../proc/registry.js";
import type { ProcessIdentityAllocator } from "../proc/identity.js";
import type { ProcessRecord, ProcessTable } from "../proc/table.js";
import {
  type ChildExitEvent,
  type ProcessContext,
  type ProcessExit,
  type CommandProcessContext,
  type ProcessHandle,
  checkedSignal,
  checkedProcessCwd,
  snapshotLogicalProcessIdentity,
  type LogicalProcessIdentity,
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
  captureTerminalLifetime,
  type TerminalProcessLifetime,
} from "../proc/terminal-lifetime.js";
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
import { WorkerPipeBroker, WorkerPipeHost } from "../proc/worker-pipes.js";
import {
  attachPipePublicationRegistry,
  PipeEndpoint,
  PipePublicationRegistry,
} from "../proc/pipes.js";
import { createRuntimeTerminalCodec } from "./runtime-terminals.js";
import {
  createTerminalOutput,
  deliveredTerminalOutput,
  TerminalOutputBudget,
  type TerminalOutputDelivery,
  type TerminalOutputReader,
} from "./terminal-output.js";
import type { RuntimeWorkerRequest, RuntimeWorkerMessage } from "./worker.js";
import type { RuntimeNetworkPathScope } from "./net/runtime.js";
import type { SignalDelegation } from "../programs/index.js";
import { packageIdentity } from "../programs/catalog.js";
import {
  CommandStdioError,
  type ProcessQuery,
  type CommandProcessRow,
  type DelegatedSignals,
} from "../proc/command.js";
import type { CommandCapabilities } from "../proc/command-runner.js";
import type { FileHandle } from "../core/filesystem.js";

export interface ProcessFilesystem {
  fork?(): FilesystemConnection;
  connect(identity: FilesystemIdentity, headroom?: Headroom | null): FilesystemConnection;
  revoke(identity: FilesystemIdentity): void;
  reap(identity: FilesystemIdentity): void;
  quiesce(identity: FilesystemIdentity): Promise<void>;
  sweep?(): void;
}
export interface ProcessController {
  readonly signalDelegation?: SignalDelegation;
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
  readonly reservations: RuntimeReservations;
  hostIdentity?: RuntimeHostIdentity | null;
  filesystem: ProcessFilesystem;
  /** Injectable lazy supervisor module loader; pipe-only roots never invoke it. */
  activate?: () => Promise<typeof import("../proc/index.js")>;
  identities: ProcessIdentityAllocator;
  registry: ExecutableRegistry;
  table: ProcessTable;
  launch(context: ProcessContext): ProcessHandle | Promise<ProcessHandle>;
  launchCommand?(
    context: CommandProcessContext,
    capabilities: CommandCapabilities,
  ): ProcessHandle | Promise<ProcessHandle>;
  onError?(error: unknown): void;
  /** Opt-in metadata only; observers must not reenter process control. Exceptions are ignored. */
  onProcessAdmission?: ProcessAdmissionObserver;
  /** Memory group policy (W1-W3). Groups are created only by a launch that asks for one. */
  memoryGroups?: MemoryGroupPolicyOptions;
}
/** "new" leads a fresh group; "inherit" joins the parent's group; a handle joins that group. */
export type MemoryGroupLaunch = "new" | "inherit" | MemoryGroupHandle;
/** An external root's group membership. Settle it only after the root's agent physically stopped. */
export interface RootMemoryGroupMember {
  readonly group: MemoryGroupHandle;
  /** Broker-owned request field for the root worker; transfer `transfer` with it. */
  readonly request: MemoryGroupMemberRequest;
  readonly transfer: readonly Transferable[];
  /** Call in finally after this root's native terminate attempt, before awaiting its end. */
  terminating(): void;
  /** The embedder proved its root worker physically stopped. Idempotent. */
  stopped(): void;
}
/** A reserved, admitted descendant of a runtime root whose adapter has not launched. */
export interface RuntimeDescendant {
  readonly pid: number;
  readonly parentPid: number;
  readonly job: number;
  /** A frozen structured clone of the spawn's metadata without the runtime-owned `filesystem`
   * and `pipeRegistry` fields. Inherited fields are the parent's claims, not membership. */
  readonly data: Readonly<Record<string, unknown>>;
}
export type RootPreparationCompletion =
  | { readonly kind: "rolled-back"; readonly receipt: TerminalControlReceipt }
  | {
      readonly kind: "committed";
      readonly entry: "not-entered" | "adapter-invoked";
      readonly receipt: TerminalControlReceipt;
    };
export interface RootDescendantPreparation {
  readonly terminal: TerminalAuthority;
  /** Synchronous, once under a granted root turn; publish local maps with turn.publish. */
  run(descendant: RuntimeDescendant, turn: TerminalControlTurn): TerminalResult<void>;
  /** Once before onChildExit/retirement can run. Committed means exit cleanup owns membership. */
  settled?(descendant: RuntimeDescendant, completion: RootPreparationCompletion): undefined;
}
export interface RuntimeRootOptions {
  readonly memory: readonly MemoryDeclaration[] | "group";
  readonly signalDelegation?: SignalDelegation;
  filesystem?: FilesystemIdentity;
  acknowledged?(): boolean;
  /** Takes every terminal byte of this root's processes, in order. Exclusive with tryOutput. */
  output?(fd: 1 | 2, data: Uint8Array): void;
  /**
   * Bounded terminal destination. Return the exact accepted prefix length, 0 to data.length.
   * The rest stays in its writer's bounded buffer and that writer waits, like a full TTY.
   * Call ProcessService.outputDrained(rootPid) when room returns. Exclusive with output.
   */
  tryOutput?(fd: 1 | 2, data: Uint8Array): number;
  quiesce?(): void | Promise<void>;
  stop?(): void | Promise<void>;
  wake?(): void;
  retired?(): void;
  /** The kernel waits for this exact root authority before invoking run once, then enters
   * the adapter in the same continuation. Promises from run are invalid. */
  prepareDescendant?: RootDescendantPreparation;
}
export interface WorkerLaunchOptions<T extends RuntimeWorkerRequest = RuntimeWorkerRequest> {
  /** Module entry stays inert until its first request. A fresh worker is created on demand. */
  workerUrl: string;
  notificationWorkerUrl?: string;
  /** Explicit internal proof profile. Source admission is still mandatory. */
  threaded?: ThreadLaunchOptions;
  /** Ownership moves to the broker, including all failed launch and termination paths. */
  network?: Preview1Network;
  graphics?: GraphicsGrant;
  request: Omit<
    T,
    | "filesystem"
    | "runtimeProcess"
    | "startupStderr"
    | "hostIdentity"
    | "notifications"
    | "memoryObservation"
    | "observation"
    | "terminalOutput"
    | "memoryGroup"
    | "controlGrant"
    | "network"
    | "graphics"
  >;
  /** Join a memory group. Admission is reserved before the Worker is constructed. */
  memoryGroup?: MemoryGroupLaunch;
  /** Trusted adapter-created memories in addition to the module declarations. */
  memories?: readonly MemoryDeclaration[];
  cleanup?(): void;
  onMessage?(message: unknown, context: ProcessContext): void;
  wake?(): void;
  executableName?(name: string): string;
}
interface DescendantHook {
  readonly prepare: NonNullable<RuntimeRootOptions["prepareDescendant"]>;
  readonly directory: string;
}
interface PendingPreparation {
  readonly pid: number;
  readonly rootPid: number;
  readonly observation: ProcessObservationTransfer;
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  phase: "preparing" | "handed-off" | "settling" | "settled";
  receipt: TerminalControlReceipt;
  entry: "not-entered" | "adapter-invoked";
  finish(): void;
}
const reservedDescendantData = ["filesystem", "pipeRegistry"];
/** Latest sampled linear-memory bytes, retained until successful physical cleanup. */
export interface WorkerMemoryObservation {
  readonly pid: number;
  readonly parentPid: number;
  readonly rootPid: number;
  readonly job: number;
  readonly directory: string;
  /** null until actual memory becomes visible; may be stale between host boundaries. */
  readonly bytes: number | null;
}
interface PendingLaunch {
  readonly observation: ProcessObservationTransfer;
  readonly start: ProcessStartRecord;
  acquiring: boolean;
  readonly acquired: Promise<void>;
  readonly settled: Promise<void>;
}
interface RuntimeLaunch {
  active: boolean;
  pending?: PendingLaunch;
}
interface RuntimeChild {
  readonly generation: number;
  readonly transport: WorkerProcessTransport;
  readonly launch: RuntimeLaunch;
  /** Shared with the pending launch that created this child. */
  readonly start: ProcessStartRecord;
  accesses?: WorkerExecutableAccess;
  controllerStopping?: { pending: Promise<void>; controllerStop: boolean };
  controller?: ProcessController;
  controllerQuiet?: boolean;
  capturedControllerStop?: () => void | Promise<void>;
  controllerNativeReturn?: NativeReturnFollowers;
  controllerNativeStop?: NativeStopHandle;
  fence?: Promise<void>;
  finalFence?: Promise<void>;
  finalQuiet?: boolean;
  revokeController?: () => void;
  nativeReturned?: () => void;
  threads?: Promise<ThreadAggregate | undefined>;
  memory: BigInt64Array;
  identity: Omit<WorkerMemoryObservation, "bytes">;
  notifications?: NotificationBridge;
  filesystem: FilesystemIdentity;
  context: ProcessContext;
  worker?: Worker;
  acknowledged: boolean;
  /** The worker reported that its guest finished (exit, error or a worker error). */
  guestEnded?: boolean;
  /** Resolves a stop waiting for guestEnded (see terminateWorker). */
  endGuest?: () => void;
  replacementAcknowledged?: boolean;
  failed: boolean;
  stopped: boolean;
  quiescence?: Promise<void>;
  stopping?: Promise<void>;
  /** Borrowed Worker stop excludes adapter-owned work and member/process retirement. */
  nativeStopping?: Promise<void>;
  /** Exact accepted entry handle, captured before acquisition is published. */
  adapter?: ProcessHandle;
  replacing?: boolean;
  startupStderr?: PipeEndpoint;
  network?: Preview1Network;
  graphics?: GraphicsGrant;
  cleanup?(): void;
  wake?(): void;
  output?: TerminalOutputReader;
  group?: MemberLease;
  ticket?: Ticket;
  launched?: LaunchedTicket;
}

/** Page-owned process admission and descriptor transport. Guest adapter policy is injected. */
const originalGraphicsGrants = new WeakMap<GraphicsGrant, GraphicsGrant>();

/**
 * How long a stop waits for a signalled guest to unwind before terminate(). A guest polling
 * runtime_proc.signal(0, 4) takes about a millisecond; this only caps one that never polls.
 */
const STOP_UNWIND_MS = 1000;

/** Messages a worker posts last, once its guest can no longer run (browser/worker.ts finish). */
function guestFinished(type: RuntimeWorkerMessage["type"] | undefined): boolean {
  return (
    type === "exit" || type === "error" || type === "cleanup-error" || type === "observation-error"
  );
}

function guestEnded(child: RuntimeChild): void {
  child.guestEnded = true;
  child.endGuest?.();
}

/** True once executable entry committed: guest code may be running on this worker. */
function guestEntered(child: RuntimeChild): boolean {
  try {
    return startStatus(child.context.outcome) === 0;
  } catch {
    return false;
  }
}

/**
 * Waits until the worker reports that its guest finished, or STOP_UNWIND_MS. No wait when no
 * guest code can be running: it never entered, already finished, or is parked in a group
 * futex wait, which SIGKILL does not wake. closeParked() closes that wait record first, so a
 * timed or sibling wake before terminate() throws instead of resuming guest code.
 */
function guestUnwound(child: RuntimeChild): Promise<void> | undefined {
  if (child.guestEnded || !guestEntered(child)) return;
  if (child.group?.closeParked()) return;
  const unwound = Promise.withResolvers<void>();
  const cap = setTimeout(unwound.resolve, STOP_UNWIND_MS);
  child.endGuest = unwound.resolve;
  return unwound.promise.finally(() => {
    clearTimeout(cap);
    child.endGuest = undefined;
  });
}

function senderRevoked(
  result: ReturnType<typeof readOutcome>,
  filesystemRevoked: boolean,
): boolean {
  return result?.kind === "signaled" || (!result && filesystemRevoked);
}

interface CommandRootState {
  readonly root: WorkerProcessTransport;
  readonly pending: Set<Promise<void>>;
  readonly failures: Map<WorkerProcessTransport, unknown>;
  stopped: boolean;
}

export class BrowserProcessBroker {
  private readonly hostIdentity: RuntimeHostIdentity | null;
  private suspended = false;
  private readonly pendingPreparations = new Set<PendingPreparation>();
  private readonly retirementGate = Promise.withResolvers<void>();
  private disposing?: Promise<void>;
  private activation?: Promise<ProcessSupervisor>;
  private supervisor?: ProcessSupervisor;
  private readonly pipes: WorkerPipeBroker;
  private readonly workers = new ReadyWorkerPool();
  private readonly roots = new Map<number, WorkerProcessTransport>();
  private readonly reservedRoots = new Map<
    number,
    RootProcessOptions &
      SignalTransport & {
        pid: number;
        job: number;
        observation: ProcessObservationTransfer;
        processIdentity: LogicalProcessIdentity;
      }
  >();
  private readonly completedRoots = new Set<number>();
  private commandRoots?: Map<number, CommandRootState>;
  private readonly rootLeases = new Map<number, number>();
  private readonly controllers = new Map<number, ProcessController>();
  private readonly signalPolicies = new Map<
    number,
    { controller: ProcessController; packages: ReadonlySet<object> }
  >();
  private revokedControllers = new Set<number>();
  private quiescedControllers = new Set<number>();
  private controllerStops?: Map<number, { pending: Promise<void>; controllerStop: boolean }>;
  private launches?: Set<number>;
  private pendingLaunches?: Map<number, PendingLaunch>;
  private readonly settledGroupAcquisitions = new Set<string>();
  private readonly groupAdmissionWatches = new Map<SharedArrayBuffer, Int32Array>();
  private readonly descendantHooks = new Map<number, DescendantHook>();
  private readonly outputs = new Map<number, TerminalOutputDelivery | undefined>();
  /** Each root's terminal output: live writers and stopped writers' accepted bytes. */
  private readonly terminalOutputs = new Map<number, TerminalOutputBudget>();
  private readonly registries = new Map<number, PipePublicationRegistry>();
  private readonly children = new Map<number, RuntimeChild>();
  private readonly launchStates = new WeakMap<object, RuntimeLaunch>();
  private readonly fences = new Map<number, Promise<void>>();
  private readonly startupDiagnostics = new Set<Promise<void>>();
  private readonly rejectedTransfers = new Map<string, Promise<void>>();
  private cleanupCodec?: WorkerDescriptorCodec;
  private readonly acquiredProcesses = new Map<number, string>();
  private readonly retainedRootStops = new Map<number, ProcessController>();
  private readonly capturedControllerRevocations = new Map<number, () => void>();
  private readonly capturedControllerStops = new Map<number, () => void | Promise<void>>();
  private readonly controllerNativeReturns = new Map<number, NativeReturnFollowers>();
  private readonly controllerNativeStops = new Map<number, NativeStopHandle>();
  private readonly observationOwners = new Map<number, NativeObservationOwner>();
  private readonly neverConstructed = new WeakMap<object, number>();
  private readonly nativeLaunchReturns = new Map<number, () => void>();
  private readonly imageStops = new Map<number, Promise<void>>();
  private readonly replacementDiagnostics = new WeakSet<object>();
  private readonly terminalLifetimes = new Map<number, TerminalProcessLifetime>();
  private groups?: MemoryGroups;
  private rootGroups?: Map<number, MemberLease>;
  private readonly rootAdmissions = new Map<number, Ticket>();
  private readonly rootTickets = new Map<number, LaunchedTicket>();
  private readonly rootGrants = new Map<number, SharedControlGrant>();
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
    this.pipes = new WorkerPipeBroker({
      allocateShared: (length) =>
        options.reservations.buffer("control", { kind: "fixed-buffer", length: bytes(length) }),
    });
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
      nativeReturn: (transport) => this.processNativeReturn(transport),
      onAdmitted: (transport) => this.acquireProcess(transport),
      quiesce: (_pid, transport) => this.quiesceUnstarted(transport),
      beforeAdmit: (transport) => this.checkCommandAdmission(transport),
      transferCleanup: (transport, cleanup) => this.trackCommandTransfer(transport, cleanup),
      retireRejected: (transport) => this.retireRejectedCommand(transport),
      canExec: (transport) => this.canExec(transport),
      discardExec: (transport) => {
        const filesystem = this.filesystem(transport);
        this.options.filesystem.revoke(filesystem);
        if (this.commandScope(transport)) return this.options.filesystem.quiesce(filesystem);
        this.options.filesystem.reap(filesystem);
      },
    });
    this.stopTrackingConsumers = options.table.onRemove((record) => {
      this.releaseAcquiredProcess(record.pid);
      this.settledGroupAcquisitions.delete(observationKey(record.observation));
      this.groups?.settleStopping();
    });
  }
  ready(): Promise<ProcessSupervisor> {
    return (this.activation ??= (this.options.activate?.() ?? import("../proc/index.js")).then(
      (proc) => {
        const supervisor = (this.supervisor = new proc.ProcessSupervisor({
          registry: this.options.registry,
          byteBackedGuestOnly: (rootPid) =>
            rootPid !== undefined && !!this.commandRoots?.has(rootPid),
          table: this.options.table,
          launch: (context) => this.launchPrepared(context),
          launchCommand: (context) => this.launchPrepared(context),
          canConfirmExit: (pid) => {
            const child = this.children.get(pid);
            return (
              this.suspended ||
              (child
                ? child.threads !== undefined || child.acknowledged || child.failed
                : (this.controllerFor(pid)?.canConfirmExit?.() ?? true))
            );
          },
          quiesce: (pid) => this.quiesceProcess(pid),
          retire: (pid) => this.retireProcess(pid),
          stopImage: (pid, generation, active) => this.stopImage(pid, generation, active),
          commitReplacement: (pid, generation, resolved) =>
            this.commitReplacement(pid, generation, resolved),
          replacementFailed: (pid, error) => this.reportReplacementFailure(pid, error),
          staleImage: (pid) => {
            const record = this.options.table.get(pid);
            if (record) this.traceProcess(record, "dropped", "stale-image");
          },
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
              this.controllerFor(event.pid)?.exited?.(event);
            } finally {
              // Notification failures cannot skip failed-start cleanup. Report them only
              // after the same fenced physical stop used by successful notifications.
              const child = this.children.get(event.pid);
              if (child) await this.stop(child);
              else {
                await this.pendingLaunches?.get(event.pid)?.settled;
                if (!this.launches?.has(event.pid)) await this.stopController(event.pid);
              }
              this.observationOwners.get(event.pid)?.close();
              this.retireRoots();
            }
          })().catch((error) => this.report(error));
        });
        supervisor.onProcessQuiescent((event) => {
          this.fences.delete(event.pid);
          this.releaseAcquiredProcess(event.pid);
          this.groups?.settleStopping();
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
  private async launchPrepared(
    context: ProcessContext | CommandProcessContext,
  ): Promise<ProcessHandle> {
    const descendant = this.descendant(context.pid);
    if (!descendant) return this.launchAdapter(context);
    return this.prepareDescendant(context, descendant.hook, descendant.transport);
  }
  /** Required preparation is captured before any asynchronous acquisition. */
  private descendant(pid: number) {
    const transport = this.transport.get(pid);
    if (!transport) return undefined;
    const { rootPid } = workerProcessState(transport);
    const hook = rootPid === pid ? undefined : this.descendantHooks.get(rootPid);
    if (!hook || hook.directory !== workerProcessDirectoryId(transport)) return undefined;
    return { hook, transport };
  }
  private preparationFailure(
    context: ProcessContext | CommandProcessContext,
    hook: DescendantHook,
    rootPid: number,
  ): TerminalFailure | undefined {
    if (this.suspended || this.descendantHooks.get(rootPid) !== hook) return "CANCELED";
    if (
      this.options.table.get(context.pid)?.image.generation !== context.generation ||
      readOutcome(context.outcome)
    )
      return "CANCELED";
    const root = this.roots.get(rootPid);
    if (!root || readOutcome(workerProcessState(root).signals.outcome)) return "PROCESS_GONE";
    return undefined;
  }
  private beginPreparation(
    context: ProcessContext | CommandProcessContext,
    rootPid: number,
    initial: TerminalControlReceipt,
    hook: DescendantHook,
    descendant: RuntimeDescendant,
  ): PendingPreparation {
    const controller = new AbortController();
    const release = this.retainRoot(rootPid);
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const record: PendingPreparation = {
      pid: context.pid,
      rootPid,
      observation: context.observation,
      controller,
      settled,
      phase: "preparing",
      receipt: initial,
      entry: "not-entered",
      finish: () => {
        if (record.phase === "settled" || record.phase === "settling") return;
        record.phase = "settling";
        const completion: RootPreparationCompletion =
          record.receipt.phase === "committed"
            ? { kind: "committed", entry: record.entry, receipt: record.receipt }
            : { kind: "rolled-back", receipt: record.receipt };
        try {
          const notification: unknown = hook.prepare.settled?.(descendant, completion);
          if (notification !== undefined) {
            if (isInstance(notification, PromiseConstructor)) observeRejectedPromise(notification);
            throw new TypeError("preparation settlement must return undefined synchronously");
          }
        } catch (error) {
          this.report(error);
        } finally {
          this.pendingPreparations.delete(record);
          record.phase = "settled";
          settle();
          release();
          this.groups?.settleStopping();
        }
      },
    };
    this.pendingPreparations.add(record);
    context.registerRevocation(() => {
      if (record.phase === "preparing") controller.abort();
    });
    return record;
  }
  private async watchPreparation(
    context: ProcessContext | CommandProcessContext,
    hook: DescendantHook,
    transport: WorkerProcessTransport,
    record: PendingPreparation,
  ): Promise<void> {
    const wake = new Int32Array(transport.directory, 4, 1);
    while (this.pendingPreparations.has(record) && record.phase === "preparing") {
      const seen = Atomics.load(wake, 0);
      if (this.preparationFailure(context, hook, record.rootPid)) {
        record.controller.abort();
        return;
      }
      const waiting = atomicsWaitAsync(wake, 0, seen);
      if (waiting.async) await waiting.value;
    }
  }
  private async prepareDescendant(
    context: ProcessContext | CommandProcessContext,
    hook: DescendantHook,
    transport: WorkerProcessTransport,
  ): Promise<ProcessHandle> {
    const state = workerProcessState(transport);
    const root = this.roots.get(state.rootPid);
    if (!root) throw new ProcessError(ProcessErrno.CANCELED, "preparation root is gone");
    const claims = { ...(transport.data as Record<string, unknown>) };
    for (const key of reservedDescendantData) delete claims[key];
    const descendant = Object.freeze({
      pid: state.pid,
      parentPid: state.parentPid,
      job: state.job,
      data: Object.freeze(structuredClone(claims)),
    });
    const initial = terminalPreparationReceipt(hook.prepare.terminal, root);
    const record = this.beginPreparation(context, state.rootPid, initial, hook, descendant);
    void this.watchPreparation(context, hook, transport, record).catch((error) => {
      record.controller.abort();
      this.report(error);
    });
    try {
      const result = await prepareTerminalDescendant({
        terminal: hook.prepare.terminal,
        root,
        signal: record.controller.signal,
        check: () => this.preparationFailure(context, hook, state.rootPid),
        settled: (receipt) => {
          record.receipt = receipt;
        },
        work: (turn) => hook.prepare.run(descendant, turn),
        finish: (result, receipt) => {
          record.receipt = receipt;
          try {
            if (result.kind === "error") throw terminalPreparationError(result.code);
            const failure = this.preparationFailure(context, hook, state.rootPid);
            if (failure) throw terminalPreparationError(failure);
            record.phase = "handed-off";
            record.entry = "adapter-invoked";
            wakeDirectory(transport.directory);
            return this.launchAdapter(context);
          } finally {
            record.finish();
            wakeDirectory(transport.directory);
          }
        },
      });
      if (result.kind === "error") throw terminalPreparationError(result.code);
      return result.value;
    } finally {
      record.finish();
      wakeDirectory(transport.directory);
    }
  }
  private cancelPreparations(pid?: number): void {
    for (const record of this.pendingPreparations)
      if (
        record.phase === "preparing" &&
        (pid === undefined || record.pid === pid || record.rootPid === pid)
      )
        record.controller.abort();
  }
  private launchAdapter(
    context: ProcessContext | CommandProcessContext,
  ): ProcessHandle | Promise<ProcessHandle> {
    if (this.suspended) throw new Error("Process broker is disposed");
    const transport = this.transport.get(context.pid);
    const command = transport && this.commandScope(transport);
    if (command) {
      this.traceProcess(context, "launching");
      this.checkCommandAdmission(transport);
    }
    this.acquireObservation(context.observation, true);
    const observation = this.observationOwners.get(context.pid);
    const nativeReturned = this.nativeLaunchReturns.get(context.pid) ?? observation?.acquire();
    let controllerReturn: NativeReturnFollowers | undefined;
    const failedLaunch = (error: unknown) => {
      const child = this.children.get(context.pid);
      if (child?.generation === context.generation) return;
      if (
        typeof error === "object" &&
        error !== null &&
        this.neverConstructed.get(error) === context.pid
      ) {
        if (context.generation === 1) nativeReturned?.();
      } else if (controllerReturn && nativeReturned) controllerReturn.follow(nativeReturned);
      else {
        this.imageStops.delete(context.pid);
        observation?.fail(error);
      }
    };
    const invokeLauncher = (): ProcessHandle | Promise<ProcessHandle> => {
      if ("command" in context) return this.launchCommand(context);
      if (command || context.execution?.kind === "host") return this.options.launch(context);
      const controller = this.controllerFor(context.pid);
      if (!controller?.launch) return this.options.launch(context);
      controllerReturn = this.controllerNativeReturnFor(context.pid);
      const candidate = controller.launch(context);
      if (candidate !== undefined && candidate !== null) return candidate;
      controllerReturn = undefined;
      return this.options.launch(context);
    };
    if (nativeReturned) this.nativeLaunchReturns.set(context.pid, nativeReturned);
    if (!command) this.traceProcess(context, "launching");
    const launch = this.launchState(context);
    launch.active = true;
    (this.launches ??= new Set()).add(context.pid);
    let acquireLaunch!: () => void, settleLaunch!: () => void;
    // A launcher may select an outcome synchronously before returning its handle.
    // Retain its cleanup authority before invoking any adapter code.
    const pendingLaunch = {
      observation: context.observation,
      start: processStartRecord(context),
      acquiring: true,
      acquired: new Promise<void>((resolve) => {
        acquireLaunch = resolve;
      }),
      settled: new Promise<void>((resolve) => {
        settleLaunch = resolve;
      }),
    };
    launch.pending = pendingLaunch;
    this.settledGroupAcquisitions.delete(observationKey(context.observation));
    (this.pendingLaunches ??= new Map()).set(context.pid, pendingLaunch);
    const settled = () => {
      pendingLaunch.acquiring = false;
      this.settledGroupAcquisitions.add(observationKey(context.observation));
      launch.pending = undefined;
      if (this.pendingLaunches?.get(context.pid) === pendingLaunch)
        this.pendingLaunches.delete(context.pid);
      this.releaseAcquiredProcess(context.pid);
      acquireLaunch();
      settleLaunch();
      this.groups?.settleStopping();
    };
    let launched: ProcessHandle | Promise<ProcessHandle>;
    try {
      launched = invokeLauncher();
    } catch (error) {
      failedLaunch(error);
      launch.active = false;
      this.launches.delete(context.pid);
      settled();
      throw error;
    }
    const track = (handle: ProcessHandle): ProcessHandle => {
      pendingLaunch.acquiring = false;
      this.settledGroupAcquisitions.add(observationKey(context.observation));
      // Worker acquisition already clears the previous image's stop. A late handle
      // must retain the stop started while its adapter acquisition was pending.
      this.traceProcess(context, "launched");
      const terminal = this.terminalLifetimes.get(context.pid);
      if (this.children.has(context.pid) || !this.controllerFor(context.pid)) {
        const child = this.children.get(context.pid);
        const adapter =
          child?.generation === context.generation
            ? (child.adapter = ownedAdapterHandle(handle))
            : undefined;
        launch.active = false;
        this.launches?.delete(context.pid);
        settled();
        return this.children.has(context.pid)
          ? (adapter ?? handle)
          : this.bindRootGroup(
              context.pid,
              nativeStopHandle(
                handle,
                terminal,
                nativeReturned,
                () => observation?.close(),
                (error) => observation?.fail(error),
              ),
            );
      }
      acquireLaunch();
      const ownedHandle = this.bindRootGroup(
        context.pid,
        nativeStopHandle(
          handle,
          terminal,
          nativeReturned,
          () => observation?.close(),
          (error) => observation?.fail(error),
        ),
      );
      this.groups?.settleStopping();
      // External launchers own their physical handle. Keep controller authority until
      // that handle's asynchronous cleanup settles, not merely its child-exit event.
      return {
        terminate: () => {
          let pending: void | Promise<void>;
          try {
            const stopped = ownedHandle.terminate();
            const stopController = this.controllerNativeStopFor(context.pid);
            const stopCapturedController = () => stopController?.terminate();
            pending = stopped ? stopped.then(stopCapturedController) : stopCapturedController();
          } catch (error) {
            settled();
            throw error;
          }
          if (pending) {
            const stopping = pending
              .then(() => {
                this.controllerStops?.delete(context.pid);
                launch.active = false;
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
          launch.active = false;
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
      failedLaunch(error);
      launch.active = false;
      this.launches?.delete(context.pid);
      settled();
      // A terminal outcome can win while this external launcher is still pending.
      if (readOutcome(context.outcome))
        void this.stopController(context.pid)?.catch((error) => this.report(error));
      throw error;
    });
  }
  private launchCommand(context: CommandProcessContext): ProcessHandle | Promise<ProcessHandle> {
    const launch = this.options.launchCommand;
    if (!launch) throw new ProcessError(45, "Host commands are unavailable");
    const record = this.options.table.require(context.pid);
    const rootPid = record.rootPid;
    if (rootPid === undefined) throw new ProcessError(ProcessErrno.SRCH, "Command root is missing");
    const root = this.options.table.require(rootPid);
    const processes: ProcessQuery = Object.freeze({
      snapshot: () => {
        if (
          this.suspended ||
          record.revoked ||
          root.revoked ||
          this.options.table.get(rootPid) !== root ||
          readOutcome(root.outcome) ||
          readOutcome(record.outcome) ||
          context.command.definition.admission?.aborted ||
          this.options.table.get(record.pid) !== record
        )
          throw new CommandStdioError("CANCELED");
        const rows: CommandProcessRow[] = [];
        for (const row of this.options.table.values()) {
          if (
            row.rootPid !== rootPid ||
            !row.image.request ||
            row.revoked ||
            row.state === "exited" ||
            readOutcome(row.outcome)
          )
            continue;
          rows.push({
            pid: row.pid,
            parentPid: row.parentPid,
            executable: row.image.request.executable,
            argv: row.image.request.argv.slice(),
            state: row.state,
          });
        }
        return rows.sort((left, right) => left.pid - right.pid);
      },
    });
    const transport = this.transport.get(context.pid);
    const identity = transport
      ? this.filesystem(transport)
      : this.controllerFor(context.pid)?.filesystem;
    if (identity) context.registerRevocation(() => this.options.filesystem.revoke(identity));
    const connectFilesystem = identity
      ? () => {
          if (this.suspended || record.revoked || readOutcome(record.outcome))
            throw new CommandStdioError("CANCELED");
          return this.options.filesystem.connect(identity);
        }
      : undefined;
    return launch(context, {
      processes,
      signals: this.commandSignals(context, record, rootPid),
      connectFilesystem,
    });
  }

  private commandSignals(
    context: CommandProcessContext,
    holder: ProcessRecord,
    rootPid: number,
  ): DelegatedSignals | null {
    const definition = context.command.definition;
    const policy = this.signalPolicies.get(rootPid);
    const anchor = this.options.table.get(rootPid);
    if (
      definition.signals !== "delegated" ||
      !definition.owner ||
      !policy ||
      !anchor ||
      !policy.packages.has(definition.owner)
    )
      return null;
    const live = () =>
      !this.suspended &&
      !holder.revoked &&
      !anchor.revoked &&
      !definition.admission?.aborted &&
      this.options.table.get(holder.pid) === holder &&
      this.options.table.get(anchor.pid) === anchor &&
      this.signalPolicies.get(anchor.pid) === policy &&
      this.controllerFor(anchor.pid) === policy.controller &&
      !readOutcome(holder.outcome) &&
      !readOutcome(anchor.outcome);
    return Object.freeze({
      send: (pid: number, signal: number) => {
        const sig = checkedSignal(signal);
        if (!live()) return "revoked";
        const target = this.options.table.get(pid);
        if (!target || target.revoked || readOutcome(target.outcome)) return "missing";
        if (target.rootPid !== anchor.pid || target === anchor) return "denied";
        this.publishProcessSignal(pid, sig, target);
        return "sent";
      },
    });
  }

  /** Register an explicit adapter controller (including legacy transports), not a default adapter. */
  registerController(pid: number, controller: ProcessController): void {
    if (this.suspended) throw new Error("Process broker is disposed");
    if (this.controllerFor(pid)) throw new Error(`Process ${pid} already has a controller`);
    const observation =
      this.reservedRoots.get(pid)?.observation ?? this.options.table.get(pid)?.observation;
    if (observation) this.acquireObservation(observation);
    const stop = controller.stop;
    const capturedStop = stop
      ? () => reflectApply(stop, controller, []) as void | Promise<void>
      : undefined;
    const child = this.children.get(pid);
    const revoke = this.controllerRevocation(controller);
    if (child) {
      child.revokeController = revoke;
      child.controller = controller;
      child.capturedControllerStop = capturedStop;
    } else if (capturedStop) this.capturedControllerStops.set(pid, capturedStop);
    if (child) child.controller = controller;
    else {
      this.controllers.set(pid, controller);
      this.capturedControllerRevocations.set(pid, revoke);
    }
    this.captureControllerStop(pid);
    this.acquireController(pid);
    if (this.supervisor?.get(pid)) this.supervisor.registerCurrentImageRevocation(pid, revoke);
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
          : new Int32Array(value ?? allocateSharedControl(4));
    const reserved = {
      ...root,
      pid,
      job,
      cwd,
      signalState: createSignalState(root.signalState),
      outcome: outcomeWord(root.outcome),
      interrupt: word(root.interrupt),
      requestedSignal: word(root.requestedSignal),
      processIdentity: snapshotLogicalProcessIdentity({ pid, parentPid: 0 }),
    };
    const observation = admitProcessObservation(pid, reserved.outcome, root.observation);
    const admitted = { ...reserved, observation };
    this.acquireObservation(observation);
    const packages = controller.signalDelegation?.packages;
    const policy = packages
      ? { controller, packages: new Set(packages.map((pkg) => packageIdentity(pkg))) }
      : undefined;
    if (this.controllerFor(pid)) throw new Error(`Process ${pid} already has a controller`);
    this.supervisor?.createRoot(admitted);
    this.registerController(pid, controller);
    this.reservedRoots.set(pid, admitted);
    if (policy) this.signalPolicies.set(pid, policy);
    return pid;
  }
  /** Keep an accepted external spawn's ancestry until its asynchronous admission finishes. */
  retainRoot(pid: number): () => void {
    if (this.suspended) throw new Error("Process broker is disposed");
    if (!this.reservedRoots.has(pid)) throw new Error(`Unknown root process ${pid}`);
    const releaseObservation = this.observationOwners.get(pid)?.acquire();
    this.rootLeases.set(pid, (this.rootLeases.get(pid) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseObservation?.();
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
      const controller = this.controllerFor(pid);
      this.observationOwners.get(pid)?.close();
      this.transport.releaseRoot(pid);
      this.options.table.remove(pid);
      if (root && !this.options.table.job(root.job)?.members.size)
        this.options.table.removeJob(root.job);
      this.completedRoots.delete(pid);
      this.commandRoots?.delete(pid);
      this.reservedRoots.delete(pid);
      this.descendantHooks.delete(pid);
      this.signalPolicies.delete(pid);
      if (controller && this.capturedControllerStops.has(pid))
        this.retainedRootStops.set(pid, controller);
      this.controllers.delete(pid);
      this.capturedControllerRevocations.delete(pid);
      this.quiescedControllers.delete(pid);
      this.revokedControllers.delete(pid);
      this.roots.delete(pid);
      this.outputs.delete(pid);
      this.retireTerminalOutput(pid);
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
  async adoptRoot(
    root: RootProcessOptions & { readonly memory: readonly MemoryDeclaration[] },
    controller: ProcessController = {},
  ): Promise<number> {
    const ticket = this.options.reservations.admit({
      pid: root.pid ?? 0,
      executable: "external root",
      guest: { kind: "declared", memories: root.memory },
      group: "none",
      connection: false,
      controls: true,
    });
    let pid: number;
    try {
      pid = this.reserveRoot(root, controller);
    } catch (error) {
      ticket.abort();
      throw error;
    }
    this.rootAdmissions.set(pid, ticket);
    this.rootTickets.set(pid, ticket.launched());
    this.rootGrants.set(pid, ticket.control);
    // Reservation transfers an external consumer's teardown capabilities to this owner.
    // Activation may fail after creating its table record; keep those capabilities until
    // disposal even when the caller observes a rejected admission promise.
    await this.ready();
    if (this.suspended) throw new Error("Process broker is disposed");
    return pid;
  }
  async adoptRuntimeRoot(
    transport: WorkerProcessTransport,
    options: RuntimeRootOptions,
  ): Promise<void> {
    if (this.suspended) throw new Error("Process broker is disposed");
    const cwd = checkedProcessCwd(transport.cwd);
    const state = workerProcessState(transport);
    if (this.controllerFor(state.pid))
      throw new Error(`Process ${state.pid} already has a controller`);
    if (state.parentPid !== 0) throw new TypeError("root process has a parent");
    if (
      state.processKind !== "process" ||
      state.processIdentity.pid !== state.pid ||
      state.processIdentity.parentPid !== 0
    )
      throw new ProcessError(
        ProcessErrno.INVAL,
        "root process identity conflicts with reservation",
      );
    const existing = this.transport.get(state.pid);
    if (existing && workerProcessDirectoryId(existing) !== workerProcessDirectoryId(transport))
      throw new TypeError("process identity is already registered");
    if (transport.identity !== this.options.identities.buffer)
      throw new TypeError("root must borrow the runtime identity allocator");
    this.filesystem(transport);
    const data = transport.data as {
      filesystem: FilesystemIdentity;
      pipeRegistry?: import("../proc/pipes.js").PipePublicationRegistryHandle;
    };
    if (
      data.pipeRegistry &&
      !this.options.reservations.ownsBuffer("pipe-registry", data.pipeRegistry.buffer)
    )
      throw new TypeError("Root bootstrap requires a ledger-charged registry");
    const guestControls = this.commandRoots?.get(state.pid)?.root !== transport;
    const ticket = this.options.reservations.admit({
      pid: workerProcessState(transport).pid,
      executable: "adopted root",
      guest:
        options.memory === "group"
          ? { kind: "group" }
          : { kind: "declared", memories: options.memory },
      group: "none",
      connection: false,
      controls: guestControls,
    });
    const previousData = transport.data;
    let changedData = false;
    let registeredRegistry: PipePublicationRegistry | undefined;
    try {
      const output = rootOutput(options);
      // Capture fallible embedding getters before publishing this root.
      const prepare = options.prepareDescendant;
      const descendant = prepare
        ? {
            prepare: Object.freeze({
              terminal: prepare.terminal,
              run: prepare.run,
              settled: prepare.settled,
            }),
            directory: workerProcessDirectoryId(transport),
          }
        : undefined;
      const registry = data.pipeRegistry
        ? attachPipePublicationRegistry(data.pipeRegistry)
        : new PipePublicationRegistry({
            wake: state.wake,
            allocate: (length, maximum) =>
              this.options.reservations.buffer("pipe-registry", {
                kind: "growable-buffer",
                initial: length,
                maximum: bytes(maximum),
              }),
          });
      const bootstrap = { ...data, pipeRegistry: registry.handle() };
      const registered = !registry.isRevoked(state.pid);
      registry.registerProcess(state.pid);
      if (!registered) registeredRegistry = registry;
      transport.data = bootstrap;
      changedData = true;
      this.acquireProcess(transport);
      this.reserveRoot(
        { pid: state.pid, job: state.job, cwd, observation: transport, ...state.signals },
        options,
      );
      this.transport.adoptRoot(transport);
      this.roots.set(state.pid, transport);
      this.acquireController(state.pid);
      this.outputs.set(state.pid, output);
      this.registries.set(state.pid, registry);
      if (descendant) this.descendantHooks.set(state.pid, descendant);
      this.rootAdmissions.set(state.pid, ticket);
      this.rootTickets.set(state.pid, ticket.launched());
      if (guestControls) this.rootGrants.set(state.pid, ticket.control);
    } catch (error) {
      if (changedData) transport.data = previousData;
      registeredRegistry?.collectProcess(state.pid);
      ticket.abort();
      throw error;
    }
    if (this.activation) {
      const supervisor = await this.activation;
      if (this.suspended) throw new Error("Process broker is disposed");
      this.activateRuntimeRoot(supervisor, transport);
    }
  }
  async adoptCommandRoot(
    transport: WorkerProcessTransport,
    options: RuntimeRootOptions,
  ): Promise<void> {
    if (this.suspended || !this.supervisor) throw new Error("Process broker is unavailable");
    const processCapacity = directoryCapacity(transport.directory);
    const registry = new PipePublicationRegistry({
      processCapacity,
      cellsPerProcess: 16,
      maxCells: processCapacity * 128,
      wake: workerProcessState(transport).wake,
      allocate: (length, maximum) =>
        this.options.reservations.buffer("pipe-registry", {
          kind: "growable-buffer",
          initial: length,
          maximum: bytes(maximum),
        }),
    });
    initializeCommandExec(transport);
    transport.data = { filesystem: options.filesystem, pipeRegistry: registry.handle() };
    (this.commandRoots ??= new Map()).set(transport.pid, {
      root: transport,
      pending: new Set(),
      failures: new Map(),
      stopped: false,
    });
    try {
      await this.adoptRuntimeRoot(transport, options);
    } catch (error) {
      if (!this.roots.has(transport.pid)) this.commandRoots?.delete(transport.pid);
      throw error;
    }
  }
  private commandScope(transport: WorkerProcessTransport): CommandRootState | undefined {
    if (!this.commandRoots?.size) return;
    let rootPid: number;
    try {
      rootPid = workerProcessState(transport).rootPid;
    } catch (error) {
      if (!isCollectedProcess(error)) throw error;
      return;
    }
    const scope = this.commandRoots.get(rootPid);
    if (scope && workerProcessDirectoryId(scope.root) === workerProcessDirectoryId(transport))
      return scope;
  }
  private checkCommandAdmission(transport: WorkerProcessTransport): void {
    const scope = this.commandScope(transport);
    if (scope && this.commandAdmissionClosed(scope))
      throw new ProcessError(ProcessErrno.SRCH, "Command is stopping");
  }
  private commandAdmissionClosed(scope: CommandRootState): boolean {
    return (
      scope.stopped ||
      scope.failures.size !== 0 ||
      commandTransferFailed(scope.root.commandTransfer)
    );
  }
  private trackCommandTransfer(
    transport: WorkerProcessTransport,
    cleanup: () => Promise<void>,
  ): Promise<void> {
    const scope = this.commandScope(transport);
    if (!scope) return cleanup();
    const pending = Promise.resolve().then(cleanup);
    scope.pending.add(pending);
    const settle = () => {
      scope.pending.delete(pending);
      wakeWorkerProcess(scope.root);
    };
    void pending.then(settle, (error) => {
      scope.failures.set(transport, error);
      settle();
    });
    return pending;
  }
  private async retireRejectedCommand(transport: WorkerProcessTransport): Promise<void> {
    const returned = this.processNativeReturn(transport);
    if (this.acquiredProcesses.get(transport.pid) === this.processLifetime(transport)) {
      await this.retireProcess(transport.pid, true);
      this.retireChildController(transport.pid);
    }
    returned();
  }
  private commandCleanupFailure(scope: CommandRootState): Error | undefined {
    if (scope.failures.size) {
      const [cause] = scope.failures.values();
      return new Error("Command transfer cleanup failed", { cause });
    }
    const buffer = scope.root.commandTransfer;
    return buffer ? readCommandTransferFailure(buffer)?.error : undefined;
  }
  private async joinCommandExec(transport: WorkerProcessTransport): Promise<void> {
    const scope = this.commandScope(transport);
    const handoff = commandExecTransfer(transport);
    if (!scope || !handoff) return;
    const state = workerProcessState(transport);
    for (;;) {
      const expected = Atomics.load(state.wake, 0);
      const buffer = scope.root.commandTransfer;
      const local = buffer && readCommandTransferFailure(buffer);
      if (
        local?.kind === "exec" &&
        local.pid === transport.pid &&
        local.generation === transport.generation
      )
        throw local.error;
      const staged = controlLoad(handoff);
      if (staged === 0) return;
      for (const [transfer, cause] of scope.failures) {
        if (transfer.pid === transport.pid && transfer.generation === staged)
          throw new Error("Exec transfer cleanup failed", { cause });
      }
      await atomicsWaitAsync(state.wake, 0, expected).value;
    }
  }

  commandPipeHost(
    transport: WorkerProcessTransport,
    postMessage: (message: WorkerProcessMessage) => void,
  ): WorkerPipeHost {
    const registry = this.registries.get(transport.pid);
    if (!registry || !this.commandRoots?.has(transport.pid))
      throw new Error("Command root is not admitted");
    return new WorkerPipeHost({
      transport,
      registry,
      postMessage,
      allocateShared: (length) =>
        this.options.reservations.buffer("control", {
          kind: "fixed-buffer",
          length: bytes(length),
        }),
    });
  }
  stopCommandRoot(root: WorkerProcessTransport): void {
    const scope = this.commandRoots?.get(root.pid);
    if (!scope || scope.stopped) return;
    scope.stopped = true;
    this.stopCommandMembers(root);
    wakeWorkerProcess(root);
  }
  private stopCommandMembers(root: WorkerProcessTransport): void {
    const members = Array.from(directoryProcesses(root.directory)).filter((state) => {
      try {
        return state.pid !== root.pid && !readOutcome(state.signals.outcome);
      } catch (error) {
        if (!isCollectedProcess(error)) throw error;
        return false;
      }
    });
    for (const state of members) this.requestSignalIfPresent(state.signals, 9);
    for (const state of members) {
      try {
        this.revokeRuntimeProcess(state.pid, workerProcessDirectoryId(root));
      } catch (error) {
        if (!isCollectedProcess(error)) throw error;
      }
    }
  }
  checkCommandCleanup(root: WorkerProcessTransport, mayCollect: boolean): boolean {
    const scope = this.commandRoots?.get(root.pid);
    const supervisor = this.supervisor;
    if (!scope || !supervisor) throw new Error("Command root is not admitted");
    const version = idleDirectoryAdmission(root.directory);
    if (scope.stopped) this.stopCommandMembers(root);
    this.transport.pump();
    this.serviceTerminalOutput(root.pid);
    const failure = this.commandCleanupFailure(scope);
    if (failure) throw failure;
    const retired = supervisor.rootConsumersRetired(root.pid);
    if (!mayCollect) return false;
    const ownJob = workerProcessState(root).job;
    for (const group of directoryGroups(root.directory)) {
      if (group.id === ownJob) continue;
      try {
        if (supervisor.job(group.id)) {
          if (supervisor.jobCleanupReady(root.pid, group.id))
            supervisor.reapJob(root.pid, group.id);
        } else if (controlLoad(group.pending) === 0) {
          collectDirectoryJob(root.directory, group.slot, group.id);
        }
      } catch (error) {
        if (!isCollectedProcess(error)) throw error;
      }
    }
    return (
      retired &&
      scope.pending.size === 0 &&
      !Array.from(directoryGroups(root.directory)).some((group) => group.id !== ownJob) &&
      !this.terminalOutputs.get(root.pid)?.pending() &&
      version !== undefined &&
      idleDirectoryAdmission(root.directory) === version
    );
  }
  async retireCommandRoot(root: WorkerProcessTransport): Promise<void> {
    const owner = this.observationOwners.get(root.pid);
    await this.quiesceProcess(root.pid);
    await this.rootExit(root.pid, 0);
    this.rootStopped(root.pid);
    await owner?.join();
    this.pipes.pump();
  }

  private bindPipeRegistry(transport: WorkerProcessTransport): void {
    const state = workerProcessState(transport);
    const registry = this.registries.get(state.rootPid);
    if (!registry)
      throw new ProcessError(ProcessErrno.SRCH, "Process has no admitted pipe registry");
    registry.registerProcess(state.pid);
    const data = transport.data;
    if (!data || typeof data !== "object") throw new TypeError("Process has no bootstrap data");
    transport.data = { ...data, pipeRegistry: registry.handle() };
  }
  private activateRuntimeRoot(
    supervisor: ProcessSupervisor,
    transport: WorkerProcessTransport,
  ): void {
    const state = workerProcessState(transport);
    if (!supervisor.get(state.pid))
      supervisor.createRoot({
        observation: transport,
        pid: state.pid,
        job: state.job,
        cwd: transport.cwd,
        ...state.signals,
      });
    supervisor.registerRevocation(state.pid, () => this.revokeRuntimeProcess(state.pid));
    installWorkerBindings(
      transport,
      supervisor.get(state.pid)!.image.descriptors,
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
        identity.requestBudget,
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
        output: deliveredTerminalOutput((target, data) => {
          const destination = this.outputFor(workerProcessState(transport).pid);
          return destination ? destination(target, data) : data.length;
        }),
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
  private runtimeProcessLifetime(
    pid: number,
  ): { key: string; terminal: TerminalProcessLifetime } | undefined {
    // Only adopted directories can resolve a controller registered before publication.
    for (const root of this.roots.values()) {
      const state = Array.from(directoryProcesses(root.directory)).find(
        (state) => state.pid === pid,
      );
      if (state)
        return {
          key: `${workerProcessDirectoryId(root)}:${state.slot}:${pid}`,
          terminal: captureTerminalLifetime({ directory: root.directory, slot: state.slot, pid }),
        };
    }
    return undefined;
  }
  private processNativeReturn(transport: WorkerProcessTransport): () => void {
    this.acquireController(transport.pid);
    const acquired = this.acquiredProcesses.get(transport.pid);
    const existing = this.observationOwners.get(transport.pid);
    if (
      (acquired && acquired !== this.processLifetime(transport)) ||
      (existing && !existing.matches(transport))
    )
      return () => {};
    this.acquireObservation(transport, true);
    const owner = this.observationOwners.get(transport.pid)!;
    return () => owner.close();
  }
  private captureControllerStop(pid: number): void {
    const stop = this.capturedControllerStopFor(pid);
    if (
      (this.options.table.get(pid)?.image.generation ?? 1) > 1 &&
      this.nativeLaunchReturns.has(pid)
    )
      return;
    if (!stop || !this.observationOwners.has(pid) || this.controllerNativeStopFor(pid)) return;
    const child = this.children.get(pid);
    const returned = new NativeReturnFollowers();
    const captured = this.captureConsumerStop(pid, stop, () => {
      if (!child) {
        this.controllerNativeStops.delete(pid);
        this.capturedControllerStops.delete(pid);
        this.controllerNativeReturns.delete(pid);
      }
      this.retainedRootStops.delete(pid);
      returned.returned();
      this.rootStopped(pid);
    });
    if (child) {
      child.controllerNativeReturn = returned;
      child.controllerNativeStop = captured;
    } else {
      this.controllerNativeReturns.set(pid, returned);
      this.controllerNativeStops.set(pid, captured);
      this.bindRootGroup(pid, captured);
    }
  }
  private acquireObservation(transfer: ProcessObservationTransfer, execution = false): void {
    const existing = this.observationOwners.get(transfer.pid);
    if (existing) {
      if (!existing.matches(transfer))
        throw new ProcessError(
          ProcessErrno.INVAL,
          "Process observation owner differs from admission",
        );
      if (execution) existing.acceptExecution();
      return;
    }
    this.observationOwners.set(
      transfer.pid,
      new NativeObservationOwner(
        transfer,
        () => this.releaseObservationOwner(transfer.pid),
        execution,
      ),
    );
    const controller = this.controllerFor(transfer.pid);
    if (controller) this.captureControllerStop(transfer.pid);
  }
  /** Capture this admitted association before handing it to an external worker. */
  rootObservation(pid: number): ProcessObservationTransfer {
    const observation =
      this.reservedRoots.get(pid)?.observation ?? this.options.table.get(pid)?.observation;
    if (!observation) throw new ProcessError(ProcessErrno.SRCH, "Process is not admitted");
    return observation;
  }
  private acquireProcess(transport: WorkerProcessTransport): void {
    const lifetime = this.processLifetime(transport);
    const acquired = this.acquiredProcesses.get(transport.pid);
    if (acquired && acquired !== lifetime)
      throw new Error("process consumer belongs to another lifetime");
    this.acquiredProcesses.set(transport.pid, lifetime);
    if (!acquired && this.supervisor?.get(transport.pid))
      this.supervisor.registerRevocation(transport.pid, () =>
        this.revokeRuntimeProcess(transport.pid),
      );
    this.acquireObservation(transport, workerProcessState(transport).parentPid !== 0);
    if (!this.terminalLifetimes.has(transport.pid))
      this.terminalLifetimes.set(transport.pid, captureTerminalLifetime(transport));
  }
  private acquireController(pid: number): void {
    if (this.acquiredProcesses.has(pid) || !this.controllerFor(pid)) return;
    const lifetime = this.runtimeProcessLifetime(pid);
    if (!lifetime) return;
    this.acquiredProcesses.set(pid, lifetime.key);
    this.terminalLifetimes.set(pid, lifetime.terminal);
  }
  private releaseObservationOwner(pid: number): void {
    this.observationOwners.delete(pid);
    this.nativeLaunchReturns.delete(pid);
    this.controllerNativeStops.delete(pid);
    this.capturedControllerStops.delete(pid);
    this.controllerNativeReturns.delete(pid);
    this.retainedRootStops.delete(pid);
  }
  private releaseAcquiredProcess(pid: number): void {
    if (
      this.options.table.get(pid) ||
      this.nativeLaunchReturns.has(pid) ||
      this.imageStops.has(pid) ||
      !!this.controllerFor(pid) ||
      this.children.has(pid) ||
      this.launches?.has(pid) ||
      this.pendingLaunches?.has(pid) ||
      this.fences.has(pid)
    )
      return;
    this.acquiredProcesses.delete(pid);
    this.terminalLifetimes.delete(pid);
    if (this.observationOwners.get(pid)?.completed) this.observationOwners.delete(pid);
    this.nativeLaunchReturns.delete(pid);
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
  /** A bounded root destination reports room for its writers' buffered terminal output. */
  outputDrained(rootPid: number): void {
    this.serviceTerminalOutput(rootPid);
  }
  private serviceTerminalOutput(rootPid: number): void {
    const budget = this.terminalOutputs.get(rootPid);
    if (!budget || this.suspended) return;
    const destination = this.outputFor(rootPid);
    try {
      budget.service(destination ?? ((_target, data) => data.length));
    } catch (error) {
      this.report(error);
    }
    if (!budget.readers.size) this.terminalOutputs.delete(rootPid);
  }
  private retireTerminalOutput(rootPid: number): void {
    const budget = this.terminalOutputs.get(rootPid);
    this.terminalOutputs.delete(rootPid);
    const pending = budget?.pending();
    // The destination is gone. Say so instead of dropping accepted bytes silently.
    if (pending)
      this.report(
        new Error(`root ${rootPid} retired with ${pending} terminal output bytes undelivered`),
      );
  }
  private outputFor(pid: number): TerminalOutputDelivery | undefined {
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
    this.children.get(pid)?.accesses?.dispose();
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
    const consumingReceipt =
      message.operation === "reap-job" || message.operation === "reap-process";
    let filesystemRevoked = false;
    if (sender && !consumingReceipt) {
      try {
        // Ordinary exit claims its outcome before reap revokes the filesystem.
        // Sample revocation first so a new reap cannot pair with an old running outcome.
        filesystemRevoked = isRevoked(this.filesystem(sender));
      } catch (error) {
        // Sender validation owns rejection cleanup for incoming transferred resources.
        this.rejectMessage(message, senderPid, "sender-revoked");
        throw error;
      }
    }
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
    const revoked = !consumingReceipt && senderRevoked(result, filesystemRevoked);
    const stopping = this.commandMessageStopped(message);
    if ((!sender && !retainedNotice) || this.suspended || revoked || stopping) {
      this.rejectMessage(
        message,
        senderPid,
        this.suspended
          ? "broker-disposed"
          : !sender
            ? "unknown-sender"
            : result?.kind === "signaled"
              ? "sender-signaled"
              : stopping
                ? "external-rejection"
                : "sender-revoked",
      );
      return;
    }
    if (message.operation === "access" || message.operation === "access-cancel") {
      await this.accessMessage(message, senderPid, sender, result);
      return;
    }
    await this.transport.handle(message, senderPid);
    this.retireRoots();
    if (message.operation !== "pipe") this.watch();
  }
  private commandMessageStopped(message: WorkerProcessMessage): boolean {
    if (message.operation !== "spawn" && message.operation !== "exec") return false;
    try {
      const scope = this.commandScope(message.transport);
      return scope !== undefined && this.commandAdmissionClosed(scope);
    } catch (error) {
      if (!isCollectedProcess(error)) throw error;
      return false;
    }
  }
  private async accessMessage(
    message: Extract<WorkerProcessMessage, { operation: "access" | "access-cancel" }>,
    senderPid: number,
    sender: WorkerProcessTransport | undefined,
    result: ProcessExit | null,
  ): Promise<void> {
    if (
      !sender ||
      result ||
      workerProcessState(message.transport).pid !== senderPid ||
      workerProcessDirectoryId(sender) !== workerProcessDirectoryId(message.transport)
    ) {
      this.rejectMessage(message, senderPid, "wrong-sender");
      return;
    }
    await (this.children.get(senderPid)?.accesses ?? this.accesses).handle(message, sender);
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
    if (message.operation === "exec") {
      void this.transport
        .rejectExec(message, new ProcessError(ProcessErrno.SRCH, "exec sender is unavailable"))
        .catch((error) => this.report(error));
      return;
    }
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
    void this.trackCommandTransfer(transport, () => this.releaseRejectedTransfer(transport)).then(
      resolve,
      reject,
    );
    void pending.then(
      () => this.rejectedTransfers.delete(key),
      (error) => this.report(error),
    );
  }
  private async releaseRejectedTransfer(transport: WorkerProcessTransport): Promise<void> {
    const errors: unknown[] = [];
    const codec = this.discardCodec();
    for (const token of transport.resources) {
      try {
        codec.discard(token);
      } catch (error) {
        errors.push(error);
        this.report(error);
      }
    }
    wakeWorkerProcess(transport);
    await this.quiesceUnstarted(transport);
    const scope = this.commandScope(transport);
    if (errors.length) {
      if (scope) throw new AggregateError(errors, "Rejected spawn descriptor cleanup failed");
      return;
    }
    if (scope) await this.retireRejectedCommand(transport);
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
   * A fresh single-use module worker for a root the consumer launches itself.
   * It stays inert until the consumer posts its request; the consumer owns its termination.
   */
  takeWorker(workerUrl: string): Worker {
    if (this.suspended) throw new Error("Process broker is disposed");
    return this.workers.take(workerUrl);
  }
  /** Trusted external-root bootstrap field, never guest environment configuration. */
  rootControlGrant(pid: number): SharedControlGrant {
    const grant = this.rootGrants.get(pid);
    if (!grant) throw new ProcessError(ProcessErrno.SRCH, "Root is not admitted");
    return grant;
  }
  /** Trusted root launcher must enroll before its bootstrap post or graphics port transfer. */
  retainRootGraphics(pid: number, graphics: GraphicsGrant, worker: Worker): void {
    const ticket = this.rootAdmissions.get(pid);
    const launched = this.rootTickets.get(pid);
    if (!ticket || !launched) throw new ProcessError(ProcessErrno.SRCH, "Root is not admitted");
    const retention = ticket.retainControlsForGraphics();
    bindGraphicsLaunch(graphics, retention);
    retainAllocationReceipts(worker, launched, retention, (error) => this.report(error));
  }
  /** Capture before handing process controls to an externally owned native consumer. */
  captureRootStop(pid: number, stop: () => void | Promise<void>): () => void | Promise<void> {
    const captured = this.captureConsumerStop(pid, stop);
    return () => captured.terminate();
  }
  /** Only the native root consumer is bound. Independent captureRootStop helpers are excluded. */
  private bindRootGroup(pid: number, handle: NativeStopHandle): NativeStopHandle {
    const group = this.rootGroups?.get(pid);
    if (group) handle.bindGroup(group);
    return handle;
  }
  private captureConsumerStop(
    pid: number,
    stop: () => void | Promise<void>,
    onReturned?: () => void,
  ): NativeStopHandle {
    const owner = this.observationOwners.get(pid);
    if (!owner) throw new ProcessError(ProcessErrno.SRCH, "Root is not admitted");
    const returned = owner.acquire();
    const handle = nativeStopHandle(
      { terminate: stop },
      undefined,
      () => {
        owner.removeStop(handle);
        onReturned?.();
        returned();
      },
      () => owner.close(),
      (error) => owner.fail(error),
    );
    owner.addStop(handle);
    return handle;
  }
  /** A successful external native return acknowledges only this root's controller consumer. */
  rootStopped(pid: number): void {
    const stop = this.controllerNativeStopFor(pid);
    if (stop) {
      stop.acknowledgeReturn();
      return;
    }
    this.rootTickets.get(pid)?.stopped();
    this.rootTickets.delete(pid);
    this.rootAdmissions.delete(pid);
    this.rootGrants.delete(pid);
  }
  rootControlAllocated(pid: number, buffer: SharedArrayBuffer): void {
    const ticket = this.rootTickets.get(pid);
    if (!ticket) throw new ProcessError(ProcessErrno.SRCH, "Root is not admitted");
    ticket.controlAllocated(buffer);
  }
  /** Always false: workers transfer to their caller immediately, with no idle residency. */
  isIdleWorker(worker: Worker): boolean {
    return this.workers.isIdle(worker);
  }
  /** Includes pending/failed physical cleanup. Each result is a fresh, authority-free snapshot. */
  workerMemory(): readonly WorkerMemoryObservation[] {
    return Array.from(this.children.values(), (child) => {
      const bytes = Atomics.load(child.memory, 0);
      return { ...child.identity, bytes: bytes < 0n ? null : Number(bytes) };
    });
  }
  /**
   * The start step each live launch reached, with page timestamps: a hung start names its
   * stuck step. Fresh authority-free snapshots; see docs/process-observation.md, "Start states".
   */
  startStates(): readonly ProcessStartState[] {
    const states: ProcessStartState[] = [];
    for (const child of this.children.values()) {
      if (child.guestEnded || child.failed || child.stopped) continue;
      observeStart(child.start, child.memory, child.context.outcome);
      states.push(startSnapshot(child.start));
    }
    for (const launch of this.pendingLaunches?.values() ?? []) {
      // A launch that already constructed its worker is listed (or retired) as that child.
      if (this.children.get(launch.start.pid)?.start === launch.start) continue;
      states.push(startSnapshot(launch.start));
    }
    return states;
  }
  /**
   * Trusted launcher pairing for RuntimeNetwork.createHelper: the live admitted process's own
   * filesystem identity with `directory`. Nothing is attached here; the network authenticates the
   * pair (same filesystem, live identity, a directory the guest's table holds) on the guest's first
   * path request. The caller keeps owning `directory` and releases it after the helper is disposed.
   */
  networkPathScope(context: ProcessContext, directory: FileHandle): RuntimeNetworkPathScope {
    if (this.suspended) throw new Error("Process broker is disposed");
    if (!Number.isSafeInteger(directory) || directory < 0)
      throw new TypeError("Network path scope requires a directory handle");
    const transport = this.transport.get(context.pid);
    if (!transport) throw new Error("process has no admitted worker transport");
    const state = workerProcessState(transport);
    if (state.parentPid !== context.parentPid || state.job !== context.job)
      throw new Error("process context does not match its admitted transport");
    if (readOutcome(context.outcome)) throw new Error("process has already exited");
    const filesystem = this.filesystem(transport);
    if (isRevoked(filesystem)) throw new Error("process filesystem is revoked");
    return Object.freeze({ filesystem, directory });
  }
  private workerPlan(context: ProcessContext, options: WorkerLaunchOptions): ProcessPlan {
    const memories = moduleMemoryDeclarations(options.request.module);
    const guest: ProcessGuestPlan = options.memoryGroup
      ? { kind: "declared", memories: options.memories ?? [] }
      : memories
        ? { kind: "declared", memories: memories.concat(options.memories ?? []) }
        : { kind: "undeclared" };
    const group =
      options.memoryGroup === "new"
        ? {
            create: this.options.reservations.sizing.groupShape(
              this.options.memoryGroups?.maximumPages,
            ),
          }
        : options.memoryGroup
          ? "join"
          : "none";
    return {
      pid: context.pid,
      executable: context.request.executable,
      guest,
      group,
      connection: true,
      controls: true,
    };
  }
  launchWorker<T extends RuntimeWorkerRequest>(
    context: ProcessContext,
    options: WorkerLaunchOptions<T>,
  ): ProcessHandle {
    const graphicsOwner = options.graphics;
    let graphicsReleased = false;
    const graphics: GraphicsGrant | undefined = graphicsOwner && {
      connection: graphicsOwner.connection,
      dispose() {
        if (graphicsReleased) return;
        graphicsReleased = true;
        graphicsOwner.dispose();
      },
      retired: () => graphicsOwner.retired(),
    };
    if (graphics && graphicsOwner) originalGraphicsGrants.set(graphics, graphicsOwner);
    const owner = options.network;
    let released = false;
    const network = owner && {
      connection: owner.connection,
      dispose() {
        if (released) return;
        released = true;
        owner.dispose();
      },
    };
    try {
      this.checkGuestImage(context.pid, context.generation);
      if (options.memoryGroup)
        requireGroupPlan(
          options.request.module,
          "linkPlan" in options.request ? options.request.linkPlan : undefined,
        );
      if (readOutcome(context.outcome))
        throw new ProcessError(ProcessErrno.SRCH, "process exited before worker admission");
      const threaded = threadModuleDeclaration(options.request.module);
      if (threaded && graphics) throw new Error("Threaded guests do not accept graphics grants");
      if (threaded) return this.launchThreadWorker(context, options, threaded);
      if (
        WebAssembly.Module.imports(options.request.module).some(
          (entry) => entry.module === "wasi" && entry.name === "thread-spawn",
        )
      )
        throw new Error("Threaded Preview 1 requires validated source bytes");
      return this.launchOwnedWorker(context, { ...options, network, graphics });
    } catch (error) {
      if (
        !this.children.has(context.pid) &&
        context.execution?.kind !== "host" &&
        this.options.table.get(context.pid)?.image.execution?.kind !== "host" &&
        typeof error === "object" &&
        error !== null
      )
        this.neverConstructed.set(error, context.pid);
      try {
        graphics?.dispose();
      } catch (cleanup) {
        this.report(cleanup);
      }
      try {
        network?.dispose();
      } catch (cleanup) {
        this.report(cleanup);
      }
      throw error;
    }
  }
  private launchThreadWorker(
    context: ProcessContext,
    options: WorkerLaunchOptions,
    declaration: NonNullable<ReturnType<typeof threadModuleDeclaration>>,
  ): ProcessHandle {
    const { threaded: urls, cleanup } = options;
    if (
      !urls ||
      options.memoryGroup ||
      options.network ||
      options.memories?.length ||
      !options.request.interruptible
    )
      throw new Error("Threaded Preview 1 requires the explicit source-admitted thread launcher");
    if (this.suspended) throw new Error("Process broker is disposed");
    const transport = this.transport.get(context.pid);
    if (!transport || transport.generation !== context.generation || this.children.has(context.pid))
      throw new Error("process has no available worker transport");
    const state = workerProcessState(transport);
    const filesystem = this.filesystem(transport);
    this.bindPipeRegistry(transport);
    const memory = new BigInt64Array(allocateSharedControl(8));
    Atomics.store(memory, 0, -1n);
    const launch = this.launchState(context);
    const child: RuntimeChild = {
      generation: context.generation,
      transport,
      launch,
      start: launch.pending?.start ?? processStartRecord(context),
      nativeReturned: this.nativeLaunchReturns.get(context.pid),
      memory,
      filesystem,
      context,
      cleanup,
      identity: {
        pid: state.pid,
        parentPid: state.parentPid,
        rootPid: state.rootPid,
        job: state.job,
        directory: workerProcessDirectoryId(transport),
      },
      acknowledged: false,
      failed: false,
      stopped: false,
    };
    this.captureImageState(child);
    this.children.set(context.pid, child);
    context.registerRevocation(() => {
      this.options.filesystem.revoke(filesystem);
      void child.threads?.then((owner) => owner?.terminal()).catch((error) => this.report(error));
    });
    child.threads = import("../thread/runtime-owner.js").then(({ RuntimeThreadOwner }) =>
      RuntimeThreadOwner.create({
        context,
        transport,
        declaration,
        urls,
        reservations: this.options.reservations,
        connect: (headroom) => this.options.filesystem.connect(filesystem, headroom),
        filesystemFence: () => this.options.filesystem.quiesce(filesystem),
        nativeReturned: () => child.nativeReturned?.(),
        cleanup: () => {
          const dispose = child.cleanup;
          child.cleanup = undefined;
          dispose?.();
        },
        failed: (error) => {
          this.report(error);
          if (startStatus(context.outcome) === 0) context.fail(error);
          else context.startFailed(error);
        },
      }),
    );
    void child.threads.catch((error) => {
      child.failed = true;
      context.startFailed(error);
    });
    this.watch();
    return { terminate: () => this.stop(child) };
  }
  private launchOwnedWorker<T extends RuntimeWorkerRequest>(
    context: ProcessContext,
    options: WorkerLaunchOptions<T>,
  ): ProcessHandle {
    if (this.suspended) {
      options.network?.dispose();
      throw new Error("Process broker is disposed");
    }
    const transport = this.transport.get(context.pid);
    if (
      !transport ||
      transport.generation !== context.generation ||
      this.children.has(context.pid)
    ) {
      options.network?.dispose();
      throw new Error(
        !transport ? "process has no admitted worker transport" : "process already has a worker",
      );
    }
    const state = workerProcessState(transport);
    const ticket = this.options.reservations.admit(this.workerPlan(context, options));
    if (options.graphics) {
      try {
        const retention = ticket.retainControlsForGraphics();
        bindGraphicsLaunch(options.graphics, retention);
        const original = originalGraphicsGrants.get(options.graphics);
        if (original) bindGraphicsLaunch(original, retention);
      } catch (error) {
        ticket.abort();
        throw error;
      }
    }
    let memory: BigInt64Array;
    try {
      memory = new BigInt64Array(allocateSharedControl(8));
      Atomics.store(memory, 0, -1n);
    } catch (error) {
      ticket.abort();
      throw error;
    }
    const filesystem = this.filesystem(transport);
    // Record cleanup ownership before either connection or Worker construction can throw.
    const launch = this.launchState(context);
    const child: RuntimeChild = {
      generation: context.generation,
      transport,
      launch,
      start: launch.pending?.start ?? processStartRecord(context),
      nativeReturned: this.nativeLaunchReturns.get(context.pid),
      ticket,
      memory,
      identity: {
        pid: state.pid,
        parentPid: state.parentPid,
        rootPid: state.rootPid,
        job: state.job,
        directory: workerProcessDirectoryId(transport),
      },
      filesystem,
      context,
      acknowledged: false,
      failed: false,
      stopped: false,
      cleanup: options.cleanup,
      network: options.network,
      graphics: options.graphics,
      wake: options.wake,
    };
    this.captureImageState(child);
    this.children.set(context.pid, child);
    context.registerRevocation(() => this.disposeNetwork(child));
    let connection: FilesystemConnection | undefined;
    let worker: Worker;
    let output: TerminalOutputReader;
    try {
      this.bindPipeRegistry(transport);
      output = child.output = createTerminalOutput();
      let budget = this.terminalOutputs.get(state.rootPid);
      if (!budget) this.terminalOutputs.set(state.rootPid, (budget = new TerminalOutputBudget()));
      budget.readers.add(output);
      context.registerRevocation(() => output.close());
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
        this.options.filesystem.revoke(filesystem);
      });
      if (options.memoryGroup)
        child.group = this.admitGroupMember(
          context.pid,
          transport,
          options.memoryGroup,
          ticket.group,
        );
      connection = this.options.filesystem.connect(filesystem, ticket.arena);
      if (readOutcome(context.outcome))
        throw new ProcessError(ProcessErrno.SRCH, "process exited before worker construction");
      worker = child.worker = this.workers.take(options.workerUrl);
      markStart(child.start, "worker-constructed");
      this.imageStops.delete(context.pid);
      child.launched = ticket.launched();
      if (options.graphics)
        retainAllocationReceipts(
          worker,
          child.launched,
          graphicsLaunchRetention(options.graphics),
          (error) => this.report(error),
        );
    } catch (error) {
      // No Worker exists yet: the group reservation returns exactly once.
      child.group?.abort();
      ticket.abort();
      child.failed = true;
      this.disposeNotifications(child);
      this.disposeNetwork(child);
      connection?.port.close();
      throw error;
    }
    const request = {
      ...options.request,
      hostIdentity: this.hostIdentity,
      memoryObservation: memory.buffer,
      controlGrant: ticket.control,
      filesystem: connection,
      runtimeProcess: transport,
      outcome: serializeOutcome(context.outcome),
      observation: context.observation,
      startupStderr: child.startupStderr?.handle(),
      notifications: child.notifications?.connection,
      terminalOutput: output.buffer,
      network: options.network?.connection,
      graphics: options.graphics?.connection,
    };
    const group = child.group?.launch();
    if (group) Object.assign(request, { memoryGroup: group.request });
    this.watch();
    worker.onmessage = ({ data }: MessageEvent<RuntimeWorkerMessage>) => {
      startMessage(child.start, data, memory, context.outcome);
      if (guestFinished(data?.type)) guestEnded(child);
      this.childMessage(child, options, data);
    };
    worker.onerror = (event) => {
      guestEnded(child);
      this.childError(child, event);
    };
    try {
      if (readOutcome(context.outcome))
        throw new ProcessError(ProcessErrno.SRCH, "process exited before worker publication");
      const ports: Transferable[] = [request.filesystem.port];
      if (request.notifications) ports.push(request.notifications.port);
      if (request.network) ports.push(request.network.port);
      if (request.graphics) ports.push(request.graphics.port);
      worker.postMessage(request, group ? ports.concat(group.transfer) : ports);
      markStart(child.start, "start-posted");
    } catch (error) {
      child.failed = true;
      this.disposeNotifications(child);
      request.filesystem.port.close();
      this.disposeNetwork(child);
      throw error;
    }
    return { terminate: () => this.stopWorker(child) };
  }
  /** The group whose launched member runs as `pid`. Trusted embedder use only. */
  memoryGroupOf(pid: number): MemoryGroupHandle | undefined {
    return this.groups?.groupOf(pid);
  }
  /** Owner-side counters for every live group on this page. */
  memoryGroups(): readonly MemoryGroupSnapshot[] {
    return this.groups?.snapshot() ?? [];
  }
  /** Admit an adopted runtime root before posting its worker request. Successful disposal
   * stop of a root with `stop`, or the embedder's `stopped()`, settles it once. */
  admitRootMemoryGroup(
    pid: number,
    program: { readonly module: WebAssembly.Module; readonly linkPlan: SharedLinkPlan },
    join: MemoryGroupLaunch = "new",
  ): RootMemoryGroupMember {
    this.checkGuestImage(pid);
    requireGroupPlan(program?.module, program?.linkPlan);
    if (this.suspended) throw new Error("Process broker is disposed");
    const transport = this.roots.get(pid);
    if (!transport) throw new Error(`Unknown runtime root ${pid}`);
    if (this.rootGroups?.has(pid)) throw new Error(`Root ${pid} already has a memory group`);
    const ticket = this.options.reservations.admit({
      pid,
      executable: "root memory group",
      guest: { kind: "group" },
      group:
        join === "new"
          ? {
              create: this.options.reservations.sizing.groupShape(
                this.options.memoryGroups?.maximumPages,
              ),
            }
          : "join",
      connection: false,
      controls: false,
    });
    let lease: MemberLease | undefined;
    let bootstrap: ReturnType<MemberLease["launch"]> | undefined;
    try {
      const admitted = (lease = this.admitGroupMember(pid, transport, join, ticket.group));
      // Finish bootstrap preparation before committing ownership of the external member.
      admitted.group.buffer();
      const { request, transfer } = (bootstrap = admitted.launch());
      ticket.launched();
      this.controllerNativeStopFor(pid)?.bindGroup(admitted);
      (this.rootGroups ??= new Map()).set(pid, admitted);
      return Object.freeze({
        group: admitted.group,
        request,
        transfer: Object.freeze(transfer),
        terminating: () => admitted.stopRequested(),
        stopped: () => this.settleRootGroup(pid, admitted),
      });
    } catch (error) {
      // No bootstrap request escaped, so no external agent can hold this incarnation.
      bootstrap?.request.port.close();
      lease?.stopped();
      ticket.abort();
      throw error;
    }
  }
  /** A settled root lease must not keep its group's backing reachable; debt stays tracked. */
  private settleRootGroup(pid: number, lease: MemberLease): void {
    lease.stopped();
    if (!lease.settled() || this.rootGroups?.get(pid) !== lease) return;
    this.rootStopped(pid);
    if (this.rootGroups?.get(pid) === lease) this.rootGroups.delete(pid);
  }
  private childMessage<T extends RuntimeWorkerRequest>(
    child: RuntimeChild,
    options: WorkerLaunchOptions<T>,
    data: RuntimeWorkerMessage,
  ): void {
    const context = child.context;
    const transport = child.transport;
    const filesystem = child.filesystem;
    if (!this.currentChild(child)) {
      this.traceProcess(child.identity, "dropped", "stale-image");
      return;
    }
    if (data.type === "replaced") {
      this.acknowledgeImage(child, data);
      return;
    }
    if (data.type === "shared-control-allocation") {
      if (!options.graphics) child.launched?.controlAllocated(data.buffer);
      return;
    }
    if (data.type === "observation-error") {
      this.report(new Error(data.message));
      return;
    }
    if (data.type === "terminal-output") {
      // Bytes the guest was told it wrote are delivered even after a signal won.
      this.serviceTerminalOutput(child.identity.rootPid);
      return;
    }
    const filesystemRevoked = data.type === "runtime-proc" && isRevoked(filesystem);
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
      if (workerProcessDirectoryId(data.transport) !== workerProcessDirectoryId(transport)) return;
      if (senderRevoked(selected, filesystemRevoked))
        this.rejectRuntimeMessage(
          data,
          context.pid,
          selected?.kind === "signaled" ? "sender-signaled" : "sender-revoked",
        );
      else {
        const message = this.executableMessage(data, options.executableName);
        void this.runtimeMessage(message, context.pid).catch((error) => this.report(error));
      }
      return;
    }
    if (data.type === "cleanup-error") {
      if (this.options.table.get(context.pid)?.image.phase === "retiring") {
        child.failed = true;
        context.fail(new Error(`Worker replacement cleanup: ${data.message}`));
        return;
      }
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
    if (data.type !== "exit" && data.type !== "error") {
      options.onMessage?.(data, context);
      return;
    }
    this.disposeNotifications(child);
    this.disposeNetwork(child);
    child.acknowledged = true;
    this.options.filesystem.reap(filesystem);
    if (data.cleanupErrors?.length)
      this.report(new Error(`Worker cleanup: ${data.cleanupErrors.join("; ")}`));
    if (data.type === "exit" && data.signal) context.defaultSignal(data.signal);
    else if (data.type === "exit") context.exit(data.code);
    else if (!entered)
      context.startFailed(new WorkerStartError(data.message, data.errno, data.diagnostic));
    else context.fail(new Error(data.message));
  }
  private acknowledgeImage(
    child: RuntimeChild,
    message: Extract<RuntimeWorkerMessage, { type: "replaced" }>,
  ): void {
    if (message.cleanupErrors?.length) {
      child.failed = true;
      child.context.fail(
        new Error(`Worker replacement cleanup: ${message.cleanupErrors.join("; ")}`),
      );
      return;
    }
    child.acknowledged = true;
    child.replacementAcknowledged = true;
    void this.supervisor
      ?.acknowledgeReplacement(child.context.pid, child.generation)
      .catch((error) => this.report(error));
  }
  private executableMessage(
    message: WorkerProcessMessage,
    name?: (executable: string) => string,
  ): WorkerProcessMessage {
    if (!name) return message;
    if (message.operation === "spawn")
      return {
        ...message,
        request: { ...message.request, executable: name(message.request.executable) },
      };
    if (message.operation === "exec")
      return {
        ...message,
        request: { ...message.request, executable: name(message.request.executable) },
      };
    return message;
  }
  private childError(child: RuntimeChild, event: ErrorEvent): void {
    const context = child.context;
    event.preventDefault();
    if (!this.currentChild(child)) {
      this.traceProcess(child.identity, "dropped", "stale-image");
      return;
    }
    child.failed = true;
    this.disposeNetwork(child);
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
  }
  private admitGroupMember(
    pid: number,
    transport: WorkerProcessTransport,
    join: MemoryGroupLaunch,
    headroom: Headroom | null = null,
  ): MemberLease {
    const groups = (this.groups ??= new MemoryGroups(
      this.options.memoryGroups,
      this.options.reservations.groups,
      this.options.reservations.sizing,
    ));
    const target =
      join === "inherit" ? groups.groupOf(workerProcessState(transport).parentPid) : join;
    if (!target) throw new ProcessError(ProcessErrno.SRCH, "parent has no memory group");
    const directory = transport.directory;
    return groups.admit(pid, workerProcessDirectoryId(transport), target, headroom, () =>
      this.terminalGroupAdmission(directory),
    );
  }

  private terminalGroupAdmission(directory: SharedArrayBuffer): boolean {
    const wake = new Int32Array(directory, 4, 1);
    const seen = Atomics.load(wake, 0);
    try {
      const version = directoryAdmissionVersion(directory);
      if (!this.groupIntentsSettled(directory)) {
        this.deferGroupAdmission(directory, wake, seen);
        return false;
      }
      commitDirectoryAdmission(directory, version);
      this.cancelGroupAdmissionWatch(directory);
      return true;
    } catch (error) {
      if (
        !(error instanceof ProcessError) ||
        (error.errno !== ProcessErrno.NOTSUP && !isCollectedProcess(error))
      )
        throw error;
      this.deferGroupAdmission(directory, wake, seen);
      return false;
    }
  }

  private groupIntentsSettled(directory: SharedArrayBuffer): boolean {
    const domain = atomicsLoad(new BigInt64ArrayConstructor(directory, 8, 1), 0);
    const domainWords = new Uint32Array(directory, 8, 2);
    const lifetimeDomain = `${domainWords[0]}:${domainWords[1]}`;
    const sameDirectory = (source: ProcessObservationTransfer) =>
      source.kind === "directory" &&
      atomicsLoad(new BigInt64ArrayConstructor(source.directory, 8, 1), 0) === domain;
    for (const launch of this.pendingLaunches?.values() ?? [])
      if (launch.acquiring && sameDirectory(launch.observation)) return false;
    for (const preparation of this.pendingPreparations)
      if (sameDirectory(preparation.observation)) return false;
    for (const state of directoryProcesses(directory)) {
      const key = `directory:${domain}:${state.slot}:${state.pid}`;
      const root = this.roots.get(state.pid);
      if (root && observationKey(root) === key) continue;
      const child = this.children.get(state.pid);
      if (child && observationKey(child.transport) === key && this.currentChild(child)) {
        if (child.launch.pending?.acquiring) return false;
        continue;
      }
      if (this.settledGroupAcquisitions.has(key)) continue;
      if (this.settledGroupRecord(state.pid, key)) continue;
      if (
        controlLoad(state.confirmed) &&
        this.acquiredProcesses.get(state.pid) !== `${lifetimeDomain}:${state.slot}:${state.pid}`
      )
        continue;
      return false;
    }
    return true;
  }

  private settledGroupRecord(pid: number, key: string): boolean {
    const record = this.options.table.get(pid);
    if (!record || observationKey(record.observation) !== key) return false;
    // A selected outcome prevents the not-yet-invoked adapter from ever acquiring a member.
    return (
      record.image.execution?.kind === "host" ||
      (record.image.nativeAcquisition.kind === "not-invoked" && !!readOutcome(record.outcome))
    );
  }

  private deferGroupAdmission(directory: SharedArrayBuffer, wake: Int32Array, seen: number): void {
    if (this.groupAdmissionWatches.has(directory)) return;
    this.groupAdmissionWatches.set(directory, wake);
    const waiting = atomicsWaitAsync(wake, 0, seen);
    void Promise.resolve(waiting.value)
      .then(() => {
        if (this.groupAdmissionWatches.get(directory) !== wake) return;
        this.groupAdmissionWatches.delete(directory);
        this.groups?.settleStopping();
      })
      .catch((error) => this.report(error));
  }
  private cancelGroupAdmissionWatch(directory: SharedArrayBuffer): void {
    const wake = this.groupAdmissionWatches.get(directory);
    if (!wake) return;
    this.groupAdmissionWatches.delete(directory);
    Atomics.notify(wake, 0);
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
    const controller = this.controllerFor(pid);
    if (controller?.startFailed) return controller.startFailed(error, active);
    if (runtimeChild) return;
    const stderr =
      this.children.get(pid)?.startupStderr ?? record?.image.descriptors.get(2)?.resource;
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
    this.cancelPreparations(pid);
    const child = this.children.get(pid);
    if (child && !this.roots.has(pid) && !this.reservedRoots.has(pid)) {
      if (child.finalQuiet) return;
      const terminal = this.terminalLifetimes.get(pid)?.quiesce();
      return (child.finalFence ??= Promise.all([this.imageFence(child), terminal])
        .then(() => this.joinCommandExec(child.transport))
        .then(() => {
          this.collectRuntimeProcess(pid);
          child.finalQuiet = true;
        }));
    }
    const pending = this.fences.get(pid);
    if (pending) return pending;
    const controller = this.controllerFor(pid);
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
    const controller = this.controllerFor(pid);
    const child = this.children.get(pid);
    if (child) {
      child.revokeController?.();
      return;
    }
    const captured = this.capturedControllerRevocations.get(pid);
    if (captured) {
      captured();
      return;
    }
    if (!controller || this.revokedControllers.has(pid)) return;
    this.revokedControllers.add(pid);
    if (controller.filesystem) this.options.filesystem.revoke(controller.filesystem);
    controller.revoke?.();
  }
  private processFence(pid: number): void | Promise<void> {
    const pending: Promise<void>[] = [];
    const preparation = Array.from(this.pendingPreparations).find((entry) => entry.pid === pid);
    if (preparation) pending.push(preparation.settled);
    const terminal = this.terminalLifetimes.get(pid)?.quiesce();
    if (terminal) pending.push(terminal);
    // Lazy/external roots may have no supervisor record to invoke their revocation hook.
    this.revokeController(pid);
    const controller = this.controllerFor(pid);
    const threaded = this.children.get(pid);
    if (threaded?.threads) {
      const adapterFence = controller?.quiesce?.();
      if (adapterFence) pending.push(adapterFence);
      pending.push(
        threaded.threads.then((owner) => (owner ? owner.fence() : this.quiesceChild(threaded))),
      );
      if (controller?.filesystem && controller.filesystem.sections !== threaded.filesystem.sections)
        pending.push(this.options.filesystem.quiesce(controller.filesystem));
      return Promise.all(pending).then(() => {});
    }
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
    const transport = this.transport.get(pid);
    if (transport && this.commandScope(transport))
      return Promise.all(pending).then(() => this.joinCommandExec(transport));
    if (pending.length) return Promise.all(pending).then(() => {});
  }
  private quiesceChild(child: RuntimeChild): void | Promise<void> {
    if (child.acknowledged && !child.replacementAcknowledged) return;
    return (child.quiescence ??= this.options.filesystem.quiesce(child.filesystem));
  }
  private disposeNetwork(child: RuntimeChild): void {
    try {
      child.graphics?.dispose();
    } catch (error) {
      this.report(error);
    }
    const network = child.network;
    child.network = undefined;
    try {
      network?.dispose();
    } catch (error) {
      this.report(error);
    }
  }
  private disposeNotifications(child: RuntimeChild | undefined): void {
    void child?.notifications?.dispose().catch((error) => this.report(error));
  }
  private async stopUnstartedThread(child: RuntimeChild): Promise<void> {
    await this.quiesceChild(child);
    child.nativeReturned?.();
  }
  private async stopNotifications(child: RuntimeChild, errors: unknown[]): Promise<boolean> {
    try {
      await child.notifications?.dispose();
      return true;
    } catch (error) {
      errors.push(error);
      return false;
    }
  }
  private launchState(context: object): RuntimeLaunch {
    let launch = this.launchStates.get(context);
    if (!launch) {
      launch = { active: false };
      this.launchStates.set(context, launch);
    }
    return launch;
  }
  private imageLaunches(): RuntimeLaunch[] {
    return Array.from(this.children.values(), (child) => child.launch);
  }
  private controllerFor(pid: number): ProcessController | undefined {
    return this.children.get(pid)?.controller ?? this.controllers.get(pid);
  }
  private capturedControllerStopFor(pid: number): (() => void | Promise<void>) | undefined {
    return this.children.get(pid)?.capturedControllerStop ?? this.capturedControllerStops.get(pid);
  }
  private controllerNativeStopFor(pid: number): NativeStopHandle | undefined {
    return this.children.get(pid)?.controllerNativeStop ?? this.controllerNativeStops.get(pid);
  }
  private controllerNativeReturnFor(pid: number): NativeReturnFollowers | undefined {
    return this.children.get(pid)?.controllerNativeReturn ?? this.controllerNativeReturns.get(pid);
  }
  private captureImageState(child: RuntimeChild): void {
    const pid = child.context.pid;
    if (this.roots.has(pid) || this.reservedRoots.has(pid)) return;
    child.controller = this.controllers.get(pid);
    child.controllerQuiet = this.quiescedControllers.has(pid);
    this.quiescedControllers.delete(pid);
    this.revokedControllers.delete(pid);
    child.revokeController = this.capturedControllerRevocations.get(pid);
    this.capturedControllerRevocations.delete(pid);
    child.capturedControllerStop = this.capturedControllerStops.get(pid);
    child.controllerNativeStop = this.controllerNativeStops.get(pid);
    child.controllerNativeReturn = this.controllerNativeReturns.get(pid);
    child.fence = this.fences.get(pid);
    child.controllerStopping = this.controllerStops?.get(pid);
    this.controllerStops?.delete(pid);
    this.launches?.delete(pid);
    this.pendingLaunches?.delete(pid);
    child.accesses = new WorkerExecutableAccess({
      active: () =>
        this.currentChild(child) &&
        !this.suspended &&
        !isRevoked(child.filesystem) &&
        this.options.table.get(pid)?.image.phase === "current",
      check: async (_sender, path, cwd, active) => {
        await this.options.registry.check(path, cwd, active);
        return 0;
      },
    });
    this.controllers.delete(pid);
    this.capturedControllerStops.delete(pid);
    this.controllerNativeStops.delete(pid);
    this.controllerNativeReturns.delete(pid);
    this.fences.delete(pid);
  }
  private controllerRevocation(controller: ProcessController): () => void {
    let revoked = false;
    return () => {
      if (revoked) return;
      revoked = true;
      if (controller.filesystem) this.options.filesystem.revoke(controller.filesystem);
      controller.revoke?.();
    };
  }
  private currentChild(child: RuntimeChild): boolean {
    const image = this.options.table.get(child.context.pid)?.image;
    return (
      this.children.get(child.context.pid) === child &&
      image?.generation === child.generation &&
      (image.phase === "current" || image.phase === "retiring")
    );
  }
  private canExec(transport: WorkerProcessTransport): boolean {
    const child = this.children.get(transport.pid);
    return (
      !!child?.worker &&
      this.options.table.get(transport.pid)?.processKind === "process" &&
      this.currentChild(child) &&
      !child.threads &&
      !child.stopped &&
      !child.stopping &&
      !child.failed &&
      !this.roots.has(transport.pid) &&
      !this.reservedRoots.has(transport.pid) &&
      !this.rootAdmissions.has(transport.pid) &&
      this.options.table.get(transport.pid)?.image.phase === "current" &&
      child.generation === transport.generation &&
      !this.options.table.get(transport.pid)?.image.request?.worker &&
      workerProcessDirectoryId(child.transport) === workerProcessDirectoryId(transport)
    );
  }
  private checkGuestImage(pid: number, generation?: number): void {
    const image = this.options.table.get(pid)?.image;
    if (image?.execution?.kind === "host")
      throw new ProcessError(
        ProcessErrno.NOTSUP,
        "host-only image cannot acquire a guest consumer",
      );
    if (generation !== undefined && image?.generation !== generation)
      throw new ProcessError(ProcessErrno.SRCH, "guest consumer image is no longer current");
  }
  private commitReplacement(
    pid: number,
    generation: number,
    resolved: ResolvedExecutable,
  ): { rollback(): void } | undefined {
    const child = this.children.get(pid);
    if (!child || child.generation !== generation || !this.canExec(child.transport))
      throw new ProcessError(ProcessErrno.NOTSUP, "replacement lost its owned source image");
    const image = this.options.table.require(pid).image;
    const admission = workerProcessState(child.transport).imageAdmission;
    if (controlCas(admission, 0, generation, -generation) !== generation)
      throw new ProcessError(ProcessErrno.NOTSUP, "replacement source image admission is closed");
    const current = () => this.options.table.get(pid)?.image === image && image.phase === "current";
    let membership: { rollback(): void } | undefined;
    const rollback = () => {
      if (!current()) return;
      membership?.rollback();
      controlCas(admission, 0, -generation, generation);
      if (!readOutcome(child.context.outcome)) child.replacing = false;
    };
    try {
      membership = this.closeReplacementGroup(child, resolved);
    } catch (error) {
      rollback();
      throw error;
    }
    child.replacing = true;
    return { rollback };
  }
  private closeReplacementGroup(
    child: RuntimeChild,
    resolved: ResolvedExecutable,
  ): { rollback(): void } | undefined {
    if (!child.group) return;
    if (resolved.kind !== "module" || resolved.execution?.kind !== "host")
      throw new ProcessError(
        ProcessErrno.NOTSUP,
        "shared caller requires a bound host-only target",
      );
    const directory = child.transport.directory;
    const version = directoryAdmissionVersion(directory);
    this.checkGroupIntents(child);
    commitDirectoryAdmission(directory, version);
    return child.group.closeAdmission();
  }
  private checkGroupIntents(source: RuntimeChild): void {
    const directory = source.identity.directory;
    for (const state of directoryProcesses(source.transport.directory)) {
      if (state.pid === source.context.pid) continue;
      if (this.pendingLaunches?.has(state.pid))
        throw new ProcessError(
          ProcessErrno.NOTSUP,
          "same-directory adapter acquisition is unresolved",
        );
      if (this.roots.has(state.pid)) continue;
      const child = this.children.get(state.pid);
      if (child?.launch.pending)
        throw new ProcessError(
          ProcessErrno.NOTSUP,
          "same-directory adapter acquisition is unresolved",
        );
      if (child && this.currentChild(child) && !child.failed) continue;
      const image = this.options.table.get(state.pid)?.image;
      if (image?.execution?.kind === "host") continue;
      if (controlLoad(state.confirmed) && !this.acquiredProcesses.has(state.pid)) continue;
      throw new ProcessError(ProcessErrno.NOTSUP, "same-directory group intent is unresolved");
    }
    for (const preparation of this.pendingPreparations) {
      if (preparation.pid === source.context.pid) continue;
      const root = this.roots.get(preparation.rootPid);
      if (root && workerProcessDirectoryId(root) === directory)
        throw new ProcessError(ProcessErrno.NOTSUP, "same-directory preparation is unresolved");
    }
  }
  private reportReplacementFailure(pid: number, error: unknown): void {
    const image = this.options.table.get(pid)?.image;
    if (image && this.replacementDiagnostics.has(image)) return;
    if (image) this.replacementDiagnostics.add(image);
    this.report(error);
  }
  private imageFence(child: RuntimeChild): Promise<void> {
    if (child.fence) return child.fence;
    const controller = child.controller;
    child.revokeController?.();
    const pending: (void | Promise<void>)[] = [
      child.controllerQuiet ? undefined : controller?.quiesce?.(),
    ];
    pending.push(
      child.threads
        ? child.threads.then((owner) => (owner ? owner.fence() : this.quiesceChild(child)))
        : this.quiesceChild(child),
    );
    if (controller?.filesystem && controller.filesystem.sections !== child.filesystem.sections)
      pending.push(this.options.filesystem.quiesce(controller.filesystem));
    return (child.fence = Promise.all(pending).then(() => {
      child.controllerQuiet = true;
    }));
  }
  private async stopImage(pid: number, generation: number, active: () => boolean): Promise<void> {
    const child = this.children.get(pid);
    if (!child || child.generation !== generation)
      throw new Error("replacement lost its image owner");
    await this.stopPhysical(child, true);
    if (!active()) return;
    const terminal = this.terminalLifetimes.get(pid);
    if (terminal && !(await terminal.handoff(active)) && active())
      throw new ProcessError(
        ProcessErrno.CANCELED,
        "terminal image handoff is permanently revoked",
      );
  }
  private async finalizeProcess(pid: number): Promise<void> {
    const stopped = this.imageStops.get(pid);
    if (!stopped) return;
    await stopped;
    const returned = this.nativeLaunchReturns.get(pid);
    this.nativeLaunchReturns.delete(pid);
    returned?.();
    this.observationOwners.get(pid)?.close();
    this.terminalLifetimes.get(pid)?.stopped();
    this.collectRuntimeProcess(pid);
    this.revokeRuntimeProcess(pid);
    this.imageStops.delete(pid);
    this.releaseAcquiredProcess(pid);
  }
  private stop(child: RuntimeChild): Promise<void> {
    this.observationOwners.get(child.context.pid)?.close();
    return Promise.resolve(this.stopPhysical(child)).then(() =>
      this.finalizeProcess(child.context.pid),
    );
  }
  private stopWorker(child: RuntimeChild): Promise<void> {
    return child.replacing ? this.stopNativeResources(child) : this.stop(child);
  }
  private stopPhysical(child: RuntimeChild, replacing = false): void | Promise<void> {
    if (child.stopping) return child.stopping;
    child.accesses?.dispose();
    if (child.threads) {
      child.stopping = child.threads
        .then((owner) => (owner ? owner.stop() : this.stopUnstartedThread(child)))
        .then(() => {
          child.stopped = true;
          if (this.children.get(child.context.pid) === child)
            this.children.delete(child.context.pid);
          this.retireChildController(child.context.pid, child);
        });
      this.imageStops.set(child.context.pid, child.stopping);
      return child.stopping;
    }
    const stop = async () => {
      const errors: unknown[] = [];
      if (child.replacing) await settleStop(() => this.stopAcceptedAdapter(child), errors);
      await settleStop(() => this.stopNativeResources(child), errors);
      if (errors.length) {
        // Cleanup after a failed terminate proves nothing: keep group memory and capacity.
        child.group?.failed();
        child.launched?.failed(errors);
        throw new AggregateError(errors, "Child physical stop failed");
      }
      // The launch revocation backing stays strongly owned through physical guest stop.
      child.graphics = undefined;
      child.controllerNativeStop?.imageReturned();
      if (child.replacementAcknowledged) this.options.filesystem.reap(child.filesystem);
      child.group?.stopped();
      child.launched?.stopped();
      if (this.children.get(child.context.pid) === child) this.children.delete(child.context.pid);
      // Its accepted bytes stay with the root; its unused credit returns to other writers.
      child.output?.retire();
      this.serviceTerminalOutput(child.identity.rootPid);
      this.retireChildController(child.context.pid, child);
      child.adapter = undefined;
    };
    // Select SIGKILL before the quiesce fence revokes the filesystem: a guest that notices the
    // revocation first would otherwise exit 1 instead of reporting the stop's SIGKILL (137).
    // No change once an outcome is settled; exec replacement must not end the process.
    if (!replacing && !child.replacing) this.signalStop(child.context.pid);
    const fence = replacing ? this.imageFence(child) : this.quiesceProcess(child.context.pid);
    child.stopping = (fence ? fence.then(stop) : stop()).catch((error) => {
      this.observationOwners.get(child.context.pid)?.fail(error);
      child.group?.failed();
      child.launched?.failed([error]);
      throw error;
    });
    this.imageStops.set(child.context.pid, child.stopping);
    return child.stopping;
  }
  private async stopAcceptedAdapter(child: RuntimeChild): Promise<void> {
    await child.launch.pending?.acquired;
    if (!child.adapter)
      throw new Error("replacement source has no accepted adapter cleanup handle");
    await child.adapter.terminate();
  }
  private stopNativeResources(child: RuntimeChild): Promise<void> {
    if (child.nativeStopping) return child.nativeStopping;
    const stopped = Promise.withResolvers<void>();
    child.nativeStopping = stopped.promise;
    void this.stopNativeResourcesNow(child).then(stopped.resolve, stopped.reject);
    return stopped.promise;
  }
  private async stopNativeResourcesNow(child: RuntimeChild): Promise<void> {
    if (child.replacing) await this.imageFence(child);
    if (child.stopped) return;
    child.stopped = true;
    const errors: unknown[] = [];
    this.disposeNetwork(child);
    if (child.graphics) await settleStop(() => child.graphics!.retired(), errors);
    if (child.notifications) await this.stopNotifications(child, errors);
    await settleStop(() => this.terminateWorker(child), errors);
    await settleStop(
      () => child.controllerStopping?.pending ?? child.capturedControllerStop?.(),
      errors,
    );
    await settleStop(() => child.cleanup?.(), errors);
    if (errors.length) throw new AggregateError(errors, "Child native resource stop failed");
  }
  private async terminateWorker(child: RuntimeChild): Promise<void> {
    const worker = child.worker;
    if (!worker) return;
    let ended: void | Promise<void>;
    // terminate() never stops a busy Wasm thread on iOS Safari and takes about 2 s on Chromium,
    // and on WebKit it can crash the page when it lands while the guest is still calling host
    // imports in a loop. Select SIGKILL first (no change once an outcome is settled) so a guest
    // polling runtime_proc.signal(0, 4) or its fatal checkpoint unwinds, then give it a bounded
    // time to report that it finished, so terminate() lands on an idle worker; a group owner
    // can then reuse its pages (docs/host-abi.md, "Stop polling"). Exec replacement stops an
    // old image inside its exec call and must not end the process.
    if (!child.replacing) {
      this.signalStop(child.context.pid);
      // Await only a real wait: without one, terminate() stays in this synchronous step.
      const unwinding = guestUnwound(child);
      if (unwinding) await unwinding;
    }
    try {
      ended = worker.terminate();
    } finally {
      child.group?.stopRequested();
    }
    await ended;
    worker.onmessage = null;
    worker.onerror = null;
    child.worker = undefined;
  }
  private retireChildController(pid: number, child?: RuntimeChild): void {
    if (this.reservedRoots.has(pid) || this.roots.has(pid) || (!child && this.suspended)) return;
    const controller = child?.controller ?? this.controllers.get(pid);
    if (!child) {
      this.controllers.delete(pid);
      this.capturedControllerRevocations.delete(pid);
    }
    this.quiescedControllers.delete(pid);
    this.revokedControllers.delete(pid);
    if (!child) this.fences.delete(pid);
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
    const controller = this.controllerFor(pid);
    if (!controller) return;
    const nativeStop = this.controllerNativeStopFor(pid);
    const capturedStop = nativeStop?.terminate ?? this.capturedControllerStopFor(pid);
    const terminal = capturedStop ? this.terminalLifetimes.get(pid) : undefined;
    const group = nativeStop?.membership();
    const stopping = Promise.resolve(this.quiesceProcess(pid))
      .then(() => capturedStop?.())
      .then(() => {
        terminal?.stopped();
        if (group) this.settleRootGroup(pid, group);
        this.controllerStops?.delete(pid);
        this.retireChildController(pid);
      });
    (this.controllerStops ??= new Map()).set(pid, { pending: stopping, controllerStop: true });
    return stopping;
  }
  private async retireProcess(pid: number, rejectedTransferFenced = false): Promise<void> {
    await (this.children.get(pid)?.launch.pending ?? this.pendingLaunches?.get(pid))?.acquired;
    this.observationOwners.get(pid)?.close();
    // A rejected transfer never entered a guest adapter. Its own fence is already
    // complete, and shutdown waits for that rejection before it opens the global stop gate.
    if (this.suspended && !rejectedTransferFenced) {
      await this.retirementGate.promise;
      return;
    }
    const owner = this.observationOwners.get(pid);
    const child = this.children.get(pid);
    if (child) await this.stop(child);
    else {
      await this.stopController(pid);
      await this.finalizeProcess(pid);
    }
    await owner?.join();
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
    const sig = checkedSignal(signal);
    const found = this.publishProcessSignal(pid, sig);
    const supervisor = await this.ready();
    if (this.suspended) return;
    if (supervisor.get(pid)) supervisor.observeSignal(pid, sig);
    else if (!found) supervisor.kill(pid, sig);
  }
  private publishProcessSignal(pid: number, signal: number, captured?: ProcessRecord): boolean {
    const target =
      captured ??
      this.states().find((state) => state.pid === pid)?.signals ??
      this.options.table.get(pid) ??
      this.reservedRoots.get(pid);
    if (!target) return false;
    requestSignal(target, signal);
    if (readOutcome(target.outcome)?.kind === "signaled") this.revokeRuntimeProcess(pid);
    this.wake();
    if (captured && this.supervisor?.get(pid) === captured)
      this.supervisor.observeSignal(pid, signal);
    return true;
  }
  /**
   * A physical stop's SIGKILL is a courtesy to a polling guest: if publishing it throws, the
   * stop reports that and goes on, so the worker is still fenced and terminated.
   */
  private signalStop(pid: number): void {
    try {
      this.publishStopSignal(pid);
    } catch (error) {
      this.report(error);
    }
  }
  /** Publication only, as at disposal: no revocation, supervisor callback or wake. */
  private publishStopSignal(pid: number): void {
    const target =
      this.states().find((state) => state.pid === pid)?.signals ??
      this.options.table.get(pid) ??
      this.reservedRoots.get(pid);
    if (target) this.requestSignalIfPresent(target, 9);
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
    for (const child of this.children.values()) {
      child.controller?.wake?.();
      child.wake?.();
    }
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
      this.observationOwners.get(pid)?.close();
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
    this.observationOwners.get(pid)?.close();
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
    this.cancelPreparations();
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
    for (const scope of this.commandRoots?.values() ?? []) {
      await Promise.all(scope.pending);
      const failure = this.commandCleanupFailure(scope);
      if (failure) throw failure;
    }
    const pids = new Set(
      Array.from(this.options.table.values(), (record) => record.pid).concat(
        Array.from(this.controllers.keys()),
        Array.from(this.children.keys()),
      ),
    );
    for (const pid of pids) this.quiesceProcess(pid);
    await Promise.all(
      Array.from(this.fences.values()).concat(
        Array.from(
          this.children.values(),
          (child) => child.finalFence ?? child.fence ?? Promise.resolve(),
        ),
      ),
    );
  }
  private stopDisposalController(
    pid: number,
    controller: ProcessController,
    failed: Set<ProcessController>,
  ): Promise<void> {
    this.observationOwners.get(pid)?.close();
    const stopping = this.controllerStops?.get(pid);
    // A controller's auxiliary cleanup cannot certify a separately owned launch handle
    // or generic Worker, especially when that consumer's stop has failed.
    const nativeStop = this.controllerNativeStopFor(pid);
    const capturedStop = nativeStop?.terminate ?? this.capturedControllerStopFor(pid);
    const ownsConsumer = capturedStop && !this.launches?.has(pid) && !this.children.has(pid);
    const terminal = ownsConsumer ? this.terminalLifetimes.get(pid) : undefined;
    const pending = stopping?.controllerStop
      ? stopping.pending
      : Promise.resolve().then(() => capturedStop?.());
    const group = ownsConsumer ? nativeStop?.membership() : undefined;
    return pending
      .then(() => {
        terminal?.stopped();
        if (group) this.settleRootGroup(pid, group);
        if (ownsConsumer) {
          this.rootStopped(pid);
        }
      })
      .catch((error) => {
        group?.failed();
        if (ownsConsumer) this.rootTickets.get(pid)?.failed([error]);
        failed.add(controller);
        throw error;
      });
  }
  private retireDisposedControllers(
    failed: ReadonlySet<ProcessController>,
    errors: unknown[],
  ): void {
    const retainedRoots = new Set(
      Array.from(this.children.values(), (child) => child.identity.rootPid),
    );
    for (const [pid, controller] of this.controllers) {
      if (
        failed.has(controller) ||
        retainedRoots.has(pid) ||
        this.children.has(pid) ||
        this.launches?.has(pid) ||
        this.controllerStops?.has(pid)
      )
        continue;
      try {
        controller.retired?.();
      } catch (error) {
        errors.push(error);
      }
    }
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
      await Promise.all(
        Array.from(this.pendingPreparations.values(), (preparation) => preparation.settled),
      );
      await this.quiesce();
      // A controller stop may release a physical handle, but cannot consume authority
      // before a pending launcher acquires it. Then settle both stops before retirement.
      await Promise.all(
        Array.from(this.pendingLaunches?.values() ?? [], (launch) => launch.acquired).concat(
          this.imageLaunches().map((launch) => launch.pending?.acquired ?? Promise.resolve()),
        ),
      );
      const physicalHandles = this.supervisor?.retireFencedProcesses();
      // Suspension freezes every owned pipe cursor; the filesystem fence above is still
      // mandatory. Attempt and settle every physical stop even if another consumer fails.
      const failedControllers = new Set<ProcessController>();
      const stops = Array.from(this.children.values(), (child) =>
        Promise.resolve().then(() => this.stop(child)),
      ).concat(
        Array.from(this.controllers, ([pid, controller]) =>
          this.stopDisposalController(pid, controller, failedControllers),
        ),
        Array.from(this.retainedRootStops, ([pid, controller]) =>
          this.stopDisposalController(pid, controller, failedControllers),
        ),
        Array.from(this.controllerStops?.values() ?? [], (stopping) => stopping.pending),
        Array.from(this.pendingLaunches?.values() ?? [], (launch) => launch.settled).concat(
          this.imageLaunches().map((launch) => launch.pending?.settled ?? Promise.resolve()),
        ),
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
      for (const pid of Array.from(this.imageStops.keys())) {
        try {
          await this.finalizeProcess(pid);
        } catch (error) {
          if (!errors.includes(error)) errors.push(error);
        }
      }
      for (const owner of Array.from(this.observationOwners.values())) {
        const failures = await owner.stopAll();
        for (const failure of failures) if (!errors.includes(failure)) errors.push(failure);
      }
      this.retireDisposedControllers(failedControllers, errors);
      const unsettled = this.groups?.unsettled() ?? 0;
      if (unsettled)
        errors.push(new Error(`${unsettled} memory group members have no proven physical stop`));
      if (errors.length) {
        const failure = new AggregateError(errors, "Process broker cleanup failed");
        this.retirementGate.reject(failure);
        throw failure;
      }
      this.retirementGate.resolve();
      this.reservedRoots.clear();
      this.descendantHooks.clear();
      this.signalPolicies.clear();
      this.completedRoots.clear();
      this.rootLeases.clear();
      this.roots.clear();
      this.commandRoots?.clear();
      this.outputs.clear();
      this.terminalOutputs.clear();
      this.registries.clear();
      this.controllers.clear();
      this.capturedControllerRevocations.clear();
      this.retainedRootStops.clear();
      this.controllerNativeStops.clear();
      this.capturedControllerStops.clear();
      this.controllerNativeReturns.clear();
      this.quiescedControllers.clear();
      this.revokedControllers.clear();
      this.controllerStops?.clear();
      this.launches?.clear();
      this.pendingLaunches?.clear();
      this.fences.clear();
      this.acquiredProcesses.clear();
      this.settledGroupAcquisitions.clear();
      for (const directory of this.groupAdmissionWatches.keys())
        this.cancelGroupAdmissionWatch(directory);
      for (const owner of this.observationOwners.values()) owner.close();
      this.terminalLifetimes.clear();
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

/** One accepted adapter entry, including wrappers around the borrowed native Worker handle. */
function ownedAdapterHandle(handle: ProcessHandle): ProcessHandle {
  let stopping: Promise<void> | undefined;
  const terminate = handle.terminate.bind(handle);
  return {
    terminate() {
      if (stopping) return stopping;
      const stopped = Promise.withResolvers<void>();
      stopping = stopped.promise;
      try {
        stopped.resolve(terminate());
      } catch (error) {
        stopped.reject(error);
      }
      return stopping;
    },
  };
}

function terminalPreparationError(code: TerminalFailure): ProcessError {
  const errno =
    code === "CAPACITY"
      ? ProcessErrno.AGAIN
      : code === "CANCELED" || code === "PROCESS_GONE"
        ? ProcessErrno.CANCELED
        : code === "CLOSED" || code === "EXHAUSTED"
          ? 29
          : ProcessErrno.INVAL;
  return new ProcessError(errno, `terminal preparation failed: ${code}`);
}

function rootOutput(options: RuntimeRootOptions): TerminalOutputDelivery | undefined {
  const { output, tryOutput } = options;
  if (output && tryOutput) throw new TypeError("root output and tryOutput are exclusive");
  if (tryOutput) return (target, data) => tryOutput(target, data);
  if (!output) return undefined;
  return (target, data) => {
    output(target, data);
    return data.length;
  };
}

class NativeObservationOwner {
  private readonly publish: () => void;
  private readonly key: string;
  private readonly stops = new Set<ProcessHandle>();
  private readonly finished = Promise.withResolvers<void>();
  private failure: { error: unknown } | undefined;
  private consumers = 0;
  private closed = false;
  private admitted = false;
  completed = false;
  constructor(
    transfer: ProcessObservationTransfer,
    private readonly onComplete: () => void,
    execution: boolean,
  ) {
    this.admitted = execution;
    this.publish = captureNativeReturn(transfer);
    this.key = observationKey(transfer);
    void this.finished.promise.catch(() => {});
  }
  matches(transfer: ProcessObservationTransfer): boolean {
    return this.key === observationKey(transfer);
  }
  acceptExecution(): void {
    this.admitted = true;
  }
  join(): Promise<void> {
    return this.finished.promise;
  }
  fail(error: unknown): void {
    this.failure ??= { error };
    this.finished.reject(error);
  }
  acquire(): () => void {
    if (this.closed) throw new Error("Process native consumer admission is closed");
    this.admitted = true;
    this.consumers++;
    let returned = false;
    return () => {
      if (returned) return;
      returned = true;
      this.consumers--;
      this.complete();
    };
  }
  addStop(handle: ProcessHandle): void {
    this.stops.add(handle);
  }
  removeStop(handle: ProcessHandle): void {
    this.stops.delete(handle);
  }
  async stopAll(): Promise<unknown[]> {
    this.close();
    const results = await Promise.allSettled(
      Array.from(this.stops, (handle) => Promise.resolve().then(() => handle.terminate())),
    );
    const failures = results.filter((result) => result.status === "rejected");
    const errors = failures.map((result) => result.reason);
    if (this.failure && !errors.includes(this.failure.error)) errors.push(this.failure.error);
    if (!errors.length && this.consumers !== 0)
      errors.push(new Error("Process native consumers remain pending"));
    return errors;
  }
  close(): void {
    this.closed = true;
    if (!this.admitted) {
      this.finished.resolve();
      this.onComplete();
      return;
    }
    this.complete();
  }
  private complete(): void {
    if (!this.closed || this.consumers !== 0 || this.completed) return;
    this.publish();
    this.completed = true;
    this.finished.resolve();
    this.onComplete();
  }
}
interface NativeStopHandle extends ProcessHandle {
  bindGroup(lease: MemberLease): void;
  membership(): MemberLease | undefined;
  imageReturned(): void;
  acknowledgeReturn(): void;
}
type NativeStopState =
  | { kind: "invoking"; reentrant?: ReturnType<typeof Promise.withResolvers<void>> }
  | { kind: "returned"; result: void | Promise<void> };
function ignoreNativeStopRejection(): void {}
function nativeStopHandle(
  handle: ProcessHandle,
  terminal: TerminalProcessLifetime | undefined,
  returned: (() => void) | undefined,
  closeAdmission?: () => void,
  failed?: (error: unknown) => void,
): NativeStopHandle {
  const terminate = handle.terminate;
  let state: NativeStopState | undefined;
  let group: MemberLease | undefined;
  let groupBound = false;
  let attempted = false;
  const invoke = (): void | Promise<void> => {
    try {
      return reflectApply(terminate, handle, []) as void | Promise<void>;
    } finally {
      attempted = true;
      group?.stopRequested();
    }
  };
  return {
    membership: () => group,
    bindGroup(lease) {
      if (groupBound) throw new Error("native consumer already has a memory group binding");
      groupBound = true;
      group = lease;
      if (attempted) group.stopRequested();
    },
    imageReturned() {
      if (state) return;
      state = { kind: "returned", result: undefined };
      returned?.();
      group = undefined;
    },
    acknowledgeReturn() {
      // A reentrant acknowledgement cannot erase a stop still invoking, pending or failed.
      if (state) return;
      state = { kind: "returned", result: undefined };
      closeAdmission?.();
      returned?.();
      terminal?.stopped();
      group = undefined;
    },
    terminate() {
      if (state?.kind === "returned") return state.result;
      if (state) {
        state.reentrant ??= Promise.withResolvers<void>();
        void state.reentrant.promise.catch(ignoreNativeStopRejection);
        return state.reentrant.promise;
      }
      const invoking: Extract<NativeStopState, { kind: "invoking" }> = { kind: "invoking" };
      state = invoking;
      const complete = () => {
        returned?.();
        terminal?.stopped();
        invoking.reentrant?.resolve();
        group = undefined;
      };
      const reject = (error: unknown): never => {
        group?.failed();
        failed?.(error);
        invoking.reentrant?.reject(error);
        throw error;
      };
      try {
        closeAdmission?.();
        const result = invoke();
        if (result)
          return (state = {
            kind: "returned",
            result: result.then(complete).catch(reject),
          }).result;
        complete();
        state = { kind: "returned", result: undefined };
      } catch (error) {
        group?.failed();
        failed?.(error);
        invoking.reentrant?.reject(error);
        const result = Promise.reject(error);
        void result.catch(ignoreNativeStopRejection);
        state = { kind: "returned", result };
        throw error;
      }
    },
  };
}

function observationKey(transfer: ProcessObservationTransfer): string {
  if (transfer.kind === "standalone") return `standalone:${transfer.domain}:${transfer.pid}`;
  const domain = atomicsLoad(new BigInt64ArrayConstructor(transfer.directory, 8, 1), 0);
  return `directory:${domain}:${transfer.slot}:${transfer.pid}`;
}

class NativeReturnFollowers {
  private state: { kind: "pending"; callbacks: (() => void)[] } | { kind: "returned" } = {
    kind: "pending",
    callbacks: [],
  };
  follow(callback: () => void): void {
    if (this.state.kind === "returned") return callback();
    this.state.callbacks.push(callback);
  }
  returned(): void {
    if (this.state.kind === "returned") return;
    const callbacks = this.state.callbacks;
    this.state = { kind: "returned" };
    for (let index = 0; index < callbacks.length; index++) callbacks[index]!();
  }
}
