import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPageSuite, type SuiteAdapter } from "waffle/testing/page-runner";
import { controlAssets } from "./consumer-controls.js";

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "prepared-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function adapter(path = "/current/"): SuiteAdapter<null> {
  return {
    suite: "prepared-assets",
    inventory: () => [{ id: "prepared", label: "prepared", request: () => null }],
    policy: { listIds: () => ["prepared"], check() {} },
    assets: async ({ scratch }) => controlAssets(scratch, "pass"),
    page: { path, script: "/current/consumer-control-page.js" },
    budgets: () => ({ hello: 1000, heartbeat: 1000, case: 1000, group: 1000, run: 5000 }),
  };
}
test("real consumer asset preparation reaches normal host driver allocation", () =>
  fixture(async (root) => {
    let factories = 0;
    const result = await runPageSuite(
      adapter(),
      () => {
        factories++;
        throw new Error("PREPARED_ASSETS_ACCEPTED");
      },
      { scratchRoot: root, resultPath: join(root, "result.json"), port: "ephemeral" },
    );
    expect(factories).toBe(1);
    expect(result.failures.some(({ detail }) => detail.includes("PREPARED_ASSETS_ACCEPTED"))).toBe(
      true,
    );
    expect(result.failures.some(({ detail }) => detail.includes("Asset conflicts"))).toBe(false);
    expect(result.cleanup.scratch.status).toBe("confirmed");
  }));
for (const path of [
  "/current/",
  "/report",
  "/heartbeat",
  "/retire",
  "/favicon.ico",
  "/_waffle_owned",
  "/_waffle_owned/run/client.html",
]) {
  test(`prepared asset cannot shadow host route ${path}`, () =>
    fixture(async (root) => {
      const a = adapter();
      a.assets = async () => ({ [path]: "SHADOW" });
      let factories = 0;
      const result = await runPageSuite(
        a,
        () => {
          factories++;
          throw new Error("Unexpected driver");
        },
        { scratchRoot: root, resultPath: join(root, "result.json"), port: "ephemeral" },
      );
      expect(factories).toBe(0);
      expect(
        result.failures.some(({ detail }) => detail.includes("Asset conflicts with host route")),
      ).toBe(true);
      expect(result.cleanup.scratch.status).toBe("confirmed");
    }));
}
test("standalone qualification root HTML is not a hosted document asset", () =>
  fixture(async (root) => {
    const a = adapter("/");
    const { qualificationRoutes } = await import("../gpu-browser-qualification.js");
    a.assets = qualificationRoutes;
    let factories = 0;
    const result = await runPageSuite(
      a,
      () => {
        factories++;
        throw new Error("Unexpected driver");
      },
      { scratchRoot: root, resultPath: join(root, "result.json"), port: "ephemeral" },
    );
    expect(factories).toBe(0);
    expect(
      result.failures.some(({ detail }) => detail.includes("Asset conflicts with host route")),
    ).toBe(true);
  }));
