import { afterEach } from "bun:test";
import {
  NetHelper,
  NetNamespace,
  type NetConnect,
  type NetHelperHooks,
} from "../browser/net/helper.js";
import { createRing } from "../browser/net/ring.js";
import type { NetworkCommand, NetworkWorkerMessage } from "./network-browser-worker.js";

const teardown = new Set<() => void>();
afterEach(() => {
  for (const close of teardown) close();
});

export function networkPeer(
  namespace: NetNamespace,
  hooks: NetHelperHooks = {},
  connect?: NetConnect,
) {
  const ring = createRing();
  const helper = new NetHelper(
    ring,
    async () => {
      throw Error("No outbound fetch");
    },
    hooks,
    namespace,
    undefined,
    undefined,
    undefined,
    connect,
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
      try {
        helper.handle(data.request);
      } catch (error) {
        failures.push(String(error));
      }
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
    helper,
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
