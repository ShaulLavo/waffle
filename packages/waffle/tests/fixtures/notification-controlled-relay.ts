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
    connection: { port, state },
    waits,
    postMessage: (value: unknown) => notices.push(value),
    controlledWait: () => {
      const wait = Promise.withResolvers<string>();
      waits.push(wait);
      return { async: true, value: wait.promise };
    },
  });
  const source = await Bun.file(
    new URL("../../browser/notification-worker.ts", import.meta.url),
  ).text();
  const binding = 'import { atomicsWaitAsync } from "../proc/intrinsics.js";';
  if (source.split(binding).length !== 2) throw new Error("expected one relay wait binding");
  const script = source.replace(binding, "const atomicsWaitAsync = globalThis.controlledWait;");
  runInContext(new Bun.Transpiler({ loader: "ts" }).transformSync(script), context);
  runInContext("globalThis.onmessage({ data: connection })", context);
  port.onmessage({ data: { type: "arm", words: words.map((cells) => ({ cells, index: 0 })) } });
  const dispose = () => {
    Atomics.store(state, 1, 1);
    Atomics.add(state, 0, 1);
    Atomics.notify(state, 0);
    port.onmessage({ data: { type: "dispose" } });
  };
  return {
    state,
    waits,
    notices,
    dispose,
    inspect: (expression: string): unknown => runInContext(expression, context),
    async close() {
      dispose();
      for (const wait of waits) wait.resolve("ok");
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}
