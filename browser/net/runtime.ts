import { NetHelper, NetNamespace, type NetFetch, type NetHelperHooks } from "./helper.js";
import { CAPACITY } from "./ring.js";

export type RuntimeNetworkHelper = Pick<
  NetHelper,
  "handle" | "dispose" | "listenerFor" | "request" | "connect" | "notifyFileChanged" | "changeFile"
>;
export interface RuntimeNetwork {
  createHelper(options: {
    readonly ring: SharedArrayBuffer;
    readonly fetch: NetFetch;
    readonly hooks?: NetHelperHooks;
  }): RuntimeNetworkHelper;
}

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
  return { ring, fetch, hooks: { listening, stopped } };
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
export function createRuntimeNetwork(assertLive: () => void) {
  const namespace = new NetNamespace();
  const helpers = new Map<NetHelper, RuntimeNetworkHelper>();
  const network: RuntimeNetwork = Object.freeze({
    createHelper(options: Parameters<RuntimeNetwork["createHelper"]>[0]) {
      assertLive();
      const captured = snapshot(options);
      assertLive();
      const helper = new NetHelper(captured.ring, captured.fetch, captured.hooks, namespace);
      const capability = project(helper, assertLive, () => helpers.delete(helper));
      helpers.set(helper, capability);
      return capability;
    },
  });
  return {
    network,
    dispose() {
      releaseHelpers(helpers);
    },
  };
}
