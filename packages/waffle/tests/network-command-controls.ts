import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { runPageSuite, type SuiteAdapter } from "waffle/testing/page-runner";
import { NetworkDesktopDriver } from "./network-desktop-driver.js";
import { networkInputs } from "./network-page-inputs.js";
import { networkBudgets } from "./network-page-contract.js";
import { networkScratch } from "./network-command.js";
import { signalControl } from "./network-signal-controls.js";

export async function networkCommandControls(): Promise<void> {
  const root = await mkdtemp(join(await networkScratch(), "c-"));
  const inputs = networkInputs();
  try {
    for (const signal of ["SIGINT", "SIGTERM"] as const) await signalControl(signal);
    for (const mode of ["scope-only", "cleanup-all", "slow-sentinel"]) {
      const adapter: SuiteAdapter<string> = {
        suite: "network-control",
        inventory: () => [{ id: "network-control", label: mode, request: () => mode }],
        policy: { listIds: () => ["network-control"], check() {} },
        budgets: () => ({ ...networkBudgets(), run: 30_000, case: 20_000, group: 25_000 }),
        async assets(context) {
          const assets = await inputs.network(context);
          const build = await Bun.build({
            entrypoints: [new URL("./network-control-page.ts", import.meta.url).pathname],
            target: "browser",
          });
          if (!build.success || !build.outputs[0]) throw new AggregateError(build.logs);
          const worker = assets["/sentinel-sw.js"];
          if (typeof worker !== "string") throw new Error("Missing root sentinel input");
          return {
            ...assets,
            "/page.js": build.outputs[0],
            "/sentinel-sw.js":
              mode === "slow-sentinel"
                ? worker +
                  ";self.addEventListener('install',e=>e.waitUntil(new Promise(resolve=>setTimeout(resolve,3500))));"
                : worker,
          };
        },
      };
      const result = await runPageSuite(
        adapter,
        (scratch) => new NetworkDesktopDriver("chromium", scratch),
        {
          scratchRoot: process.env.NETWORK_SCRATCH_ROOT,
          resultPath: join(root, `${mode}.json`),
          port: "ephemeral",
        },
      );
      if (mode === "slow-sentinel") {
        assert.equal(
          result.exit,
          0,
          `Sentinel setup escaped the normal navigation budget: ${JSON.stringify(result.failures)}`,
        );
        console.log(JSON.stringify({ control: mode, passed: true }));
        continue;
      }
      assert.equal(result.exit, 1);
      const outcome = result.outcomes["network-control"];
      assert.ok(outcome?.status === "fail");
      if (mode === "scope-only") assert.match(outcome.detail, /Browser network progress timed out/);
      else
        assert.ok(
          [
            "PRIMARY_ASSERTION",
            "CLEANUP_guest 1",
            "CLEANUP_guest 2",
            "CLEANUP_unregister",
            "CLEANUP_listener",
            "CLEANUP_namespace",
            "CLEANUP_runtime",
          ].every((cause) => outcome.detail.includes(cause)),
          `Missing saved finalizer cause: ${outcome.detail}`,
        );
      assert.ok(
        Object.values(result.cleanup).every(
          (step) => typeof step === "string" || step.status !== "unconfirmed",
        ),
      );
      console.log(JSON.stringify({ control: mode, passed: true, outcome }));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
