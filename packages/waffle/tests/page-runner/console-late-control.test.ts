import { expect, test } from "bun:test";
import { BrowserObservation } from "./browser-observation.js";
import type { DriverObservationBinding } from "./driver.js";
import type { FixtureRequest } from "./fixture-owner.js";
import { HostConsumers } from "./owned-consumers.js";
import { PlaywrightDriver } from "./playwright-driver.js";
import { SafariDriver } from "./safari-driver.js";
import {
  LateConsoleControl,
  beforeConsoleCutoff,
  isLateConsoleMode,
  lateConsoleModes,
} from "./console-late-control.js";
import type { SuiteAdapter } from "./suite-host.js";

const origin = "http://localhost:1234";
const base: SuiteAdapter<{ mode: string; marker: string }> = {
  suite: "cpu",
  inventory: () => [],
  assets: async () => ({}),
  policy: { listIds: () => [], check() {} },
  budgets: () => ({ hello: 10000, heartbeat: 10000, case: 15000, group: 20000, run: 60000 }),
};
function binding(): DriverObservationBinding {
  return {
    console: true,
    window: "exact",
    bootstrapURL: `${origin}/bootstrap`,
    expectedURL: `${origin}/?token=exact`,
    signal: new AbortController().signal,
    consumers: new HostConsumers(),
  };
}
function request(deadline = performance.now() + 1000): FixtureRequest {
  return { deadline, signal: new AbortController().signal };
}
async function routes(control: LateConsoleControl) {
  const value = await control.start({
    origin,
    run: "r",
    scratch: "unused",
    signal: new AbortController().signal,
  });
  const gate = value.find((route) => route.path === "/console-late-gate");
  const armed = value.find((route) => route.path === "/console-late-armed");
  if (!gate || !armed) throw new Error("Missing declared routes");
  return { gate, armed };
}
test("exactly four selected late modes preserve two detection and two outside-window controls", () => {
  expect(lateConsoleModes.length).toBe(4);
  expect(lateConsoleModes.filter(beforeConsoleCutoff).length).toBe(2);
  expect(isLateConsoleMode("worker-only")).toBe(false);
});
test("armed response waits for admitted gate; cancellation joins it; teardown aborts without release", async () => {
  const control = new LateConsoleControl("page-late-before-cutoff", "marker", "playwright-console");
  const { gate, armed } = await routes(control);
  const cancel = new AbortController();
  let settled = false;
  const arming = armed.get({ ...request(), signal: cancel.signal }).finally(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  cancel.abort(new Error("cancelled"));
  await expect(arming).rejects.toThrow("cancelled");
  const pending = gate.get(request());
  void pending.catch(() => {});
  try {
    await expect(
      control.run(async () => {
        throw new Error("stop");
      }),
    ).rejects.toThrow("stop");
  } finally {
    await expect(pending).rejects.toBe("late control teardown");
    await control.close();
  }
  expect(control.evidence().active).toBe(0);
  expect(control.evidence().events.some((event) => event.name === "gate-released")).toBe(false);
});
for (const mode of lateConsoleModes) {
  test(`real CPU reducer proves ${mode} ordering and retained observation restoration`, async () => {
    await exercise(mode);
  });
}
async function exercise(
  mode: (typeof lateConsoleModes)[number],
  defect?: "origin" | "page" | "expired-release" | "expired-marker" | "execute" | "write",
) {
  let now = 1;
  const control = new LateConsoleControl(mode, "marker", "playwright-console", () => now);
  const { gate, armed } = await routes(control);
  const b = binding();
  let cutoffs = 0;
  const ledger = new BrowserObservation(
    "exact",
    b.consumers,
    async () => {},
    undefined,
    undefined,
    async () => {
      cutoffs++;
      ledger.consoleState.freeze();
    },
  );
  const settle = ledger.settleConsole;
  const pw = PlaywrightDriver.prototype.observe,
    safari = SafariDriver.prototype.observe,
    reduce = BrowserObservation.prototype.consoleMessage;
  PlaywrightDriver.prototype.observe = async () => ledger;
  const installed = PlaywrightDriver.prototype.observe;
  const pending = gate.get({ ...request(), deadline: 100 });
  await armed.get(request());
  control.adapter(base).policy.check("console", { body: "pass", mode, marker: "marker" });
  const emission = pending.then(() => {
    const stranger = new BrowserObservation("other", new HostConsumers(), async () => {});
    stranger.consoleMessage("page", {
      source: "playwright-console",
      text: "unrelated observation error",
    });
    if (defect === "expired-marker") now = 100;
    if (defect === "page")
      ledger.consoleMessage("page", {
        source: "playwright-console",
        text: "unexpected page error",
      });
    if (mode.startsWith("worker-")) {
      ledger.created(
        "w",
        `${defect === "origin" ? "http://foreign:1234" : origin}/console-worker.js?mode=worker-only&marker=marker`,
      );
      ledger.consoleMessage("w", { source: "playwright-console", text: "marker" });
    } else ledger.consoleMessage("page", { source: "playwright-console", text: "marker" });
  });
  void emission.catch(() => {});
  try {
    const running = control.run(async () => {
      const observation = await new PlaywrightDriver("chromium", "unused").observe(b);
      expect(observation.settleConsole).not.toBe(settle);
      if (defect === "execute") throw new Error("execution failure");
      if (defect === "expired-release") now = 100;
      await observation.settleConsole?.();
    });
    if (
      defect === "origin" ||
      defect === "page" ||
      defect?.startsWith("expired") ||
      defect === "execute"
    )
      await expect(running).rejects.toBeDefined();
    else await running;
    expect(ledger.settleConsole).toBe(settle);
    expect(PlaywrightDriver.prototype.observe).toBe(installed);
    expect(SafariDriver.prototype.observe).toBe(safari);
    expect(BrowserObservation.prototype.consoleMessage).toBe(reduce);
    if (defect === "write")
      await expect(Promise.reject(new Error("evidence write failed"))).rejects.toThrow(
        "write failed",
      );
    await emission.catch(() => {});
    await control.close();
    if (!defect || defect === "write") {
      control.checkEvidence();
      expect(cutoffs).toBe(1);
      if (!beforeConsoleCutoff(mode)) expect(control.evidence().frozenUnchanged).toBe(true);
    }
    if (defect === "origin" || defect === "page") expect(() => control.checkEvidence()).toThrow();
    if (defect === "page")
      expect(control.evidence().firstUnexpected?.text).toBe("unexpected page error");
    if (defect === "expired-release")
      expect(control.evidence().events.some((event) => event.name === "gate-released")).toBe(false);
  } finally {
    PlaywrightDriver.prototype.observe = pw;
    await control.close();
    await pending.catch(() => {});
    await emission.catch(() => {});
  }
}
for (const defect of [
  "origin",
  "page",
  "expired-release",
  "expired-marker",
  "execute",
  "write",
] as const) {
  test(`late control rejects ${defect} and restores returned methods`, () =>
    exercise("worker-late-after-cutoff", defect));
}
test("partial decoration setup failure restores all earlier prototypes", async () => {
  const control = new LateConsoleControl("page-late-before-cutoff", "marker", "playwright-console");
  const descriptor = Object.getOwnPropertyDescriptor(SafariDriver.prototype, "observe");
  if (!descriptor) throw new Error("Missing Safari observe descriptor");
  const pw = PlaywrightDriver.prototype.observe,
    reduce = BrowserObservation.prototype.consoleMessage;
  // Refuse only the setup write, so restoration can still run.
  const original = Object.defineProperty;
  Object.defineProperty = function <T>(
    object: T,
    key: PropertyKey,
    attributes: PropertyDescriptor,
  ): T {
    if (object === SafariDriver.prototype && attributes.value !== descriptor.value)
      throw new Error("partial setup");
    return original(object, key, attributes);
  };
  try {
    await expect(control.run(async () => {})).rejects.toThrow("partial setup");
    expect(PlaywrightDriver.prototype.observe).toBe(pw);
    expect(BrowserObservation.prototype.consoleMessage).toBe(reduce);
  } finally {
    Object.defineProperty = original;
  }
});
