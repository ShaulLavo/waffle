import { createContext, runInContext } from "node:vm";
import type { NotificationRelayRequest } from "../../browser/notification-relay.js";

// Control native settlement order while executing the actual relay source, without adding a
// production observer API. This checks retained roots, not Safari's garbage collector.
export async function controlledNotificationRelay() {
  const state = new Int32Array(new SharedArrayBuffer(8));
  const words = Array.from({ length: 3 }, () => new Int32Array(new SharedArrayBuffer(4)));
  const waits: ReturnType<typeof Promise.withResolvers<string>>[] = [];
  const notices: unknown[] = [];
  const port = {
    onmessage: (_event: { data: NotificationRelayRequest }): void => {},
    postMessage(_value: unknown): void {},
    start(): void {},
    close(): void {},
  };
  const context = createContext({
    Atomics,
    Array,
    connection: { id: 1, port, state },
    waits,
    postMessage: (value: unknown) => notices.push(value),
    controlledWaiters: () => ({
      wait(cells: Int32Array, index: number, seen: number) {
        if (Atomics.load(cells, index) !== seen) return { async: false, value: "not-equal" };
        const wait = Promise.withResolvers<string>();
        waits.push(wait);
        return { async: true, value: wait.promise };
      },
      dispose() {},
    }),
  });
  const source = await Bun.file(
    new URL("../../browser/notification-worker.ts", import.meta.url),
  ).text();
  const binding = "createNotificationWaiters(import.meta.url)";
  if (source.split(binding).length !== 2) throw new Error("expected one relay wait binding");
  const script = source
    .replace(/import \{[^}]+\} from "\.\/notification-blocking-wait\.js";\n/, "")
    .replace(binding, "globalThis.controlledWaiters()");
  runInContext(new Bun.Transpiler({ loader: "ts" }).transformSync(script), context);
  runInContext(
    "globalThis.onmessage({ data: connection }); globalThis.relay = connections.get(1);",
    context,
  );
  const send = (data: NotificationRelayRequest) => port.onmessage({ data });
  send({ type: "arm", words: words.map((cells) => ({ cells, index: 0 })) });
  const park = () => send({ type: "park", values: words.map((cells) => Atomics.load(cells, 0)) });
  const dispose = () => {
    Atomics.store(state, 1, 1);
    Atomics.add(state, 0, 1);
    Atomics.notify(state, 0);
    send({ type: "dispose" });
  };
  return {
    state,
    words,
    waits,
    notices,
    park,
    dispose,
    inspect: (expression: string): unknown => runInContext(expression, context),
    async close() {
      dispose();
      for (const wait of waits) wait.resolve("ok");
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}
