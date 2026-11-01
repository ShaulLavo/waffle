import {
  bootstrapGuestWorker,
  type GuestWorkerEvent,
  type GuestWorkerRequest,
} from "../thread/guest-worker.ts";

export type FdstatAuthorityEvent =
  | GuestWorkerEvent
  | { kind: "fdstat-canaries"; count: number }
  | { kind: "fdstat-observations"; count: number };
const post = self.postMessage.bind(self);
const apply = Reflect.apply;
const define = Object.defineProperty;
const descriptor = Object.getOwnPropertyDescriptor;
let observations = 0;

function observe(target: object, key: string): void {
  const original = descriptor(target, key);
  if (!original || typeof original.value !== "function") throw new Error(`missing native ${key}`);
  const method = original.value;
  define(target, key, {
    ...original,
    value: function (this: unknown, ...args: unknown[]) {
      observations++;
      return apply(method, this, args);
    },
  });
}
function arm(): void {
  const words = new Int32Array(new SharedArrayBuffer(4));
  const view = new DataView(new SharedArrayBuffer(24));
  const bytes = new Uint8Array(24);
  observe(Atomics, "load");
  observe(Atomics, "wait");
  observe(DataView.prototype, "getBigUint64");
  observe(DataView.prototype, "setBigUint64");
  observe(MessagePort.prototype, "postMessage");
  observe(MessagePort.prototype, "close");
  observe(Object.getPrototypeOf(Uint8Array.prototype), "fill");
  const pair = new MessageChannel();
  Atomics.load(words, 0);
  Atomics.wait(words, 0, 1, 0);
  view.getBigUint64(8, true);
  view.setBigUint64(8, 1n, true);
  bytes.fill(0);
  pair.port1.postMessage(0);
  pair.port1.close();
  pair.port2.close();
  if (observations !== 8) throw new Error("fdstat native canaries did not arm");
  post({ kind: "fdstat-canaries", count: observations } satisfies FdstatAuthorityEvent);
  observations = 0;
}
self.onmessage = ({ data }: MessageEvent<GuestWorkerRequest>) => {
  self.onmessage = null;
  void bootstrapGuestWorker(data, {
    postMessage(event) {
      if (event.kind === "ready") arm();
      if (event.kind === "host-idle")
        post({ kind: "fdstat-observations", count: observations } satisfies FdstatAuthorityEvent);
      post(event);
    },
    addEventListener: (type, listener) => self.addEventListener(type, listener),
    removeEventListener: (type, listener) => self.removeEventListener(type, listener),
  });
};
