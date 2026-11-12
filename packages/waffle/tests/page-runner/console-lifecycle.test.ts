import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { BrowserObservation } from "./browser-observation.js";
import { loadBootstrap } from "./bootstrap-control.js";
import type { DriverObservationBinding } from "./driver.js";
import { FakeDriver } from "./fake-driver.js";
import { runPageSuite, type SuiteAdapter, type SuiteCase } from "./suite-host.js";

type Mode =
  | "pass"
  | "navigation"
  | "admission"
  | "loss"
  | "cancel"
  | "retirement"
  | "assertion-detach";
class ConsoleDriver extends FakeDriver {
  observed: BrowserObservation | undefined;
  detachCalls = 0;
  caseNavigations = 0;
  constructor(
    readonly control: Mode,
    private readonly cancel: AbortController,
  ) {
    super(control === "assertion-detach" ? "assertion" : "pass", {
      list: ["console"],
      result: true,
    });
  }
  async observe(binding: DriverObservationBinding) {
    const observation = new BrowserObservation(
      "cpu-page",
      binding.consumers,
      async () => {
        this.detachCalls++;
        if (this.control === "assertion-detach") throw new Error("Actual detach failure");
      },
      undefined,
      () => {
        if (this.control === "admission") throw new Error("Actual admission failure");
      },
      async () => {
        observation.consoleState.freeze();
        if (this.control === "retirement") throw new Error("Actual cutoff failure");
      },
    );
    this.observed = observation;
    if (this.control === "loss") observation.lose(new Error("Actual observer loss"));
    return observation;
  }
  override async navigate(url: string): Promise<void> {
    if (new URL(url).pathname === "/_waffle_observation_bootstrap") {
      await loadBootstrap(url);
      this.currentURL = url;
      return;
    }
    if (this.observed && !this.detachCalls) {
      this.caseNavigations++;
      this.observed.check();
      if (this.control === "navigation") throw new Error("Actual navigation failure");
      if (this.control === "cancel") {
        this.cancel.abort("Actual cancellation");
        throw new Error("Actual cancellation");
      }
    }
    await super.navigate(url);
  }
}
for (const mode of [
  "pass",
  "navigation",
  "admission",
  "loss",
  "cancel",
  "retirement",
  "assertion-detach",
] as const) {
  test(`ordinary console observation owns cleanup through ${mode}`, async () => {
    const root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? "/work/tmp", "wcc-cpu-"));
    const controller = new AbortController();
    const driver = new ConsoleDriver(mode, controller);
    const adapter: SuiteAdapter<Record<string, never>> = {
      suite: "console-cpu",
      inventory: () => [
        { id: "console", label: mode, request: () => ({}), console: "fail-on-error" },
      ],
      assets: async () => ({}),
      policy: { listIds: () => ["console"], check() {} },
      budgets: () => ({ hello: 1000, heartbeat: 1000, case: 1000, group: 2000, run: 5000 }),
    };
    try {
      const result = await runPageSuite(adapter, () => driver, {
        resultPath: join(root, "result.json"),
        scratchRoot: root,
        signal: controller.signal,
        port: "ephemeral",
      });
      expect(driver.detachCalls).toBe(1);
      expect(driver.stopCalls).toBe(1);
      expect(result.exit, JSON.stringify(result)).toBe(mode === "pass" ? 0 : 2);
      expect(result.cleanup.scratch.status).toBe("confirmed");
      if (mode === "loss")
        expect(result.failures.some((failure) => failure.category === "browser-observation")).toBe(
          true,
        );
      if (mode === "assertion-detach")
        expect(result.outcomes.console).toEqual({ status: "fail", detail: "Original assertion" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
test("console declaration rejects host-driven and invalid policies before driver allocation", async () => {
  for (const declaration of [
    { console: "wrong" },
    { console: "fail-on-error", drive: async () => {} },
  ]) {
    const item: SuiteCase<null> = { id: "console", label: "console", request: () => null };
    Object.assign(item, declaration);
    const adapter: SuiteAdapter<null> = {
      suite: "console-invalid",
      inventory: () => [item],
      assets: async () => ({}),
      policy: { listIds: () => ["console"], check() {} },
      budgets: () => ({ hello: 1, heartbeat: 1, case: 1, group: 1, run: 1 }),
    };
    await expect(
      runPageSuite(
        adapter,
        () => {
          throw new Error("Driver must not be allocated");
        },
        { resultPath: "/unallocated.json" },
      ),
    ).rejects.toThrow("ordinary page case");
  }
});
