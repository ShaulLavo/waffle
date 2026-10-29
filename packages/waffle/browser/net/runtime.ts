import { NetHelper, NetNamespace, type NetFetch, type NetHelperHooks } from "./helper.js";
import { CAPACITY } from "./ring.js";
import type { FileHandle } from "../../core/filesystem.js";
import type { FilesystemIdentity } from "../../fs/protocol.js";
import {
  errnoOf,
  filesystemScope,
  PathCleanup,
  type AttachedSocketScope,
  type HelperPaths,
  type SocketScope,
} from "./unix-paths.js";
import { ECANCELED, ENOTCAPABLE } from "./unix-status.js";
import {
  lookupAddress,
  type RuntimeNetworkLookupOptions,
  type RuntimeNetworkLookupResult,
} from "./address.js";

export type RuntimeNetworkHelper = Pick<
  NetHelper,
  "handle" | "dispose" | "listenerFor" | "request" | "connect" | "notifyFileChanged" | "changeFile"
>;
/** A guest's filesystem identity and a directory its own capability table holds. Pathname
 * sockets resolve inside that directory. Authenticated on the helper's first path request. */
export interface RuntimeNetworkPathScope {
  readonly filesystem: FilesystemIdentity;
  readonly directory: FileHandle;
}
export interface RuntimeNetwork {
  lookup(hostname: string, options?: RuntimeNetworkLookupOptions): RuntimeNetworkLookupResult[];
  createHelper(options: {
    readonly ring: SharedArrayBuffer;
    readonly fetch: NetFetch;
    readonly hooks?: NetHelperHooks;
    /** Without a scope, every pathname socket call fails with ENOTCAPABLE. */
    readonly pathScope?: RuntimeNetworkPathScope;
  }): RuntimeNetworkHelper;
}
/** Trusted page-side attach. Rejects with a FilesystemError errno for a pair it cannot authenticate. */
export type AttachSocketScope = (
  guest: FilesystemIdentity,
  directory: FileHandle,
) => Promise<AttachedSocketScope>;

function snapshot(options: Parameters<RuntimeNetwork["createHelper"]>[0]) {
  const ring = options.ring;
  const fetch = options.fetch;
  const hooks = options.hooks;
  const listening = hooks?.listening;
  const stopped = hooks?.stopped;
  if (!(ring instanceof SharedArrayBuffer) || ring.byteLength < CAPACITY + 32)
    throw new TypeError("Networking requires a Waffle ring");
  if (typeof fetch !== "function") throw new TypeError("Network fetch policy is required");
  if (listening !== undefined && typeof listening !== "function")
    throw new TypeError("Network listening hook must be a function");
  if (stopped !== undefined && typeof stopped !== "function")
    throw new TypeError("Network stopped hook must be a function");
  return {
    ring,
    fetch,
    hooks: { listening, stopped },
    pathScope: snapshotScope(options.pathScope),
  };
}

function snapshotScope(scope: RuntimeNetworkPathScope | undefined) {
  if (scope === undefined) return undefined;
  if (!scope || typeof scope !== "object")
    throw new TypeError("Network path scope must be an object");
  const filesystem = scope.filesystem;
  const directory = scope.directory;
  if (!filesystem || typeof filesystem !== "object")
    throw new TypeError("Network path scope requires a filesystem identity");
  if (!Number.isSafeInteger(directory) || directory < 0)
    throw new TypeError("Network path scope requires a directory handle");
  return Object.freeze({ filesystem, directory });
}

/** One helper's lazily attached scope. Attach failures are final for that helper. */
function helperPaths(
  cleanup: PathCleanup,
  scope: RuntimeNetworkPathScope | undefined,
  attach: AttachSocketScope | undefined,
): HelperPaths {
  let attached: Promise<SocketScope | number> | undefined;
  let retired = false;
  return {
    cleanup,
    scope() {
      if (retired) return Promise.resolve(ECANCELED);
      if (!scope || !attach) return Promise.resolve(ENOTCAPABLE);
      // Not joined by disposal. The filesystem may already have admitted the scope session
      // and its root reservation when the reply is late; the filesystem service owns that
      // undelivered session, cancels the pending attach and tears the session down when it
      // closes after the network. A reply that does arrive is closed through retire().
      attached ??= attach(scope.filesystem, scope.directory).then(filesystemScope, errnoOf);
      return attached;
    },
    retire() {
      if (retired) return;
      retired = true;
      void attached?.then((value) => {
        if (typeof value !== "number") cleanup.retire(value);
      });
    },
  };
}

function project(
  helper: NetHelper,
  assertLive: () => void,
  release: () => void,
): RuntimeNetworkHelper {
  let closed = false;
  const live = () => {
    assertLive();
    if (closed) throw new Error("Network helper is disposed");
  };
  return Object.freeze({
    handle(request) {
      live();
      helper.handle(request);
    },
    dispose() {
      if (closed) return;
      closed = true;
      release();
      helper.dispose();
    },
    listenerFor(port) {
      live();
      return helper.listenerFor(port);
    },
    request(port, request, sink) {
      live();
      return helper.request(port, request, sink);
    },
    connect(port, sink) {
      live();
      return helper.connect(port, sink);
    },
    notifyFileChanged(path) {
      live();
      return helper.notifyFileChanged(path);
    },
    changeFile(path, contents) {
      live();
      return helper.changeFile(path, contents);
    },
  } satisfies RuntimeNetworkHelper);
}

function releaseHelpers(helpers: Map<NetHelper, RuntimeNetworkHelper>): void {
  const failures: unknown[] = [];
  for (const capability of Array.from(helpers.values())) {
    try {
      capability.dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Network disposal failed");
}

/** Runtime-only owner. Consumers receive just the frozen network/helper projections. */
export function createRuntimeNetwork(assertLive: () => void, attach?: AttachSocketScope) {
  const namespace = new NetNamespace();
  const cleanup = new PathCleanup();
  const helpers = new Map<NetHelper, RuntimeNetworkHelper>();
  const network: RuntimeNetwork = Object.freeze({
    createHelper(options: Parameters<RuntimeNetwork["createHelper"]>[0]) {
      assertLive();
      const captured = snapshot(options);
      assertLive();
      const helper = new NetHelper(
        captured.ring,
        captured.fetch,
        captured.hooks,
        namespace,
        assertLive,
        (hostname, options) => network.lookup(hostname, options),
        helperPaths(cleanup, captured.pathScope, attach),
      );
      const capability = project(helper, assertLive, () => helpers.delete(helper));
      helpers.set(helper, capability);
      return capability;
    },
    lookup(hostname: string, options?: RuntimeNetworkLookupOptions) {
      assertLive();
      const results = lookupAddress(hostname, options);
      assertLive();
      return results;
    },
  });
  return {
    network,
    /** Socket cleanup still needs the filesystem after a failed dispose. */
    retained: () => cleanup.retained(),
    /** Rejects while socket cleanup is unsettled; the caller must keep the filesystem alive.
     * Retained cleanup is retried by the next call. */
    async dispose(): Promise<void> {
      const failures: unknown[] = [];
      try {
        releaseHelpers(helpers);
      } catch (error) {
        failures.push(error);
      }
      try {
        await cleanup.dispose();
      } catch (error) {
        failures.push(error);
      }
      try {
        namespace.dispose();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, "Network disposal failed");
    },
  };
}
