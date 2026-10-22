import { ownerWriteBarrier, type FilesystemWriteBarrier } from "../fs/write-barrier.js";
import { localPublication, type PublicationConfiguration } from "../fs/publication-internal.js";
import { type PublicationAdmission } from "../fs/publication.js";
import {
  reportRuntimeStartup,
  isWorkerStartupMessage,
  type RuntimeStartupObserver,
} from "../fs/startup.js";
import {
  FilesystemClient,
  FilesystemError,
  resolveWriteFileMode,
  createFilesystemConnection,
  createFilesystemIdentity,
  connectFilesystemIdentity,
  revokeFilesystemService,
  revokeFilesystem,
  reapFilesystem,
  waitForFilesystemQuiescence,
  type FilesystemIdentity,
  type FilesystemConnection,
  type WriteFileMode,
} from "../fs/index.js";

export type { WriteFileOptions, WriteFileMode } from "../fs/index.js";

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

export type SharedFilesystemStatus = "opening" | "waiting" | "ready" | "failed" | "disposed";
export interface SharedFilesystemState {
  readonly status: SharedFilesystemStatus;
  readonly error?: Error;
}
export type SharedFilesystemStateObserver = (
  state: SharedFilesystemState,
) => void | PromiseLike<void>;

export type SharedFilesystemOptions = VfsSelection & {
  [localPublication]?: PublicationConfiguration;
  workerURL?: string | URL;
  name?: string;
  /** Called when startup enters or leaves the queued ownership state. */
  onStateChange?: SharedFilesystemStateObserver;
};

export interface ResolvedEntry {
  readonly path: string;
  readonly kind: "file" | "dir";
}
export interface Entry {
  kind: "file" | "dir";
  ino: number;
  mtime: number;
  children: Map<string, Entry>;
}
export const WORKSPACE_TAKEN_OVER =
  "This workspace was opened in another tab. Reload to continue here.";
export const UNSAVED_CHANGES_LOST =
  "Unsaved changes in this tab weren't kept. Copy them before reloading.";
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
/** Page-side API: never blocks the UI thread and owns no tree. Mutations complete in memory;
 * drain orders service requests, while flush checkpoints their data and metadata to storage.
 * Operations issued during opening/waiting remain pending until ownership and recovery finish.
 */
export class SharedFilesystem {
  readonly client: FilesystemClient;
  readonly vfs: VfsDescriptor;
  private worker: Worker;
  private writes: Promise<unknown> = Promise.resolve();
  private failure: unknown;
  private fatal: Error | undefined;
  private _state: SharedFilesystemState = Object.freeze({ status: "opening" });
  private startupComplete = false;
  private cancellableStartup = false;
  private stopped = false;
  private clientStopped = false;
  private disposal?: Promise<void>;
  private nextBarrierRequest = 1;
  private barrierRequests = new Map<
    number,
    { resolve: () => void; reject: (error: unknown) => void }
  >();
  private acquiringBarrier = false;
  private finishDisposal?: (error?: Error) => void;
  ownershipLost = false;
  onOwnershipLost?: () => void;
  onStateChange?: SharedFilesystemStateObserver;
  constructor(options: SharedFilesystemOptions = {}, onStartupStage?: RuntimeStartupObserver) {
    const selection = resolveVfs(options, Reflect.get(options, vfsImplementation));
    this.vfs = selection.descriptor;
    this.onStateChange = options.onStateChange;
    this.cancellableStartup = this.vfs.persistent;
    // Allocate transport before starting a consumer, and own both endpoints until transfer.
    const connection = createFilesystemConnection(undefined, options[localPublication]);
    let worker: Worker | undefined;
    let client: FilesystemClient | undefined;
    try {
      this.worker = worker = new Worker(
        options.workerURL ?? new URL("./fs-worker.js", location.href),
        { type: "module" },
      );
      reportRuntimeStartup(onStartupStage, "filesystem-worker-created");
      this.client = client = new FilesystemClient(connection.client);
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
        mode: VfsDescriptor["mode"];
        implementation: VfsDescriptor["implementation"];
        whenBusy?: "takeover" | "wait";
        observeStartup?: true;
      } = {
        connect: connection.server,
        name: options.name,
        mode: this.vfs.mode,
        implementation: this.vfs.implementation,
        whenBusy: selection.whenBusy,
      };
      if (onStartupStage) message.observeStartup = true;
      reportRuntimeStartup(onStartupStage, "filesystem-connect-requested");
      worker.postMessage(message, [connection.server.port]);
    } catch (error) {
      // Constructor failure must not escape an ownerless worker or untransferred channel.
      // Cleanup failures cannot replace the startup error or prevent subsequent cleanup.
      for (const cleanup of [
        () => revokeFilesystemService(connection.client),
        () => client?.dispose(),
        () => connection.client.port.close(),
        () => connection.server.port.close(),
        () => worker?.terminate(),
      ]) {
        try {
          cleanup();
        } catch {}
      }
      throw error;
    }
  }

  get state(): SharedFilesystemState {
    return this._state;
  }
  private receiveMessage(event: MessageEvent, onStartupStage?: RuntimeStartupObserver): void {
    if (event.data?.type === "filesystem-write-barrier") {
      const request = this.barrierRequests.get(event.data.id);
      if (!request) return;
      this.barrierRequests.delete(event.data.id);
      if (typeof event.data.errno === "number")
        request.reject(new FilesystemError(event.data.errno));
      else request.resolve();
      return;
    }
    if (event.data?.type === "filesystem-disposed") {
      if (this.ordinaryReady() && "error" in event.data && typeof event.data.error !== "string")
        return;
      this.finishDisposal?.(
        typeof event.data.error === "string" ? new Error(event.data.error) : undefined,
      );
      return;
    }
    if (this.stopped || (this.disposal && !this.ordinaryReady())) return;
    if (event.data?.type === "filesystem-ownership-lost") {
      this.ownershipLost = true;
      this.fail(new Error(`${WORKSPACE_TAKEN_OVER} ${UNSAVED_CHANGES_LOST}`));
      this.onOwnershipLost?.();
      return;
    }
    const error = workerError(event.data);
    if (error) {
      this.fail(error);
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
  private fail(error: Error): void {
    if (this.stopped) return;
    if (this.disposal && this.ordinaryReady()) {
      this.finishDisposal?.(error);
      return;
    }
    this.fatal ??= error;
    if (this.ordinaryReady()) {
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
    for (const request of this.barrierRequests.values())
      request.reject(this.fatal ?? new FilesystemError(11));
    this.barrierRequests.clear();
    try {
      this.stopClient();
    } finally {
      this.worker.terminate();
    }
  }
  private stopClient(): void {
    if (this.clientStopped) return;
    this.clientStopped = true;
    this.client.dispose();
  }
  private assertLive(): void {
    if (this.fatal) throw this.fatal;
    if (this.disposal && this.ordinaryReady()) throw new FilesystemError(11);
  }
  createIdentity(): FilesystemIdentity {
    this.assertLive();
    return createFilesystemIdentity(this.client.connection);
  }
  fork(): FilesystemConnection {
    this.assertLive();
    return this.client.fork();
  }
  connect(identity: FilesystemIdentity): FilesystemConnection {
    this.assertLive();
    const connection = connectFilesystemIdentity(identity);
    this.client.connection.port.postMessage({ connect: connection.server }, [
      connection.server.port,
    ]);
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
  private async request(
    operation: string,
    args: unknown[] = [],
    bytes?: Uint8Array,
    publication?: PublicationAdmission,
  ): Promise<any> {
    this.assertLive();
    try {
      return await this.client.asyncCall(operation, args, bytes, publication);
    } catch (error) {
      // Revocation wakes pending requests with ECANCELED. The page owns the worker's
      // actual failure, such as unavailable or corrupt browser storage.
      this.assertLive();
      throw error;
    }
  }
  private mutate(operation: string, args: unknown[], bytes?: Uint8Array): Promise<any> {
    let completion;
    try {
      this.assertLive();
      completion = this.client.prepare(operation, args, bytes);
    } catch (error) {
      return Promise.reject(error);
    }
    const prepared = completion;
    const result = this.writes
      .then(async () => {
        this.assertLive();
        this.client.dispatch(prepared);
        return prepared.value();
      })
      .finally(() => prepared.release());
    // Keep ordering after an error, while returning the failure to the caller that owns it.
    this.writes = result.catch((error) => {
      this.failure ??= error;
    });
    return result;
  }
  private barrierRequest(operation: "acquire" | "flush" | "release", lease: number): Promise<void> {
    if (this.stopped || this.disposal || this.fatal)
      return Promise.reject(this.fatal ?? new FilesystemError(11));
    if (this.barrierRequests.size >= 4 || this.nextBarrierRequest >= Number.MAX_SAFE_INTEGER)
      return Promise.reject(new FilesystemError(6));
    const id = this.nextBarrierRequest++;
    return new Promise<void>((resolve, reject) => {
      this.barrierRequests.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ writeBarrier: { operation, id, lease } });
      } catch (error) {
        this.barrierRequests.delete(id);
        reject(error);
      }
    });
  }
  async [ownerWriteBarrier](
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<FilesystemWriteBarrier> {
    this.assertLive();
    if (options.signal?.aborted) throw new FilesystemError(11);
    if (this.acquiringBarrier) throw new FilesystemError(6);
    this.acquiringBarrier = true;
    const lease = this.nextBarrierRequest;
    const earlier = this.writes;
    const abort = () => this.worker.postMessage({ writeBarrier: { operation: "cancel", lease } });
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.barrierRequest("acquire", lease);
      await earlier;
      if (this.failure !== undefined) {
        await this.barrierRequest("release", lease);
        const failure = this.failure;
        this.failure = undefined;
        throw failure;
      }
      if (options.signal?.aborted) {
        await this.barrierRequest("release", lease);
        throw new FilesystemError(11);
      }
    } finally {
      this.acquiringBarrier = false;
      options.signal?.removeEventListener("abort", abort);
    }
    let flushing: Promise<void> | undefined;
    let releasing: Promise<void> | undefined;
    return {
      flush: () => {
        if (releasing) return Promise.reject(new FilesystemError(11));
        flushing ??= this.barrierRequest("flush", lease).finally(() => {
          flushing = undefined;
        });
        return flushing;
      },
      release: () => {
        releasing ??= this.barrierRequest("release", lease);
        return releasing;
      },
    };
  }
  /** Wait for this page's queued mutations, without waiting for background persistence. */
  async drain(): Promise<void> {
    await this.writes;
    this.assertLive();
    if (this.failure !== undefined) {
      const error = this.failure;
      this.failure = undefined;
      throw error;
    }
  }
  /** A save is durable only once both data and metadata have reached storage. */
  async flush(path?: string): Promise<void> {
    await this.drain();
    await this.request("flush", path === undefined ? [] : [path]);
  }
  /** Walk the actual tree before canonicalizing; metadata only, without reading file contents. */
  async resolvePath(path: string): Promise<ResolvedEntry | undefined> {
    // Order earlier mutations without consuming the failure owned by an explicit drain.
    await this.writes;
    return this.request("resolvePath", [path]);
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
    if (typeof text !== "string") return this.mutate("writeFile", [path, append, exclusive], text);
    try {
      this.assertLive();
      return this.client.withMutation(
        () => this.mutate("writeFile", [path, append, exclusive], new TextEncoder().encode(text)),
        utf8Size(text) * (this.client.shared.publication ? 3 : 2),
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }
  remove(path: string): Promise<boolean> {
    return this.mutate("remove", [path]);
  }
  async move(from: string, to: string): Promise<void> {
    const error = await this.mutate("move", [from, to]);
    if (error) throw new Error(`rename failed: errno ${error}`);
  }
  private ordinaryReady(): boolean {
    return (
      this.startupComplete &&
      this.vfs.persistent &&
      !this.client.connection.publication &&
      !this.client.connection.residentPublication
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
        this.stop();
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
    const quiescence = waitForFilesystemQuiescence(this.client.connection);
    void quiescence.catch(reject);
    this.finishDisposal = (error) => {
      if (error) {
        reject(error);
        return;
      }
      // Do not adopt a pending fence: a later failure must still reject this owner.
      void quiescence.then(() => resolve(), reject);
    };
    if (failure) {
      reject(failure);
      return this.disposal;
    }
    try {
      this.worker.postMessage({ dispose: true });
    } catch (error) {
      reject(error);
    }
    return this.disposal;
  }
  /** Revoke synchronously. Ready ordinary storage retains its original owner until the
   * service ACK and root section fence. Startup cancellation still awaits its abort ACK. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    if (this.ordinaryReady() && !this.stopped) return this.disposeReady(this.fatal);
    let finish!: (error?: Error) => void;
    this.disposal = new Promise<void>((resolve, reject) => {
      finish = (error) => {
        this.stop();
        if (error) reject(error);
        else resolve();
      };
    });
    this.finishDisposal = finish;
    this.setState("disposed");
    revokeFilesystemService(this.client.connection);
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

function utf8Size(text: string): number {
  let size = 0;
  for (const character of text) {
    const code = character.charCodeAt(0);
    size += character.length === 2 ? 4 : code < 128 ? 1 : code < 2048 ? 2 : 3;
  }
  return size;
}
