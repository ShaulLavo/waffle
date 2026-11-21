import { runPageSuite, type SuiteAdapter } from "@waffle-os/runtime/testing/page-runner";
import { PlaywrightDriver } from "@waffle-os/runtime/testing/page-runner/playwright";
import { browserBundle } from "../browser-runner-lifecycle.js";
import { observeWebKitPage } from "../webkit-diagnostics.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverCleanup } from "./driver.js";
import { record } from "./protocol.js";
import type { SuiteResult } from "./suite-host.js";

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
export const webKitWorkerVerificationModes = [
  "verification-navigation-held",
  "verification-slow-native-close",
  "verification-startup-failure",
];
function holdsVerificationNavigation(mode: string): boolean {
  return mode === "verification-navigation-held" || mode === "verification-slow-native-close";
}
const installingWorker = `const identity = crypto.randomUUID(); self.addEventListener('message', e => e.ports[0]?.postMessage(identity)); self.addEventListener('install', e => e.waitUntil(self.skipWaiting())); self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));`;
const foreignWorker = `const identity = crypto.randomUUID(); self.addEventListener('install', e => e.waitUntil(self.skipWaiting())); self.addEventListener('activate', e => e.waitUntil(self.clients.claim())); self.addEventListener('message', e => e.ports[0]?.postMessage(identity));`;
const cleanupStepPrefix = "worker capability verification: ";
const verificationTimeout = "driver cleanup verification timed out";
const startupFailure = "Control failed startup after allocating the browser";
const missingRoot = "No active root Worker in verification document";
const verificationPage = `<!doctype html><script>
  Object.defineProperty(ServiceWorkerRegistration.prototype, "unregister", {
    value() { throw new Error("Verification document attempted to unregister a worker"); },
  });
</script>`;
function assert(value: unknown, detail: string): asserts value {
  if (!value) throw new Error(detail);
}
class ControlDriver extends PlaywrightDriver {
  origin = "";
  scope = "";
  rootIdentity = "";
  foreignIdentity = "";
  verified = false;
  verificationNavigationHeld = false;
  nativeCloses = 0;
  private diagnostics?: ReturnType<typeof observeWebKitPage>;
  constructor(
    private readonly controlEngine: "chromium" | "webkit",
    scratch: string,
    readonly mode: string,
    private readonly startupFailureOrigin?: string,
  ) {
    super(controlEngine, scratch);
  }
  override async start(signal: AbortSignal): Promise<void> {
    await super.start(signal);
    if (this.controlEngine !== "webkit") return;
    if (this.mode === "in-flight-loss" || webKitWorkerVerificationModes.includes(this.mode))
      this.observeVerification();
    if (holdsVerificationNavigation(this.mode))
      await this.current().route("**/verify.html", () => {
        this.verificationNavigationHeld = true;
      });
    if (this.mode === "verification-slow-native-close") this.delayNativeClose();
    if (this.startupFailureOrigin) {
      this.origin = this.startupFailureOrigin;
      throw new Error(startupFailure);
    }
  }
  private delayNativeClose(): void {
    const context = this.current().context();
    const browser = context.browser();
    assert(browser, "Expected WebKit launcher for persistent context");
    const closeContext = context.close.bind(context);
    const closeBrowser = browser.close.bind(browser);
    context.close = async (options) => {
      await Bun.sleep(4250);
      await closeContext(options);
      this.nativeCloses++;
    };
    browser.close = async (options) => {
      await Bun.sleep(3650);
      await closeBrowser(options);
      this.nativeCloses++;
    };
  }
  private observeVerification(): void {
    const page = this.current();
    const diagnostics = observeWebKitPage(page, `worker-capability-${this.mode}`);
    this.diagnostics = diagnostics;
    page.on("console", (message) => {
      const text = message.text();
      if (message.type() === "debug" && text.startsWith(cleanupStepPrefix))
        diagnostics.enter(text.slice(cleanupStepPrefix.length));
    });
  }
  get browserStopped(): boolean {
    const page = this.current();
    return page.isClosed() && page.context().browser()?.isConnected() === false;
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
      this.diagnostics?.enter("navigate away from initiating document");
      await super.navigate(this.origin + "/foreign.html", signal);
      this.diagnostics?.enter("discarded initiating document");
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
  override stop(): Promise<DriverCleanup> {
    this.diagnostics?.shutdown("runner cleanup");
    return super.stop();
  }
  async verifyBeforeStop(signal: AbortSignal): Promise<void> {
    if (!this.origin) return;
    const fail = () => this.diagnostics?.fail();
    signal.addEventListener("abort", fail, { once: true });
    try {
      await this.verifyCleanup(signal);
    } catch (error) {
      if (!signal.aborted) fail();
      throw error;
    } finally {
      signal.removeEventListener("abort", fail);
    }
  }
  private async verifyCleanup(signal: AbortSignal): Promise<void> {
    this.diagnostics?.enter("navigate to verification document");
    await super.navigate(this.origin + "/verify.html", signal);
    this.diagnostics?.enter("start verification script");
    const foreign = ["collision-before", "collision-after", "replacement", "in-place"].includes(
      this.mode,
    );
    const value = await this.script(
      `return (async () => {
        const step = ${this.diagnostics ? `name => console.debug(${JSON.stringify(cleanupStepPrefix)} + name)` : "() => {}"};
        step("enumerate registrations");
        const regs = await navigator.serviceWorker.getRegistrations();
        const root = regs.find(r => r.scope === location.origin + "/");
        const owned = regs.find(r => r.scope === ${JSON.stringify(this.scope)});
        if (!root?.active) throw new Error(${JSON.stringify(missingRoot)});
        const ch = new MessageChannel();
        const id = new Promise(r => ch.port1.onmessage = e => r(e.data));
        step("await root worker identity");
        root.active.postMessage("id", [ch.port2]);
        const rootIdentity = await id;
        let foreignIdentity = null;
        if (${foreign} && owned?.active) {
          const other = new MessageChannel();
          const value = new Promise(resolve => other.port1.onmessage = e => resolve(e.data));
          owned.active.postMessage("id", [other.port2]);
          foreignIdentity = await value;
        }
        step("verify worker identities");
        return {root: rootIdentity, foreignIdentity, current: owned?.active?.scriptURL ?? null};
      })()`,
      signal,
    );
    signal.throwIfAborted();
    assert(record(value) && value.root === this.rootIdentity, "Foreign root active Worker changed");
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
function assertVerificationFailure(driver: ControlDriver, result: SuiteResult): void {
  const held = holdsVerificationNavigation(driver.mode);
  assert(!driver.verified && result.exit === 2, "Verification failure did not fail the suite");
  assert(driver.browserStopped, "Verification failure left the WebKit browser connected");
  const failure = result.failures.find(({ category }) => category === "cleanup-verification");
  assert(
    failure?.detail.includes(held ? verificationTimeout : missingRoot) &&
      !result.failures.some(({ detail }) => detail.includes("verification settlement timed out")),
    `Wrong verification failure: ${JSON.stringify(result.failures)}`,
  );
  if (held) {
    assert(
      driver.verificationNavigationHeld &&
        result.runComplete &&
        result.cleanup.storage.status === "confirmed" &&
        result.outcomes.worker?.status === "pass",
      "Verification hold did not follow a completed worker case",
    );
    if (driver.mode === "verification-slow-native-close")
      assert(driver.nativeCloses === 2, "Suite returned before both real close calls settled");
  } else {
    assert(
      result.failures.some(
        ({ category, detail }) => category === "host" && detail.includes(startupFailure),
      ),
      `Original startup failure was lost: ${JSON.stringify(result.failures)}`,
    );
  }
}
export async function workerCapabilityControl(
  engine: "chromium" | "webkit",
  mode: string,
  root: string,
): Promise<void> {
  let driver: ControlDriver | undefined;
  let startupOrigin: string | undefined;
  const script = mode === "nested-script" ? "/assets/owned-sw.js" : "/owned-sw.js";
  const a: SuiteAdapter<{ mode: string }> = {
    suite: "worker-capability",
    inventory: () => [
      {
        id: "worker",
        label: mode,
        request: () => ({ mode: holdsVerificationNavigation(mode) ? "success" : mode }),
      },
    ],
    serviceWorker: { caseId: "worker", script },
    fixture:
      mode === "verification-startup-failure"
        ? {
            caseId: "worker",
            create: () => ({
              async start({ origin }) {
                startupOrigin = origin;
                return [];
              },
              async close() {},
            }),
          }
        : undefined,
    policy: { listIds: () => ["worker"], check() {} },
    assets: async () => ({
      "/page.js": await browserBundle(join(import.meta.dir, "worker-capability-control-page.ts")),
      "/foreign.html": new Blob(["<!doctype html>"], { type: "text/html" }),
      "/verify.html": new Blob([verificationPage], { type: "text/html" }),
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
    (scratch) => (driver = new ControlDriver(engine, scratch, mode, startupOrigin)),
    {
      scratchRoot: process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(),
      resultPath: join(root, `worker-${engine}-${mode}.json`),
      port: "ephemeral",
    },
  );
  const { session, launcher, server, scratch } = result.cleanup;
  assert(
    [session, launcher, server, scratch].every((step) => step.status === "confirmed"),
    `Worker capability browser teardown unconfirmed: ${JSON.stringify(result.cleanup)}`,
  );
  assert(driver, "Worker capability driver did not start");
  if (webKitWorkerVerificationModes.includes(mode))
    return assertVerificationFailure(driver, result);
  assert(
    driver.verified,
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
