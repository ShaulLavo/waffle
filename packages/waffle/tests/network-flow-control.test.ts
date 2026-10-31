import { afterEach, expect, test } from "bun:test";
import { NetHelper, NetNamespace, type NetHelperHooks } from "../browser/net/helper.js";
import { networkFlowCases } from "./network-flow-cases.js";
import { createRing } from "../browser/net/ring.js";
import type { NetworkCommand, NetworkWorkerMessage } from "./network-browser-worker.js";

const teardown = new Set<() => void>();
afterEach(() => {
  for (const close of teardown) close();
});

function deliver(
  helper: NetHelper,
  request: import("../browser/net/protocol.js").NetRequest,
  failures: string[],
) {
  try {
    helper.handle(request);
  } catch (error) {
    failures.push(String(error));
  }
}

function peer(namespace: NetNamespace, hooks: NetHelperHooks = {}) {
  const ring = createRing();
  const helper = new NetHelper(
    ring,
    async () => {
      throw Error("No outbound fetch");
    },
    hooks,
    namespace,
  );
  const worker = new Worker(new URL("./network-browser-worker.ts", import.meta.url), {
    type: "module",
  });
  const ready = Promise.withResolvers<void>();
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<unknown>>>();
  const failures: string[] = [];
  let next = 0;
  worker.onmessage = ({ data }: MessageEvent<NetworkWorkerMessage>) => {
    if (data.kind === "ready") return ready.resolve();
    if (data.kind === "net") {
      deliver(helper, data.request, failures);
      return;
    }
    const call = pending.get(data.id);
    pending.delete(data.id);
    if (data.kind === "error") call?.reject(Error(data.message));
    else call?.resolve(data.value);
  };
  worker.onerror = (event) => ready.reject(Error(event.message));
  const close = () => {
    teardown.delete(close);
    worker.terminate();
    helper.dispose();
  };
  teardown.add(close);
  worker.postMessage({ kind: "init", ring });
  return {
    ready: ready.promise,
    failures,
    call(command: NetworkCommand) {
      const call = Promise.withResolvers<unknown>();
      const id = ++next;
      pending.set(id, call);
      worker.postMessage({ kind: "command", id, command });
      return call.promise;
    },
    close,
  };
}
test("actual Worker failed publication rolls back its listener before a healthy retry", async () => {
  const namespace = await NetNamespace.create();
  const bad = peer(namespace, {
    listening() {
      throw Error("Observer failed");
    },
  });
  const good = peer(namespace);
  try {
    await Promise.all([bad.ready, good.ready]);
    expect(await bad.call({ op: "listen", port: 32206 })).toBe(-1);
    expect(await good.call({ op: "listen", port: 32206 })).toBeGreaterThan(0);
    expect(bad.failures).toEqual(["Error: Observer failed"]);
  } finally {
    bad.close();
    good.close();
    namespace.dispose();
  }
}, 5000);

test.each([false, true])(
  "actual Worker HTTP credit, read wakeups, EOF and cancellation, same helper=%s",
  async (sameHelper) => {
    const namespace = await NetNamespace.create();
    const server = peer(namespace),
      client = sameHelper ? server : peer(namespace);
    try {
      await Promise.all([server.ready, client.ready]);
      const acceptedWithoutReads = await networkFlowCases(server, client, 32207);
      expect(acceptedWithoutReads).toBeLessThanOrEqual((1 << 20) + (512 << 10));
    } finally {
      server.close();
      client.close();
      namespace.dispose();
    }
  },
  5000,
);
