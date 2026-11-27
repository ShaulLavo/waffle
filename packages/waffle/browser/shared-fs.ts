import { validateMachineId } from "../core/devices.js";
import { FILESYSTEM_REQUEST_LIMITS, type FilesystemRequestPool } from "../fs/request-memory.js";
import {
  localMemory,
  localPublication,
  type PublicationConfiguration,
} from "../fs/publication-internal.js";
import { MemoryBudget } from "../fs/memory-budget.js";
import type { OperationBinding } from "./operations/protocol.js";
import { bytes, type Headroom, type RuntimeReservations } from "../memory/reservations.js";
import {
  isRevoked,
  mergeSegmentDirectories,
  CONNECTION_SHARED_BYTES,
  DEFAULT_SHARED_MAX_BYTES,
  MAX_CONNECTION_OWNERS,
  SHARED_SEGMENT_BYTES,
  FilesystemError,
  createFilesystemConnection,
  createFilesystemIdentity,
  createProcessFilesystemIdentity,
  connectFilesystemIdentity,
  revokeFilesystemService,
  revokeFilesystem,
  reapFilesystem,
  waitForFilesystemQuiescence,
  type FilesystemIdentity,
  type FilesystemConnection,
} from "../fs/protocol.js";
import { mutationValue, type PublicationAdmission } from "../fs/publication.js";
import {
  reportRuntimeStartup,
  isWorkerStartupMessage,
  type RuntimeStartupObserver,
} from "../fs/startup.js";
import { createWorkspaceVfs } from "../fs/workspace.js";
import type { WorkspaceVfs } from "../fs/workspace-types.js";
import { FilesystemClient, resolveWriteFileMode, type WriteFileMode } from "../fs/client.js";

export type { WriteFileOptions, WriteFileMode } from "../fs/client.js";

import { vfsImplementation } from "../fs/vfs-internal.js";
import {
  resolveVfs,
  VfsError,
  type VfsDescriptor,
  type VfsErrorCode,
  type VfsSelection,
} from "../fs/vfs.js";
export { getVfsDescriptor, VfsError } from "../fs/vfs.js";
export type { VfsMode, VfsDescriptor, VfsSelection, VfsWhenBusy, VfsErrorCode } from "../fs/vfs.js";

export interface DirectoryHandleLease {
  readonly handle: import("../core/filesystem.js").FileHandle;
  release(): void;
}
export type SharedFilesystemStatus = "opening" | "waiting" | "ready" | "failed" | "disposed";
export interface SharedFilesystemState {
  readonly status: SharedFilesystemStatus;
  readonly error?: Error;
}
export type SharedFilesystemStateObserver = (
  state: SharedFilesystemState,
) => void | PromiseLike<void>;

export type SharedFilesystemOptions = VfsSelection & {
  /** Allocate all-writer namespace history before the filesystem worker starts. */
  workspace?: boolean;
  [localPublication]?: PublicationConfiguration;
  [localMemory]?: MemoryBudget;
  workerURL?: string | URL;
  name?: string;
  /** Optional explicit 32-char lowercase hex machine-id(5) served via virtual `/etc/machine-id`. */
  machineId?: string;
  /** Called when startup enters or leaves the queued ownership state. */
  onStateChange?: SharedFilesystemStateObserver;
};

export type ResolvedEntry = { readonly path: string } & (
  | { readonly kind: "file" | "dir" | "socket" }
  | { readonly kind: "symlink"; readonly target: string }
);
/** Times in whole milliseconds since 1970. */
interface EntryStat {
  ino: number;
  mtime: number;
  ctime: number;
}
type LeafEntry = EntryStat &
  ({ kind: "file" } | { kind: "socket" } | { kind: "symlink"; target: string });
export interface RemoveCondition {
  /** Remove only a regular file whose bytes equal these. */
  readonly ifContent: Uint8Array;
}
export interface StatOptions {
  /** Follow a final symbolic link. Defaults to true, matching POSIX `stat`; false matches `lstat`. */
  readonly follow?: boolean;
}
/** Metadata for a single path without reading file bytes or enumerating directory children. */
export interface PathStat {
  readonly kind: "file" | "dir" | "socket" | "symlink";
  readonly size: number;
  readonly ino: number;
  /** Times in whole milliseconds since 1970. */
  readonly mtime: number;
  readonly ctime: number;
  readonly atime: number;
  readonly mode: number;
  readonly nlink: number;
  readonly target?: string;
}
export type EntryMetadata = LeafEntry | (EntryStat & { kind: "dir" });
export type Entry = LeafEntry | (EntryStat & { kind: "dir"; children: Map<string, EntryMetadata> });
export const WORKSPACE_TAKEN_OVER =
  "This workspace was opened in another tab. Reload to continue here.";
export const UNSAVED_CHANGES_LOST =
  "Unsaved changes in this tab weren't kept. Copy them before reloading.";
/** Keep concurrent host requests well below the transport outstanding quota so overflow `take`
 * follow-ups (up to one per active call) and concurrent workspace/watch traffic never exhaust it. */
const MAX_CONCURRENT_REQUESTS = Math.max(1, Math.floor(FILESYSTEM_REQUEST_LIMITS.outstanding / 4));
function workerError(data: unknown): Error | undefined {
  if (
    !data ||
    typeof data !== "object" ||
    !("type" in data) ||
    data.type !== "filesystem-error" ||
    !("message" in data) ||
    typeof data.message !== "string"
  )
    return;
  const detail = data as { name?: string; code?: VfsErrorCode; vfs?: string };
  const error =
    detail.name === "VfsError" && detail.code && typeof detail.vfs === "string"
      ? new VfsError(detail.code, detail.vfs, data.message)
      : new Error(`Filesystem worker failed: ${data.message}`);
  if (detail.name) Object.assign(error, { name: detail.name });
  if (detail.code) Object.assign(error, { code: detail.code });
  if ("stack" in data && typeof data.stack === "string")
    error.stack = `${error.message}\n${data.stack}`;
  return error;
}
function cleanupAfterFailure(actions: readonly (() => void)[]): void {
  for (const cleanup of actions) {
    try {
      cleanup();
    } catch {}
  }
}
/** Page-side API: never blocks the UI thread and owns no tree. Mutations complete in memory;
 * drain orders service requests, while flush checkpoints their data and metadata to storage.
 * Operations issued during opening/waiting remain pending until ownership and recovery finish.
 */
export class SharedFilesystem {
  readonly client: FilesystemClient;
  readonly vfs: VfsDescriptor;
  readonly workspace: WorkspaceVfs | undefined;
  private worker: Worker;
  private writes: Promise<unknown> = Promise.resolve();
  private activeRequests = 0;
  private requestWaiters: (((acquired: boolean) => void) | undefined)[] = [];
  private requestWaiterHead = 0;
  private socketAttachments = new Set<(error: Error) => void>();
  private fatal: Error | undefined;
  private _state: SharedFilesystemState = Object.freeze({ status: "opening" });
  private startupComplete = false;
  private cancellableStartup = false;
  private stopped = false;
  private readonly requestPool: FilesystemRequestPool;
  private clientStopped = false;
  private disposal?: Promise<void>;
  private finishDisposal?: (error?: Error, released?: boolean) => void;
  private _ownershipRetained = false;
  ownershipLost = false;
  onOwnershipLost?: () => void;
  onStateChange?: SharedFilesystemStateObserver;
  constructor(
    options: SharedFilesystemOptions = {},
    onStartupStage?: RuntimeStartupObserver,
    reservations?: RuntimeReservations,
  ) {
    const explicitMachineId =
      options.machineId !== undefined ? validateMachineId(options.machineId) : undefined;
    const projectionBudget = options[localMemory];
    if (projectionBudget !== undefined && !(projectionBudget instanceof MemoryBudget))
      throw new TypeError("localMemory requires a same-realm MemoryBudget");
    if (projectionBudget !== undefined && options.workspace !== true)
      throw new TypeError("localMemory requires workspace: true");
    const selection = resolveVfs(options, Reflect.get(options, vfsImplementation));
    if (options.workspace === true && selection.whenBusy === "attach")
      throw new VfsError(
        "INVALID_VFS_SETTINGS",
        selection.descriptor.implementation,
        'workspace: true cannot be combined with whenBusy: "attach"',
      );
    this.vfs = selection.descriptor;
    this.onStateChange = options.onStateChange;
    this.cancellableStartup = this.vfs.persistent;
    const construction = reservations
      ? {
          shared: reservations.buffer("filesystem-root", {
            kind: "fixed-buffer" as const,
            length: bytes(CONNECTION_SHARED_BYTES),
          }),
          arenas: reservations.arenas,
          allocateShared: (length: number, maximum?: number) =>
            reservations.buffer(
              length === MAX_CONNECTION_OWNERS * 4 ? "owner-states" : "control",
              maximum !== undefined && maximum !== length
                ? {
                    kind: "growable-buffer" as const,
                    initial: length,
                    maximum: bytes(maximum),
                  }
                : { kind: "fixed-buffer" as const, length: bytes(length) },
            ),
          allocatePublication: (length: number) =>
            reservations.buffer("workspace-publication", {
              kind: "fixed-buffer" as const,
              length: bytes(length),
            }),
        }
      : undefined;
    // The filesystem owner builds data segments later, in its own agent, where this page's
    // ledger cannot see them. Admit the whole advertised extra capacity now, once, in the place
    // the segment buffers used to be charged: after the root and before any consumer starts.
    const withdrawCapacity =
      construction && reservations
        ? reservations.dataCapacity(
            construction.shared,
            bytes(DEFAULT_SHARED_MAX_BYTES - SHARED_SEGMENT_BYTES),
          )
        : undefined;
    // Allocate transport before starting a consumer, and own both endpoints until transfer.
    const connection = this.createConnection(options, construction, withdrawCapacity);
    this.requestPool = connection.pool;
    let worker: Worker | undefined;
    let client: FilesystemClient | undefined;
    let transferred = false;
    try {
      this.worker = worker = new Worker(
        options.workerURL ?? new URL("./fs-worker.js", location.href),
        { type: "module" },
      );
      reportRuntimeStartup(onStartupStage, "filesystem-worker-created");
      this.client = client = new FilesystemClient(connection.client, {
        connect: (identity) => this.connect(identity),
      });
      if (explicitMachineId !== undefined) client.shared.setMachineId(explicitMachineId);
      this.workspace = options.workspace ? createWorkspaceVfs(client, projectionBudget) : undefined;
      worker.addEventListener("message", (event) => this.receiveMessage(event, onStartupStage));
      worker.addEventListener("error", (event) => {
        event.preventDefault();
        const error = new Error(`Filesystem worker failed: ${event.message || "uncaught error"}`);
        if (this.disposal) this.finishDisposal?.(error);
        else this.fail(error);
      });
      worker.addEventListener("messageerror", () => {
        const error = new Error("Filesystem worker message could not be decoded");
        if (this.disposal) this.finishDisposal?.(error);
        else this.fail(error);
      });
      const message: {
        connect: FilesystemConnection;
        name?: string;
        machineId?: string;
        mode: VfsDescriptor["mode"];
        implementation: VfsDescriptor["implementation"];
        whenBusy?: "takeover" | "wait" | "attach";
        observeStartup?: true;
      } = {
        connect: connection.server,
        name: options.name,
        machineId: explicitMachineId,
        mode: this.vfs.mode,
        implementation: this.vfs.implementation,
        whenBusy: selection.whenBusy,
      };
      if (onStartupStage) message.observeStartup = true;
      reportRuntimeStartup(onStartupStage, "filesystem-connect-requested");
      transferred = this.postServiceConnection(connection.server, message, [
        connection.server.port,
      ]);
    } catch (error) {
      // Constructor failure must not escape an ownerless worker or untransferred channel.
      // Cleanup failures cannot replace the startup error or prevent subsequent cleanup.
      cleanupAfterFailure([
        () => revokeFilesystemService(connection.client),
        () => client?.dispose(),
        () => connection.client.port.close(),
        () => {
          if (!transferred) connection.server.port.close();
        },
        () => worker?.terminate(),
        () => withdrawCapacity?.(),
      ]);
      throw error;
    }
  }
  private postServiceConnection(
    connection: FilesystemConnection,
    message: unknown,
    transfers: Transferable[],
  ): true {
    const sender = this.requestPool.retainServiceSender(connection.requests, connection.port);
    try {
      this.worker.postMessage(message, transfers);
      sender.transferred = true;
    } catch (error) {
      this.requestPool.cancelServiceSender(connection.requests, connection.port);
      throw error;
    }
    return true;
  }
  /** A tree whose construction fails holds no capacity promise either. */
  private createConnection(
    options: SharedFilesystemOptions,
    construction: Parameters<typeof createFilesystemConnection>[2],
    withdrawCapacity: (() => void) | undefined,
  ) {
    try {
      return createFilesystemConnection(
        undefined,
        options[localPublication] ?? (options.workspace ? { workspace: true } : undefined),
        construction,
      );
    } catch (error) {
      withdrawCapacity?.();
      throw error;
    }
  }

  get state(): SharedFilesystemState {
    return this._state;
  }
  /** Stable 32-char lowercase hex machine-id(5) served via virtual `/etc/machine-id`. */
  get machineId(): string | undefined {
    return this.client.machineId;
  }
  /** True when the filesystem worker/storage ownership could not be confirmed released. */
  ownershipRetained(): boolean {
    return this._ownershipRetained;
  }
  /** Latch disposal in a shared-host worker before Runtime.dispose() awaits filesystem.drain(). */
  beginRuntimeDispose(): void {
    if (this.stopped || this.vfs.multiTab !== "shared-host") return;
    try {
      this.worker.postMessage({ beginDispose: true });
    } catch {
      /* worker already terminated */
    }
  }
  private receiveMessage(event: MessageEvent, onStartupStage?: RuntimeStartupObserver): void {
    if (event.data?.type === "filesystem-disposed") {
      if (this.joinedReady() && "error" in event.data && typeof event.data.error !== "string")
        return;
      const released = typeof event.data.released === "boolean" ? event.data.released : undefined;
      this.finishDisposal?.(
        typeof event.data.error === "string" ? new Error(event.data.error) : undefined,
        released,
      );
      return;
    }
    if (this.stopped || (this.disposal && !this.joinedReady())) return;
    if (event.data?.type === "filesystem-ownership-lost") {
      if (this.vfs.multiTab === "shared-host") {
        this.loseOwnership();
        return;
      }
      this.ownershipLost = true;
      this.fail(new Error(`${WORKSPACE_TAKEN_OVER} ${UNSAVED_CHANGES_LOST}`));
      this.onOwnershipLost?.();
      return;
    }
    const error = workerError(event.data);
    if (error) {
      const released = typeof event.data?.released === "boolean" ? event.data.released : undefined;
      this.fail(error, released);
      return;
    }
    if (this.disposal) return;
    if (
      event.data?.type === "filesystem-state" &&
      (event.data.status === "waiting" || event.data.status === "ready")
    ) {
      if (event.data.status === "ready") this.startupComplete = true;
      this.setState(event.data.status);
      return;
    }
    if (onStartupStage && isWorkerStartupMessage(event.data)) {
      reportRuntimeStartup(onStartupStage, event.data.stage, event.data.timestamp);
    }
  }
  private setState(status: SharedFilesystemStatus, error?: Error): void {
    if (this._state.status === status && this._state.error === error) return;
    const state = error === undefined ? { status } : { status, error };
    this._state = Object.freeze(state);
    try {
      const pending = this.onStateChange?.(this._state);
      if (pending) void Promise.resolve(pending).catch(() => {});
    } catch {
      /* State observers cannot own filesystem startup or teardown. */
    }
  }
  private canCleanDisposeAfterOwnershipLoss(): boolean {
    return this.ownershipLost && this.vfs.multiTab === "shared-host" && !this._ownershipRetained;
  }
  private loseOwnership(): void {
    this.ownershipLost = true;
    const error = new Error(`${WORKSPACE_TAKEN_OVER} ${UNSAVED_CHANGES_LOST}`);
    for (const cancel of this.socketAttachments) cancel(error);
    this.fatal ??= error;
    this.abortQueuedRequests();
    if (!this.stopped) {
      revokeFilesystemService(this.client.connection);
      if (!this.joinedReady()) this.stop();
    }
    if (!this.disposal) this.setState("failed", this.fatal);
    this.onOwnershipLost?.();
  }
  private fail(error: Error, released?: boolean): void {
    for (const cancel of this.socketAttachments) cancel(error);
    if (this.stopped) return;
    if (released === false) {
      this._ownershipRetained = true;
      this.fatal ??= error;
      if (this.disposal) {
        this.finishDisposal?.(error, false);
        return;
      }
      revokeFilesystemService(this.client.connection);
      this.stopClient();
      this.setState("failed", this.fatal);
      return;
    }
    if (this.disposal && this.joinedReady()) {
      this.finishDisposal?.(error, released);
      return;
    }
    this.fatal ??= error;
    if (this.joinedReady()) {
      this.disposeReady(this.fatal);
      this.setState("failed", this.fatal);
      return;
    }
    // A process does not inherit its parent's lifetime. Publish the separate service-wide
    // revocation so even unpublished independent identities wake when this worker dies.
    revokeFilesystemService(this.client.connection);
    this.stop();
    // A failed observer can dispose reentrantly. Stop first, so it cannot start a startup
    // abort handshake with the worker that this failure is about to terminate.
    this.setState("failed", this.fatal);
  }
  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.stopClient();
    } finally {
      this.worker.terminate();
    }
  }
  private stopClient(): void {
    if (this.clientStopped) return;
    this.clientStopped = true;
    this.abortQueuedRequests();
    void this.workspace?.close().catch(() => {});
    this.client.dispose();
  }
  private assertLive(): void {
    if (this.fatal) throw this.fatal;
    if (this.disposal && this.joinedReady()) throw new FilesystemError(11);
  }
  async directoryHandle(path: string): Promise<DirectoryHandleLease> {
    this.assertLive();
    const root = await this.request("preopen", ["/"]);
    const resolved = await this.request("resolve", [root, path.replace(/^\/+/, "") || ".", true]);
    if (typeof resolved === "number") throw new FilesystemError(resolved);
    if (resolved.node === undefined) throw new FilesystemError(44);
    this.client.retain(resolved.node);
    try {
      const stat = await this.request("stat", [resolved.node]);
      if (stat.kind !== "directory") throw new FilesystemError(54);
    } catch (error) {
      this.client.release(resolved.node);
      throw error;
    }
    let retained = true;
    return {
      handle: resolved.node,
      release: () => {
        if (!retained) return;
        retained = false;
        if (!this.clientStopped) this.client.release(resolved.node);
      },
    };
  }
  async attachSocketScope(
    guest: FilesystemIdentity,
    directory: number,
  ): Promise<{ client: FilesystemClient; root: number; rootIno: number }> {
    this.assertLive();
    if (isRevoked(guest)) throw new FilesystemError(11);
    const identity = createProcessFilesystemIdentity(guest);
    delete identity.residentPublication;
    let pair;
    try {
      pair = connectFilesystemIdentity(identity, this.requestPool, undefined, null);
    } catch (error) {
      if (error instanceof FilesystemError && error.errno === 11) throw error;
      throw new FilesystemError(76);
    }
    let client: FilesystemClient | undefined;
    let channel: MessageChannel | undefined;
    let transferred = false;
    try {
      client = new FilesystemClient(pair.client);
      const reply = (channel = new MessageChannel());
      const attached = await this.socketAttachment(reply.port1, () => {
        transferred = this.postServiceConnection(
          pair.server,
          {
            connect: pair.server,
            socketScope: {
              guest: { owner: guest.owner, sections: guest.sections },
              directory,
            },
            reply: reply.port2,
          },
          [pair.server.port, reply.port2],
        );
      });
      client.adopt(attached.reservation);
      return { client, root: attached.root, rootIno: attached.rootIno };
    } catch (error) {
      cleanupAfterFailure([
        () => client?.dispose(),
        () => pair.client.port.close(),
        () => {
          if (!transferred) pair.server.port.close();
        },
        () => channel?.port1.close(),
        () => channel?.port2.close(),
      ]);
      if (isRevoked(guest)) throw new FilesystemError(11);
      throw error;
    }
  }
  private socketAttachment(
    port: MessagePort,
    send: () => void,
  ): Promise<{
    root: number;
    rootIno: number;
    reservation: import("../fs/protocol.js").FilesystemReservation;
  }> {
    let resolve!: (value: {
      root: number;
      rootIno: number;
      reservation: import("../fs/protocol.js").FilesystemReservation;
    }) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<{
      root: number;
      rootIno: number;
      reservation: import("../fs/protocol.js").FilesystemReservation;
    }>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    const finish = (error?: Error) => {
      port.close();
      this.socketAttachments.delete(finish);
      if (error) reject(error);
    };
    this.socketAttachments.add(finish);
    port.onmessage = ({ data }) => {
      finish();
      if (data.error) reject(new FilesystemError(data.error));
      else resolve(data.value);
    };
    try {
      send();
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
    return result;
  }

  createIdentity(): FilesystemIdentity {
    this.assertLive();
    return createFilesystemIdentity(this.client.connection);
  }
  fork(): FilesystemConnection {
    this.assertLive();
    return this.client.fork();
  }
  connect(identity: FilesystemIdentity, headroom: Headroom | null = null): FilesystemConnection {
    return this.#connect(identity, headroom);
  }
  /** Trusted broker path. The binding goes only to the dedicated service Worker. */
  connectObserved(
    identity: FilesystemIdentity,
    headroom: Headroom | null | undefined,
    operations: OperationBinding,
  ): FilesystemConnection {
    return this.#connect(identity, headroom ?? null, operations);
  }
  #connect(
    identity: FilesystemIdentity,
    headroom: Headroom | null,
    operations?: OperationBinding,
  ): FilesystemConnection {
    this.assertLive();
    // An identity can be older than the tree: a blocked guest creates its child's identity from
    // its own directory. This page attaches every announced segment, so a child starts with all
    // of those and reads them directly even if it never returns to its event loop.
    const current = {
      ...identity,
      segments: mergeSegmentDirectories(this.client.connection.segments, identity.segments),
    };
    const connection = connectFilesystemIdentity(current, this.requestPool, undefined, headroom);
    try {
      const message = operations
        ? { connect: connection.server, operations }
        : { connect: connection.server };
      this.postServiceConnection(connection.server, message, [connection.server.port]);
    } catch (error) {
      cleanupAfterFailure([
        () => connection.client.port.close(),
        () => connection.server.port.close(),
      ]);
      throw error;
    }
    return connection.client;
  }
  /** Cancellation is immediate, but terminate() does not establish worker death. */
  revoke(connection: FilesystemIdentity): void {
    revokeFilesystem(connection);
    this.client.sweep();
  }
  /** A guest exit acknowledgement or the admission fence below proves filesystem quiescence. */
  reap(connection: FilesystemIdentity): void {
    reapFilesystem(connection);
    this.client.sweep();
  }
  /** Revoke immediately, then wait for host critical sections before physical termination. */
  async quiesce(connection: FilesystemIdentity): Promise<void> {
    await waitForFilesystemQuiescence(connection);
    this.reap(connection);
  }
  private requestAbortError(): Error | undefined {
    if (this.fatal) return this.fatal;
    if (this.disposal || this.stopped || this.clientStopped) return new FilesystemError(11);
    const transport = this.client.transportError();
    if (transport) return transport;
    if (isRevoked(this.client.connection)) return new FilesystemError(11);
    return undefined;
  }
  private dequeueRequestWaiter(): ((acquired: boolean) => void) | undefined {
    if (!this.requestWaiters || this.requestWaiterHead >= this.requestWaiters.length)
      return undefined;
    const waiter = this.requestWaiters[this.requestWaiterHead];
    this.requestWaiters[this.requestWaiterHead] = undefined;
    this.requestWaiterHead++;
    if (this.requestWaiterHead >= this.requestWaiters.length) {
      this.requestWaiters.length = 0;
      this.requestWaiterHead = 0;
    } else if (
      this.requestWaiterHead >= 64 &&
      this.requestWaiterHead * 2 >= this.requestWaiters.length
    ) {
      this.requestWaiters = this.requestWaiters.slice(this.requestWaiterHead);
      this.requestWaiterHead = 0;
    }
    return waiter;
  }
  private abortQueuedRequests(): void {
    if (!this.requestWaiters || this.requestWaiterHead >= this.requestWaiters.length) return;
    const waiters = this.requestWaiters;
    const start = this.requestWaiterHead;
    this.requestWaiters = [];
    this.requestWaiterHead = 0;
    for (let index = start; index < waiters.length; index++) {
      waiters[index]?.(false);
    }
  }
  private acquireRequestSlot(): Promise<void> | undefined {
    const aborted = this.requestAbortError();
    if (aborted) throw aborted;
    if (this.activeRequests < MAX_CONCURRENT_REQUESTS) {
      this.activeRequests++;
      return undefined;
    }
    return this.waitForRequestSlot();
  }
  private async waitForRequestSlot(): Promise<void> {
    const acquired = await new Promise<boolean>((resolve) => {
      this.requestWaiters.push(resolve);
    });
    if (!acquired) throw this.requestAbortError() ?? new FilesystemError(11);
    const aborted = this.requestAbortError();
    if (!aborted) return;
    this.releaseRequestSlot();
    throw aborted;
  }
  private releaseRequestSlot(): void {
    if (this.requestAbortError()) {
      this.activeRequests--;
      this.abortQueuedRequests();
      return;
    }
    const next = this.dequeueRequestWaiter();
    if (next) {
      next(true);
      return;
    }
    this.activeRequests--;
  }
  private async request(
    operation: string,
    args: unknown[] = [],
    bytes?: Uint8Array,
    publication?: PublicationAdmission,
  ): Promise<any> {
    this.assertLive();
    const waiting = this.acquireRequestSlot();
    if (waiting) await waiting;
    try {
      return await this.client.asyncCall(operation, args, bytes, publication);
    } catch (error) {
      // Revocation wakes pending requests with ECANCELED. The page owns the worker's
      // actual failure, such as unavailable or corrupt browser storage.
      this.assertLive();
      throw error;
    } finally {
      this.releaseRequestSlot();
    }
  }
  private mutate(operation: string, args: unknown[], bytes?: Uint8Array): Promise<any> {
    const admission = this.client.shared.publication
      ? this.client[localPublication](operation, args, bytes ?? new Uint8Array())
      : undefined;
    const owned = admission?.kind === "admitted" ? admission.input : bytes;
    const publication = admission?.kind === "admitted" ? admission.admission : undefined;
    const result = this.writes
      .then(() =>
        admission?.kind === "duplicate"
          ? mutationValue(admission.receipt.result)
          : this.request(operation, args, owned, publication),
      )
      .finally(() => {
        if (publication) this.client.cancelPublication(publication);
      });
    // Keep ordering after an error; the returned promise delivers the failure to its caller.
    this.writes = result.catch(() => {});
    return result;
  }
  /** Wait for this page's queued mutations, without waiting for background persistence. */
  async drain(): Promise<void> {
    await this.writes;
    this.assertLive();
  }
  /** A save is durable only once both data and metadata have reached storage. */
  async flush(path?: string): Promise<void> {
    await this.drain();
    await this.request("flush", path === undefined ? [] : [path]);
  }
  /** Walk the actual tree before canonicalizing; metadata only, without reading file contents. */
  async resolvePath(path: string): Promise<ResolvedEntry | undefined> {
    await this.drain();
    return this.request("resolvePath", [path]);
  }
  /** Read metadata for a single path without reading file bytes or listing directory children. */
  async stat(path: string, options?: StatOptions): Promise<PathStat | undefined> {
    await this.drain();
    return this.request("statPath", [path, options?.follow !== false]);
  }
  async lookup(path: string): Promise<Entry | undefined> {
    await this.drain();
    return this.request("lookup", [path]);
  }
  async readFile(path: string): Promise<Uint8Array | undefined> {
    await this.drain();
    return this.request("readFile", [path]);
  }
  async listFiles(path = "/"): Promise<string[]> {
    await this.drain();
    return this.request("listFiles", [path]);
  }
  mkdirp(path: string): Promise<void> {
    return this.mutate("mkdirp", [path]);
  }
  writeFile(path: string, text: string | Uint8Array, mode: WriteFileMode = false): Promise<void> {
    const { append, exclusive } = resolveWriteFileMode(mode);
    return this.mutate(
      "writeFile",
      [path, append, exclusive],
      typeof text === "string" ? new TextEncoder().encode(text) : text,
    );
  }
  /** Removes the entry at `path` (recursively for a directory), without following a final
   * symlink. With `ifContent`, it removes only a regular file whose bytes equal it, checked and
   * removed in one filesystem step. Resolves false when nothing was removed. */
  remove(path: string, condition?: RemoveCondition): Promise<boolean> {
    if (condition === undefined) return this.mutate("remove", [path]);
    if (!(condition?.ifContent instanceof Uint8Array))
      return Promise.reject(new TypeError("remove ifContent must be a Uint8Array"));
    // Own the expected bytes now; the mutation is queued behind earlier writes.
    return this.mutate("remove", [path, true], new Uint8Array(condition.ifContent));
  }
  async move(from: string, to: string): Promise<void> {
    const error = await this.mutate("move", [from, to]);
    if (error) throw new Error(`rename failed: errno ${error}`);
  }
  private joinedReady(): boolean {
    return (
      this.startupComplete &&
      !this.client.connection.residentPublication &&
      (this.workspace !== undefined || (this.vfs.persistent && !this.client.connection.publication))
    );
  }
  private disposeReady(failure?: Error): Promise<void> {
    let resolve!: () => void;
    let reject!: (reason: unknown) => void;
    this.disposal = new Promise<void>((done, failed) => {
      resolve = done;
      reject = failed;
    }).then(
      () => {
        this._ownershipRetained = false;
        this.stop();
        this.requestPool.releaseRetired();
        this.setState("disposed");
      },
      (reason: unknown) => {
        this.fatal ??= reason instanceof Error ? reason : new Error("Filesystem disposal failed");
        this.setState("failed", this.fatal);
        throw reason;
      },
    );
    // A worker failure can own this rejection before the caller asks for disposal.
    void this.disposal.catch(() => {});
    revokeFilesystemService(this.client.connection);
    this.abortQueuedRequests();
    const quiescence = waitForFilesystemQuiescence(this.client.connection);
    void quiescence.catch((reason) => {
      this._ownershipRetained = true;
      reject(reason);
    });
    this.finishDisposal = (error, released) => {
      if (error) {
        if (released === true) {
          void quiescence.then(
            () => {
              this._ownershipRetained = false;
              this.stop();
              this.requestPool.releaseRetired();
              reject(error);
            },
            (fenceError) => {
              this._ownershipRetained = true;
              reject(fenceError);
            },
          );
          return;
        }
        this._ownershipRetained = true;
        reject(error);
        return;
      }
      // Do not adopt a pending fence: a later failure must still reject this owner.
      void quiescence.then(
        () => resolve(),
        (fenceError) => {
          this._ownershipRetained = true;
          reject(fenceError);
        },
      );
    };
    if (failure) {
      this._ownershipRetained = true;
      reject(failure);
      return this.disposal;
    }
    try {
      this.worker.postMessage({ dispose: true });
    } catch (error) {
      this._ownershipRetained = true;
      reject(error);
    }
    return this.disposal;
  }
  /** Revoke synchronously. Ready joined storage retains its original owner until the
   * service ACK and root section fence. Startup cancellation still awaits its abort ACK. */
  dispose(): Promise<void> {
    for (const cancel of this.socketAttachments) cancel(new FilesystemError(11));
    if (this.disposal) return this.disposal;
    if (this._ownershipRetained) {
      revokeFilesystemService(this.client.connection);
      this.stopClient();
      const error = this.fatal ?? new Error("Filesystem storage ownership is retained");
      this.disposal = Promise.reject(error);
      void this.disposal.catch(() => {});
      return this.disposal;
    }
    if (this.joinedReady() && !this.stopped)
      return this.disposeReady(this.canCleanDisposeAfterOwnershipLoss() ? undefined : this.fatal);
    let finish!: (error?: Error, released?: boolean) => void;
    this.disposal = new Promise<void>((resolve, reject) => {
      finish = (error, released) => {
        if (released === false) {
          this._ownershipRetained = true;
          this.stopClient();
          const failure = error ?? new Error("Filesystem storage ownership is retained");
          this.fatal ??= failure;
          this.setState("failed", this.fatal);
          reject(failure);
          return;
        }
        this._ownershipRetained = false;
        this.stop();
        if (error) {
          this.fatal ??= error;
          this.setState("failed", this.fatal);
          reject(error);
          return;
        }
        this.requestPool.releaseRetired();
        resolve();
      };
    });
    this.finishDisposal = finish;
    this.setState("disposed");
    revokeFilesystemService(this.client.connection);
    this.abortQueuedRequests();
    if (this.stopped || this.startupComplete || !this.cancellableStartup) finish();
    else {
      // Wake pending operations now; the worker is retained only to abort/close startup.
      this.stopClient();
      try {
        this.worker.postMessage({ dispose: true });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return this.disposal;
  }
}
