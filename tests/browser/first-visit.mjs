import assert from "node:assert/strict";
import { createServer, request } from "node:http";

// A fresh proxy origin keeps both HTTP caches and service worker registrations empty. Delaying
// activate and resolving register() at "activating" exercises a timing browsers are allowed to use.
export async function firstVisit(context, base) {
  const upstream = new URL(base);
  const server = createServer(forwardRequest.bind(null, upstream));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  await context.addInitScript(recordFirstVisit);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = new URL(upstream.pathname + upstream.search, origin).href;
  return {
    url,
    async check(page, moduleScope = true) {
      const state = await page.evaluate(() => globalThis.__firstVisit);
      if (moduleScope) assert.ok(state.registrations.length, "first visit must register its module service worker");
      assert.ok(state.registrations.every((entry) => entry.returnedState === "activating"), JSON.stringify(state));
      assert.ok(state.workers.length, "first visit must start a Bun worker");
      if (moduleScope) assert.ok(state.workers.some((entry) => entry.scopeState), "browser engine must use its module scope");
      const premature = state.workers.filter((entry) => entry.scopeState && entry.scopeState !== "activated");
      assert.deepEqual(premature, [], "Bun worker started before its service worker finished activation");
      assert.deepEqual(state.errors, [], "first visit reported a worker error");
      // Safari can fetch the initial worker script from the network even after activation.
      // APIRequest bypasses service workers, so this cannot pass because a warm SW served it.
      const bootstrap = await context.request.get(new URL("./__bunwasm/worker.js", page.url()).href);
      assert.equal(bootstrap.status(), 200, "scoped worker bootstrap must exist on the static host");
      assert.match(bootstrap.headers()["content-type"] ?? "", /javascript/);
      assert.equal(bootstrap.headers()["cross-origin-embedder-policy"], "require-corp");
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function forwardRequest(upstream, incoming, outgoing) {
  const target = new URL(incoming.url, upstream.origin);
  const forwarded = request(target, { method: incoming.method, headers: incoming.headers }, (response) => forwardResponse(target, outgoing, response));
  forwarded.on("error", (error) => outgoing.destroy(error));
  incoming.pipe(forwarded);
}

function forwardResponse(target, outgoing, response) {
  const headers = { ...response.headers };
  delete headers["content-length"];
  outgoing.writeHead(response.statusCode, headers);
  if (!target.pathname.endsWith("/sw.js")) return void response.pipe(outgoing);
  let source = "";
  response.setEncoding("utf8");
  response.on("data", (chunk) => (source += chunk));
  response.on("end", () => outgoing.end(ACTIVATION_DELAY + source));
}

const ACTIVATION_DELAY = `self.addEventListener("activate", event => event.waitUntil(new Promise(resolve => setTimeout(resolve, 6000))));\n`;

function recordFirstVisit() {
  if (!navigator.serviceWorker) return;
  const state = (globalThis.__firstVisit = { registrations: [], workers: [], errors: [] });
  const registrations = new Map();
  const originalRegister = ServiceWorkerContainer.prototype.register;
  const activationStarted = (worker) => ["activating", "activated", "redundant"].includes(worker.state);
  ServiceWorkerContainer.prototype.register = async function (...args) {
    const registration = await originalRegister.apply(this, args);
    const worker = registration.installing ?? registration.waiting ?? registration.active;
    if (worker && !activationStarted(worker)) await new Promise((resolve) => worker.addEventListener("statechange", () => activationStarted(worker) && resolve()));
    registrations.set(registration.scope, registration);
    state.registrations.push({ scope: registration.scope, returnedState: worker?.state });
    return registration;
  };
  const NativeWorker = Worker;
  globalThis.Worker = class extends NativeWorker {
    constructor(url, options) {
      const href = new URL(url, location.href).href;
      const registration = Array.from(registrations.values()).find((entry) => href.startsWith(entry.scope));
      state.workers.push({ url: href, scopeState: registration?.active?.state });
      super(url, options);
      this.addEventListener("error", (event) => state.errors.push(event.message ?? "worker load failed"));
    }
  };
}
