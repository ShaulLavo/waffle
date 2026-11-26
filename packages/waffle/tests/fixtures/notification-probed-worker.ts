import "../../browser/notification-worker.js";
import type { NotificationConnection } from "../../browser/notification-relay.js";
import type { NotificationBlockingRequest } from "../../browser/notification-blocking-wait.js";

// Keep the production handler, including its real blocking child Workers. Probes
// share that realm so page progress cannot stand in for relay progress.
const production = globalThis.onmessage;
const timer = globalThis.setTimeout;
const send = Worker.prototype.postMessage;
let registrations = 0;
let timers = 0;
const sources = new Map<Worker, number>();
Worker.prototype.postMessage = function (
  message: unknown,
  options?: Transferable[] | StructuredSerializeOptions,
) {
  if (message && typeof message === "object" && "type" in message && message.type === "wait") {
    registrations++;
    sources.set(this, (sources.get(this) ?? 0) + 1);
  }
  return Reflect.apply(send, this, [message, options]);
};
globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
  timers++;
  return Reflect.apply(timer, globalThis, args);
}) as typeof setTimeout;

globalThis.onmessage = (
  event: MessageEvent<NotificationConnection | NotificationBlockingRequest | { probe: string }>,
) => {
  const data = event.data;
  if (!("probe" in data)) {
    if ("port" in data) answerSyncs(data.port);
    if (production) Reflect.apply(production, globalThis, [event]);
    return;
  }
  if (data.probe === "timer") {
    const start = performance.now();
    timer(() => report("timer", performance.now() - start), 25);
    globalThis.postMessage({ type: "entered" });
    return;
  }
  report(data.probe);
};

function report(type: string, elapsed?: number): void {
  globalThis.postMessage({
    type,
    registrations,
    timers,
    sources: Array.from(sources.values()),
    elapsed,
  });
}

const portHandler = Object.getOwnPropertyDescriptor(MessagePort.prototype, "onmessage")!;

/** Answers `{ type: "probe-sync" }` on a connection's own port, in order with its other
 * requests: the reply proves the production relay has handled every earlier message. */
function answerSyncs(port: MessagePort): void {
  let handler: ((event: MessageEvent) => void) | null = null;
  Object.defineProperty(port, "onmessage", {
    configurable: true,
    get: () => handler,
    set(value: ((event: MessageEvent) => void) | null) {
      handler = value;
      portHandler.set!.call(port, (event: MessageEvent) => {
        if ((event.data as { type?: unknown } | null)?.type === "probe-sync") {
          port.postMessage({ type: "synced", registrations });
          return;
        }
        handler?.(event);
      });
    },
  });
}
