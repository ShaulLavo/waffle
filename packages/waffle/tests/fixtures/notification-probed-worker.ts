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
