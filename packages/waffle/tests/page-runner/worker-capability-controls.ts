import { runPageSuite, type SuiteAdapter } from "waffle/testing/page-runner";
import { PlaywrightDriver } from "waffle/testing/page-runner/playwright";
import { browserBundle } from "../browser-runner-lifecycle.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { record } from "./protocol.js";

export const workerControlModes = [
  "success",
  "nested-script",
  "delayed-ack",
  "missing-ack",
  "collision-before",
  "collision-after",
  "replacement",
  "in-place",
  "settled-loss",
  "in-flight-loss",
  "controller-mismatch",
  "absent-current",
];
const installingWorker = `const identity = crypto.randomUUID(); self.addEventListener('message', e => e.ports[0]?.postMessage(identity)); self.addEventListener('install', e => e.waitUntil(self.skipWaiting())); self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));`;
const foreignWorker = `const identity = crypto.randomUUID(); self.addEventListener('install', e => e.waitUntil(self.skipWaiting())); self.addEventListener('activate', e => e.waitUntil(self.clients.claim())); self.addEventListener('message', e => e.ports[0]?.postMessage(identity));`;
function assert(value: unknown, detail: string): asserts value {
  if (!value) throw new Error(detail);
}
class ControlDriver extends PlaywrightDriver {
  origin = "";
  scope = "";
  rootIdentity = "";
  foreignIdentity = "";
  verified = false;
  constructor(
    engine: "chromium" | "webkit",
    scratch: string,
    readonly mode: string,
  ) {
    super(engine, scratch);
  }
  override async navigate(url: string, signal: AbortSignal): Promise<void> {
    const parsed = new URL(url);
    if (!this.origin) {
      this.origin = parsed.origin;
      await super.navigate(this.origin + "/foreign.html", signal);
      this.rootIdentity = String(
        await this.script(
          `return (async () => { const r = await navigator.serviceWorker.register('/root-sw.js', {scope:'/'}); while(r.active?.state !== 'activated') await new Promise(r=>setTimeout(r,5)); const ch = new MessageChannel(); const id = new Promise(r=>ch.port1.onmessage=e=>r(e.data)); r.active.postMessage('id',[ch.port2]); return await id; })()`,
          signal,
        ),
      );
    }
    if (!parsed.pathname.startsWith("/_waffle_owned/")) {
      if (this.scope && ["replacement", "in-place", "absent-current"].includes(this.mode))
        assert(
          (await this.script("return window.__workerControl.staleCalls", signal)) === 0,
          "Stale held object unregister was invoked",
        );
      return super.navigate(url, signal);
    }
    this.scope = new URL("./", url).href;
    if (this.mode === "collision-before") await this.installForeign(signal, false);
    await super.navigate(url, signal);
    if (this.mode === "collision-before") return;
    if (["delayed-ack", "missing-ack", "collision-after"].includes(this.mode)) {
      await this.stage("ack-held", signal);
      assert(
        (await this.script("return window.__workerControl.calls", signal)) === 0,
        "Registration began before allocation ACK",
      );
      if (this.mode === "missing-ack") throw new Error("Control cancels while ACK is held");
      if (this.mode === "collision-after") await this.installForeign(signal, false);
      await this.script("window.__workerControl.release(); return null", signal);
      if (this.mode === "collision-after") return;
    }
    if (this.mode === "in-flight-loss") {
      await this.stage("in-flight", signal);
      await super.navigate(this.origin + "/foreign.html", signal);
      throw new Error("Control lost initiating document before settlement");
    }
    await this.stage("registered", signal);
    if (this.mode === "replacement")
      assert(
        (await this.script(
          "return navigator.serviceWorker.controller === window.__workerControl.held.active",
          signal,
        )) === true,
        "A does not control its retained client",
      );
    if (["replacement", "in-place", "absent-current"].includes(this.mode))
      await this.installForeign(signal, true);
    if (this.mode === "settled-loss") {
      await super.navigate(this.origin + "/foreign.html", signal);
      throw new Error("Control lost initiating document after settlement");
    }
    await this.script("window.__workerControl.release(); return null", signal);
  }
  private async stage(stage: string, signal: AbortSignal): Promise<void> {
    for (let i = 0; i < 300; i++) {
      if (
        (await this.script(
          `return window.__workerControl?.stage === ${JSON.stringify(stage)}`,
          signal,
        )) === true
      )
        return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Missing real worker stage ${stage}`);
  }
  private async installForeign(signal: AbortSignal, held: boolean): Promise<void> {
    const handle = await this.createWindow(signal);
    await this.selectWindow(handle, signal);
    try {
      await super.navigate(this.origin + "/foreign.html", signal);
      const identity = await this.script(
        `return (async () => { const scope = ${JSON.stringify(this.scope)}; const current = (await navigator.serviceWorker.getRegistrations()).find(r=>r.scope===scope); ${this.mode === "in-place" ? "" : "if(current) await current.unregister();"} ${this.mode === "absent-current" ? "return true;" : "const r = await navigator.serviceWorker.register('/foreign-sw.js',{scope}); while(r.active?.state !== 'activated' || !r.active.scriptURL.endsWith('/foreign-sw.js')) await new Promise(r=>setTimeout(r,5)); const ch = new MessageChannel(); const id = new Promise(resolve=>ch.port1.onmessage=e=>resolve(e.data)); r.active.postMessage('id',[ch.port2]); return await id;"} })()`,
        signal,
      );
      if (typeof identity === "string") this.foreignIdentity = identity;
    } finally {
      await this.closeWindow(signal);
      await this.selectWindow("root", signal);
    }
    if (held && this.mode === "replacement")
      assert(
        (await this.script(
          "return window.__workerControl.held.active.scriptURL.includes('owned-sw.js')",
          signal,
        )) === true,
        "Stale A worker identity was not retained",
      );
  }
  override async stop() {
    const signal = AbortSignal.timeout(5000);
    let failure: unknown;
    try {
      if (this.origin) await this.verifyCleanup(signal);
    } catch (error) {
      failure = error;
    }
    const cleanup = await super.stop();
    if (failure) throw failure;
    return cleanup;
  }
  private async verifyCleanup(signal: AbortSignal): Promise<void> {
    await super.navigate(this.origin + "/foreign.html", signal);
    const value = await this.script(
      `return (async () => { const regs = await navigator.serviceWorker.getRegistrations(); const root = regs.find(r=>r.scope===location.origin+'/'); const owned = regs.find(r=>r.scope===${JSON.stringify(this.scope)}); const ch = new MessageChannel(); const id = new Promise(r=>ch.port1.onmessage=e=>r(e.data)); root.active.postMessage('id',[ch.port2]); const rootIdentity = await id; let foreignIdentity = null; if(owned?.active) { const other = new MessageChannel(); const value = new Promise(resolve=>other.port1.onmessage=e=>resolve(e.data)); owned.active.postMessage('id',[other.port2]); foreignIdentity = await value; } const result = {root:rootIdentity, foreignIdentity, current:owned?.active?.scriptURL ?? null}; for(const r of regs) await r.unregister(); return result; })()`,
      signal,
    );
    assert(record(value) && value.root === this.rootIdentity, "Foreign root active Worker changed");
    const foreign = ["collision-before", "collision-after", "replacement", "in-place"].includes(
      this.mode,
    );
    const unknownOperation = this.mode === "in-flight-loss";
    assert(
      foreign
        ? typeof value.current === "string" && value.current.endsWith("/foreign-sw.js")
        : value.current === null ||
            (unknownOperation &&
              typeof value.current === "string" &&
              value.current.includes("/owned-sw.js?waffle-run=")),
      `Wrong exact-scope cleanup: ${JSON.stringify(value)}`,
    );
    if (foreign)
      assert(
        value.foreignIdentity === this.foreignIdentity,
        "Foreign B active Worker identity changed",
      );
    this.verified = true;
  }
}
export async function workerCapabilityControl(
  engine: "chromium" | "webkit",
  mode: string,
  root: string,
): Promise<void> {
  let driver: ControlDriver | undefined;
  const script = mode === "nested-script" ? "/assets/owned-sw.js" : "/owned-sw.js";
  const a: SuiteAdapter<{ mode: string }> = {
    suite: "worker-capability",
    inventory: () => [{ id: "worker", label: mode, request: () => ({ mode }) }],
    serviceWorker: { caseId: "worker", script },
    policy: { listIds: () => ["worker"], check() {} },
    assets: async () => ({
      "/page.js": await browserBundle(join(import.meta.dir, "worker-capability-control-page.ts")),
      "/foreign.html": new Blob(["<!doctype html>"], { type: "text/html" }),
      "/root-sw.js": foreignWorker,
      "/foreign-sw.js": foreignWorker,
      [script]:
        mode === "controller-mismatch"
          ? "self.addEventListener('install',e=>e.waitUntil(self.skipWaiting()));"
          : installingWorker,
    }),
    budgets: () => ({ hello: 5000, heartbeat: 5000, case: 10_000, group: 15_000, run: 25_000 }),
  };
  const result = await runPageSuite(
    a,
    (scratch) => (driver = new ControlDriver(engine, scratch, mode)),
    {
      scratchRoot: process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(),
      resultPath: join(root, `worker-${engine}-${mode}.json`),
      port: "ephemeral",
    },
  );
  assert(
    driver?.verified,
    `Worker cleanup control not verified: ${JSON.stringify(result.failures)}`,
  );
  assert(
    result.cleanup.storage.status !== "not-created",
    "Worker declaration bypassed durable cleanup",
  );
  const passing = [
    "success",
    "nested-script",
    "delayed-ack",
    "controller-mismatch",
    "absent-current",
  ].includes(mode);
  assert(
    passing ? result.exit === 0 : result.exit !== 0,
    `Unexpected ${mode} result: ${JSON.stringify(result)}`,
  );
  if (mode === "in-flight-loss" || mode === "missing-ack")
    assert(
      result.registrationAttempts[0]?.state === "unconfirmed",
      "Lost actual operation was declared settled",
    );
  if (mode === "settled-loss")
    assert(
      result.cleanup.storage.status === "confirmed",
      "Independent cleanup lost known settlement",
    );
}
