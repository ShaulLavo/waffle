import {
  reportRuntimeStartup,
  isWorkerStartupMessage,
  type RuntimeStartupObserver,
} from "../fs/startup.js";
import {
  FilesystemClient,
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

import {
  resolveVfs,
  VfsError,
  type VfsDescriptor,
  type VfsErrorCode,
  type VfsSelection,
} from "../fs/vfs.js";
export { getVfsDescriptor, VfsError } from "../fs/vfs.js";
export type { VfsName, VfsDescriptor, VfsSelection, VfsWhenBusy, VfsErrorCode } from "../fs/vfs.js";

export type SharedFilesystemStatus = "opening" | "waiting" | "ready" | "failed" | "disposed";
export interface SharedFilesystemState {
  readonly status: SharedFilesystemStatus;
  readonly error?: Error;
}
export type SharedFilesystemStateObserver = (
  state: SharedFilesystemState,
) => void | PromiseLike<void>;

export type SharedFilesystemOptions = VfsSelection & {
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
  private finishDisposal?: (error?: Error) => void;
  ownershipLost = false;
  onOwnershipLost?: () => void;
  onStateChange?: SharedFilesystemStateObserver;
  constructor(options: SharedFilesystemOptions = {}, onStartupStage?: RuntimeStartupObserver) {
    const selection = resolveVfs(options);
    this.vfs = selection.descriptor;
    this.onStateChange = options.onStateChange;
    this.cancellableStartup = this.vfs.persistent;
    // Allocate transport before starting a consumer, and own both endpoints until transfer.
    const connection = createFilesystemConnection();
    let worker: Worker | undefined;
    let client: FilesystemClient | undefined;
    try {
      this.worker = worker = new Worker(
        options.workerURL ?? new URL("./fs-worker.js", location.href),
        { type: "module" },
      );
      reportRuntimeStartup(onStartupStage, "filesystem-worker-created");
      this.client = client = new FilesystemClient(connection.client);
      worker.addEventListener("message", (event) => {
        if (event.data?.type === "filesystem-disposed") {
          this.finishDisposal?.(
            typeof event.data.error === "string" ? new Error(event.data.error) : undefined,
          );
          return;
        }
        if (this.disposal || this.stopped) return;
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
          return;
        }
        if (event.data?.type === "filesystem-ownership-lost") {
          this.ownershipLost = true;
          this.fail(new Error(`${WORKSPACE_TAKEN_OVER} ${UNSAVED_CHANGES_LOST}`));
          this.onOwnershipLost?.();
          return;
        }
        const error = workerError(event.data);
        if (error) this.fail(error);
      });
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
        vfs: VfsDescriptor["id"];
        whenBusy?: "takeover" | "wait";
        observeStartup?: true;
      } = {
        connect: connection.server,
        name: options.name,
        vfs: this.vfs.id,
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
    this.fatal ??= error;
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
    this.client.dispose();
  }
  private assertLive(): void {
    if (this.fatal) throw this.fatal;
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
  private async request(operation: string, args: unknown[] = [], bytes?: Uint8Array): Promise<any> {
    this.assertLive();
    try {
      return await this.client.asyncCall(operation, args, bytes);
    } catch (error) {
      // Revocation wakes pending requests with ECANCELED. The page owns the worker's
      // actual failure, such as unavailable or corrupt browser storage.
      this.assertLive();
      throw error;
    }
  }
  private mutate(operation: string, args: unknown[], bytes?: Uint8Array): Promise<any> {
    const result = this.writes.then(() => this.request(operation, args, bytes));
    // Keep ordering after an error, while returning the failure to the caller that owns it.
    this.writes = result.catch((error) => {
      this.failure ??= error;
    });
    return result;
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
    return this.mutate(
      "writeFile",
      [path, append, exclusive],
      typeof text === "string" ? new TextEncoder().encode(text) : text,
    );
  }
  remove(path: string): Promise<boolean> {
    return this.mutate("remove", [path]);
  }
  async move(from: string, to: string): Promise<void> {
    const error = await this.mutate("move", [from, to]);
    if (error) throw new Error(`rename failed: errno ${error}`);
  }
  /** Revoke synchronously. While waiting for ownership, await worker-side abort and cleanup
   * before terminating so an abandoned page cannot leave a queued Web Lock request. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
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
