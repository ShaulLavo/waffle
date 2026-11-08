import { startPage, cleanupStorage } from "waffle/testing/page-runner/page";
import { record } from "./protocol.js";
declare global {
  interface Window {
    __workerControl: {
      stage: string;
      calls: number;
      staleCalls: number;
      release: () => void;
      held?: ServiceWorkerRegistration;
    };
  }
}
const config = window.__suiteConfiguration;
const mode = config.role === "case" && record(config.request) ? config.request.mode : "";
const release = Promise.withResolvers<void>();
window.__workerControl = { stage: "initial", calls: 0, staleCalls: 0, release: release.resolve };
const nativeFetch = globalThis.fetch.bind(globalThis);
const register = navigator.serviceWorker.register.bind(navigator.serviceWorker);
navigator.serviceWorker.register = async (script, options) => {
  window.__workerControl.calls++;
  if (mode === "in-flight-loss") {
    window.__workerControl.stage = "in-flight";
    await release.promise;
  }
  return register(script, options);
};
const intercepted: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = async (
  input,
  init,
) => {
  if (mode !== "delayed-ack" && mode !== "missing-ack" && mode !== "collision-after")
    return nativeFetch(input, init);
  const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  const response = await nativeFetch(input, init);
  if (!record(body) || body.kind !== "allocation") return response;
  window.__workerControl.stage = "ack-held";
  await release.promise;
  return response;
};
Object.defineProperty(globalThis, "fetch", {
  value: intercepted,
  configurable: true,
  writable: true,
});
async function activated(registration: ServiceWorkerRegistration) {
  for (let i = 0; i < 300; i++) {
    if (registration.active?.state === "activated") return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Control worker did not activate");
}
startPage<{ mode: string }>({
  list: async () => ["worker"],
  async run(request, _allocate, context) {
    const capability = context.serviceWorker;
    if (!capability) throw new Error("Missing worker capability");
    const registration = await capability.register();
    if ((await capability.register()) !== registration)
      throw new Error("Worker attempt not memoized");
    await activated(registration);
    window.__workerControl.held = registration;
    const original = registration.unregister.bind(registration);
    registration.unregister = () => {
      window.__workerControl.staleCalls++;
      return original();
    };
    if (capability.controls(registration, null)) throw new Error("Null controller accepted");
    window.__workerControl.stage = "registered";
    await release.promise;
    if (request.mode === "controller-mismatch") {
      if (!navigator.serviceWorker.controller?.scriptURL.endsWith("/root-sw.js"))
        throw new Error("Non-null foreign root controller control did not arm");
      for (let i = 0; i < 300; i++) {
        if (capability.controls(registration, navigator.serviceWorker.controller))
          throw new Error("Foreign root controller accepted");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    } else if (
      !capability.controls(registration, navigator.serviceWorker.controller) &&
      request.mode === "success"
    ) {
      throw new Error("Intended active controller not bound");
    }
    await capability.unregister(registration);
    return { calls: window.__workerControl.calls };
  },
  finish: cleanupStorage,
});
