import { bootstrapGuestWorker, type GuestWorkerRequest } from "../thread/guest-worker.js";
import { ThreadWaitOwner } from "../thread/lane.js";
const nativePost = self.postMessage.bind(self);
const define = Object.defineProperty;
const arrayPush = Array.prototype.push;
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const length = Object.getOwnPropertyDescriptor(typed, "length")!;
const timers = { setTimeout, clearTimeout, setInterval, clearInterval };
function replaceNatives(): () => void {
  let canaries = 0;
  const denied = () => {
    throw new Error("guest replacement observed runtime-owned state");
  };
  Array.prototype.push = denied;
  define(typed, "length", { configurable: true, get: denied });
  define(self, "setTimeout", { configurable: true, writable: true, value: denied });
  define(self, "clearTimeout", { configurable: true, writable: true, value: denied });
  define(self, "setInterval", { configurable: true, writable: true, value: denied });
  define(self, "clearInterval", { configurable: true, writable: true, value: denied });
  const probes = [
    () => [].push(),
    () => new Uint8Array(1).length,
    () => setTimeout(() => {}, 1),
    () => clearTimeout(),
    () => setInterval(() => {}, 1),
    () => clearInterval(),
  ];
  for (const probe of probes) {
    try {
      probe();
    } catch {
      canaries++;
    }
  }
  if (canaries !== 6) throw new Error("native replacement canaries did not arm");
  nativePost({ kind: "canaries", count: canaries });
  return () => {
    Array.prototype.push = arrayPush;
    define(typed, "length", length);
    Object.assign(self, timers);
  };
}
self.onmessage = ({ data }: MessageEvent<GuestWorkerRequest>) => {
  self.onmessage = null;
  const restore = replaceNatives();
  const wait = new ThreadWaitOwner({
    thread: data.thread,
    memory: data.memory,
    waits: new Int32Array(data.waits),
    terminal: () => true,
    retain: () => () => {},
    failed(error) {
      throw error;
    },
  });
  wait.beginTerminal();
  wait.receive({ kind: "host-idle", thread: data.thread });
  void bootstrapGuestWorker(data, {
    postMessage: (event) => nativePost(event),
    addEventListener: (type, listener) => self.addEventListener(type, listener),
    removeEventListener: (type, listener) => self.removeEventListener(type, listener),
  }).finally(restore);
};
