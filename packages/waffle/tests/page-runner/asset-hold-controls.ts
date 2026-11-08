import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { runPageSuite, type HostCase, type SuiteAdapter } from "./consumer.js";
import { PlaywrightDriver } from "./playwright-driver.js";
import { engines } from "../browser-runner-lifecycle.js";

const original = [0, 97, 115, 109, 1, 0, 255, 0];
const ids = ["shell", "unheld-shell", "unheld-guest", "guest"];
function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("Asset control equality failed");
}
async function drive(host: HostCase, id: string): Promise<unknown> {
  const held = id === "shell" || id === "guest";
  const path = id.includes("shell") ? "/programs/shell-engine.wasm" : "/programs/test-guest.wasm";
  const release = Promise.withResolvers<void>();
  let entered = false;
  const observed = Promise.withResolvers<void>();
  if (held)
    host.holdAsset(path, async (request) => {
      entered = true;
      await release.promise;
      await request.continue();
      await observed.promise;
    });
  const task = host.task(`window.__assetDone=false;
const response=await fetch(${JSON.stringify(path)}${id.includes("guest") ? ", {signal:new AbortController().signal}" : ""});
window.__assetEvidence={status:response.status,type:response.headers.get('Content-Type'),bytes:Array.from(new Uint8Array(await response.arrayBuffer()))};
window.__assetDone=true;`);
  void task.catch(() => {});
  try {
    if (held) {
      while (!entered) await host.sleep(5);
      equal(await host.script("return window.__assetDone;"), false);
    }
    release.resolve();
    await task;
    equal(await host.script("return window.__assetEvidence;"), {
      status: 200,
      type: "application/wasm",
      bytes: original,
    });
    observed.resolve();
    return { held, bytes: original, original: false };
  } finally {
    release.resolve();
    observed.resolve();
  }
}
async function control(engine: keyof typeof engines, root: string): Promise<void> {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "asset-hold-control-page.ts")],
    target: "browser",
  });
  const page = built.outputs[0];
  if (!built.success || !page)
    throw new AggregateError(built.logs, "Asset control page build failed");
  const adapter: SuiteAdapter<null> = {
    suite: "asset-hold-desktop-control",
    inventory: () =>
      ids.map((id) => ({ id, label: id, request: () => null, drive: (host) => drive(host, id) })),
    policy: {
      listIds: (value) => {
        if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
          throw new Error("Invalid inventory");
        return value;
      },
      requireResult: true,
      check() {},
    },
    assets: async () => ({
      "/page.js": page,
      "/programs/shell-engine.wasm": new Blob([new Uint8Array(original)], {
        type: "application/wasm",
      }),
      "/programs/test-guest.wasm": new Blob([new Uint8Array(original)], {
        type: "application/wasm",
      }),
    }),
    budgets: () => ({
      hello: 5000,
      heartbeat: 3000,
      case: 5000,
      group: 15000,
      teardown: 2000,
      run: 45000,
    }),
  };
  const result = await runPageSuite(adapter, (scratch) => new PlaywrightDriver(engine, scratch), {
    scratchRoot: root,
    resultPath: join(root, `${engine}.json`),
    port: "ephemeral",
    cleanupTimeoutMs: 3000,
  });
  equal(result.exit, 0);
  equal(result.required, ids);
  equal(result.runComplete, true);
  for (const step of [
    result.cleanup.session,
    result.cleanup.launcher,
    result.cleanup.server,
    result.cleanup.scratch,
  ])
    equal(step.status, "confirmed");
  console.log(
    JSON.stringify({
      engine,
      exit: result.exit,
      outcomes: result.outcomes,
      cleanup: result.cleanup,
      original: false,
      native: false,
    }),
  );
}
async function main(): Promise<void> {
  const root = await mkdtemp("/work/tmp/wah-");
  let complete = false;
  try {
    for (const engine of process.argv.slice(2)) {
      if (engine !== "chromium" && engine !== "webkit")
        throw new Error("Expected chromium or webkit");
      await control(engine, root);
    }
    complete = true;
  } finally {
    if (complete) await rm(root, { recursive: true, force: true });
    else console.error(`Retained failed control evidence at ${root}`);
  }
}

if (import.meta.main) await main();
