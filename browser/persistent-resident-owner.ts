import { FilesystemClient } from "../fs/client.js";
import { PersistentBackend } from "../fs/persistent.js";
import { FilesystemService } from "../fs/service.js";
import { createFilesystemConnection } from "../fs/protocol.js";
import { FilesystemError } from "../core/filesystem.js";
import type { StorageBackend } from "../fs/storage.js";
import type { PublicationCut } from "../fs/publication.js";
import type { PublicationConfiguration, PublicationLimits } from "../fs/publication-internal.js";
import type { ResidentDescriptor } from "../fs/publication-grant.js";
import {
  acquirePublicationGuard,
  integer,
  residentDescriptor,
  text,
  type PublicationGuard,
} from "../fs/publication-attachment.js";
import { reportRuntimeStartup, type RuntimeStartupObserver } from "../fs/startup.js";
import { vfsImplementation } from "../fs/vfs-internal.js";
import { resolveVfs, VfsError } from "../fs/vfs.js";
import type { SharedFilesystemOptions } from "./shared-fs.js";
import { openFilesystemBackend } from "./filesystem-backend.js";
import { ResidentAuthorityServer } from "./publication-authority.js";

export interface SelectedPersistentWorkspace {
  readonly origin: string;
  readonly name: string;
  readonly implementation: "indexeddb" | "opfs-memory";
  readonly format: string;
}
export interface AuthorityIdentity {
  readonly instance: ResidentDescriptor["instance"];
  readonly history: PublicationCut["history"];
}
export type PersistentOwnerRequest = {
  readonly runtimeLifetime: string;
  readonly attempt: string;
  readonly selected: SelectedPersistentWorkspace;
  readonly publication: PublicationConfiguration;
} & (
  | { readonly kind: "initial-open" }
  | {
      readonly kind: "reopen-v1";
      readonly original: AuthorityIdentity;
      readonly accept: "new-history-loss-and-unknown";
    }
);
export interface V1ReopenNotice {
  readonly kind: "v1-new-history";
  readonly durablePublicationCut: "untracked";
  readonly oldCapabilities: "not-restored";
  readonly oldMutationOutcomes: "not-restored";
  readonly acknowledgedTail: "may-be-lost";
}
export interface PersistentResidentReady {
  readonly request: PersistentOwnerRequest;
  readonly identity: AuthorityIdentity;
  readonly descriptor: ResidentDescriptor;
  readonly notice: V1ReopenNotice;
}
export interface PersistentResidentOwner {
  readonly ready: Promise<PersistentResidentReady>;
  stop(): Promise<void>;
}

type Guards =
  | { readonly kind: "none" }
  | { readonly kind: "bootstrap"; readonly bootstrap: PublicationGuard }
  | {
      readonly kind: "exclusive" | "shared";
      readonly bootstrap: PublicationGuard;
      readonly continuity: PublicationGuard;
    }
  | { readonly kind: "server"; readonly server: ResidentAuthorityServer };
type OwnerState =
  | { readonly kind: "opening" }
  | { readonly kind: "ready" }
  | {
      readonly kind: "terminal";
      readonly predecessor: "opening" | "ready";
      readonly stopped: Promise<void>;
    };

export function selectPersistentWorkspace(
  options: SharedFilesystemOptions,
): SelectedPersistentWorkspace {
  const { descriptor } = resolveVfs(options, Reflect.get(options, vfsImplementation));
  if (descriptor.implementation === "memory" || !descriptor.format)
    throw new VfsError("INVALID_VFS_SETTINGS", "memory", "A persistent workspace is required");
  return Object.freeze({
    origin: text(location.origin),
    name: text(options.name ?? "waffle-workspace"),
    implementation: descriptor.implementation,
    format: descriptor.format.id,
  });
}
function snapshotLimits(limits: PublicationLimits): PublicationLimits {
  const result = {
    sessions: integer(limits.sessions),
    operations: integer(limits.operations),
    inputBytes: integer(limits.inputBytes),
    argumentBytes: integer(limits.argumentBytes),
    effectBytes: integer(limits.effectBytes),
    effects: integer(limits.effects),
    resultBytes: integer(limits.resultBytes),
    logRecords: integer(limits.logRecords),
    logBytes: integer(limits.logBytes),
    pins: integer(limits.pins),
    pinBytes: integer(limits.pinBytes),
  };
  return Object.freeze(result);
}
function snapshotRequest(request: PersistentOwnerRequest): PersistentOwnerRequest {
  const selected = Object.freeze({
    origin: text(request.selected.origin),
    name: text(request.selected.name),
    implementation: request.selected.implementation,
    format: text(request.selected.format),
  });
  if (selected.implementation !== "indexeddb" && selected.implementation !== "opfs-memory")
    throw new FilesystemError(28);
  const { descriptor } = resolveVfs({ mode: "fast", whenBusy: "wait" }, selected.implementation);
  if (selected.origin !== location.origin || selected.format !== descriptor.format?.id)
    throw new FilesystemError(28, "workspace origin or format does not match this realm");
  const observe = request.publication.observe;
  if (observe !== undefined && typeof observe !== "boolean") throw new FilesystemError(28);
  const base = {
    runtimeLifetime: text(request.runtimeLifetime),
    attempt: text(request.attempt),
    selected,
    publication: Object.freeze({ limits: snapshotLimits(request.publication.limits), observe }),
  };
  if (request.kind === "initial-open") return Object.freeze({ ...base, kind: "initial-open" });
  if (request.kind !== "reopen-v1" || request.accept !== "new-history-loss-and-unknown")
    throw new FilesystemError(28);
  return Object.freeze({
    ...base,
    kind: "reopen-v1",
    original: Object.freeze({
      instance: text(request.original.instance),
      history: text(request.original.history),
    }),
    accept: "new-history-loss-and-unknown",
  });
}
const notice: V1ReopenNotice = Object.freeze({
  kind: "v1-new-history",
  durablePublicationCut: "untracked",
  oldCapabilities: "not-restored",
  oldMutationOutcomes: "not-restored",
  acknowledgedTail: "may-be-lost",
});

class PersistentOwner implements PersistentResidentOwner {
  private readonly outcome = Promise.withResolvers<PersistentResidentReady>();
  readonly ready = this.outcome.promise;
  private state: OwnerState = { kind: "opening" };
  private guards: Guards = { kind: "none" };
  private readonly abort = new AbortController();
  private readonly opening: Promise<void>;
  private readonly openingDebts: Promise<void>[] = [];
  private readonly connection: ReturnType<typeof createFilesystemConnection>;
  private readonly root: FilesystemClient;
  private readonly workspace: string;
  private storage: StorageBackend | undefined;
  private backend: PersistentBackend | undefined;
  private service: FilesystemService | undefined;
  private readonly interrupted = () => {
    void this.stop().catch(() => {});
  };
  constructor(
    private readonly request: PersistentOwnerRequest,
    private readonly signal: AbortSignal,
    private readonly observer?: RuntimeStartupObserver,
  ) {
    const { origin, implementation, name } = request.selected;
    this.workspace = text(JSON.stringify([origin, implementation, name]));
    // Validate the complete arena before acquiring guards or opening native storage.
    this.connection = createFilesystemConnection(undefined, {
      ...request.publication,
      observe: true,
    });
    this.root = new FilesystemClient(this.connection.client);
    this.opening = Promise.resolve()
      .then(() => this.open())
      .catch((error: unknown) => {
        this.outcome.reject(error);
        void this.stop().catch(() => {});
      });
    signal.addEventListener("abort", this.interrupted, { once: true });
    if (signal.aborted) this.interrupted();
  }
  private checkLive(): void {
    if (this.state.kind !== "opening" || this.signal.aborted || this.abort.signal.aborted)
      throw new FilesystemError(11, "persistent resident attempt stopped");
  }
  private async open(): Promise<void> {
    this.checkLive();
    const bootstrap = await acquirePublicationGuard(
      `bootstrap:${this.workspace}`,
      "exclusive",
      this.abort.signal,
      true,
    );
    this.guards = { kind: "bootstrap", bootstrap };
    this.checkLive();
    const continuity = await acquirePublicationGuard(
      this.workspace,
      "exclusive",
      this.abort.signal,
      true,
    );
    this.guards = { kind: "exclusive", bootstrap, continuity };
    this.checkLive();
    const backend = await openFilesystemBackend(
      {
        mode: "fast",
        whenBusy: "wait",
        name: this.request.selected.name,
        implementation: this.request.selected.implementation,
      },
      {
        onStartupStage: this.observer,
        signal: this.abort.signal,
        retainOpeningDebt: (debt) => {
          this.openingDebts.push(debt);
        },
        retainStorage: (storage) => {
          this.storage = storage;
        },
        onOwnershipLost: this.interrupted,
      },
    );
    if (!(backend instanceof PersistentBackend)) throw new FilesystemError(58);
    this.backend = backend;
    this.checkLive();
    this.service = new FilesystemService(backend);
    this.service.connect(this.connection.server);
    const handle: number = await this.root.asyncCall("preopen", ["/"]);
    this.checkLive();
    const descriptor = Object.freeze(
      residentDescriptor(
        await this.root.asyncCall("publicationWorkspace", [
          this.root.connection.publication!.observer,
          handle,
          this.workspace,
        ]),
      ),
    );
    this.checkLive();
    const authority = this.service.residentPublication;
    if (!authority) throw new FilesystemError(58);
    const identity = Object.freeze({
      instance: authority.instance,
      history: this.root.connection.publication!.buffers.history,
    });
    if (
      this.request.kind === "reopen-v1" &&
      (identity.instance === this.request.original.instance ||
        identity.history === this.request.original.history)
    )
      throw new FilesystemError(28, "reopen did not create a fresh history");
    await continuity.release();
    this.guards = { kind: "bootstrap", bootstrap };
    this.checkLive();
    const shared = await acquirePublicationGuard(this.workspace, "shared", this.abort.signal);
    this.guards = { kind: "shared", bootstrap, continuity: shared };
    this.checkLive();
    const server = new ResidentAuthorityServer(authority, shared, bootstrap);
    this.guards = { kind: "server", server };
    const ready = Object.freeze({ request: this.request, identity, descriptor, notice });
    reportRuntimeStartup(this.observer, "filesystem-ready");
    this.checkLive();
    authority.activate();
    this.state = { kind: "ready" };
    this.outcome.resolve(ready);
  }
  stop(): Promise<void> {
    if (this.state.kind === "terminal") return this.state.stopped;
    const completion = Promise.withResolvers<void>();
    const predecessor = this.state.kind;
    this.state = { kind: "terminal", predecessor, stopped: completion.promise };
    this.outcome.reject(new FilesystemError(11, "persistent resident attempt stopped"));
    this.abort.abort();
    void this.close(predecessor).then(completion.resolve, completion.reject);
    return completion.promise;
  }
  private async close(predecessor: "opening" | "ready"): Promise<void> {
    await this.opening;
    await Promise.all(this.openingDebts);
    if (this.guards.kind === "server") await this.guards.server.drainForOwner();
    await this.service?.drainForOwner();
    if (predecessor === "ready") await this.backend?.flush();
    this.backend?.dispose();
    this.root.dispose();
    this.service?.dispose();
    this.connection.server.port.close();
    await this.storage?.close();
    await this.releaseGuards();
    this.signal.removeEventListener("abort", this.interrupted);
  }
  private async releaseGuards(): Promise<void> {
    const guards = this.guards;
    if (guards.kind === "server") await guards.server.finishStop();
    if (guards.kind === "exclusive" || guards.kind === "shared") await guards.continuity.release();
    if (guards.kind !== "none" && guards.kind !== "server") await guards.bootstrap.release();
    this.guards = { kind: "none" };
  }
}

export function createPersistentResidentOwner(
  request: PersistentOwnerRequest,
  signal: AbortSignal,
  onStartupStage?: RuntimeStartupObserver,
): PersistentResidentOwner {
  return new PersistentOwner(snapshotRequest(request), signal, onStartupStage);
}
