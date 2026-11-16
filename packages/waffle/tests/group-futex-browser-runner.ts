import { webkit, type Browser } from "playwright";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { navigateTestPage } from "./browser-navigation.ts";

const base = process.argv.includes("--base");
const revision = "27b03a8c519b4d48d00d3723b4ee2993d735f27d";
const replaced = new Set([
  "group/member.ts",
  "group/protocol.ts",
  "group/state.ts",
  "browser/process-broker.ts",
  "proc/directory.ts",
]);
async function bundle(entry: string) {
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, entry)],
    target: "browser",
    plugins: base
      ? [
          {
            name: "recorded-base",
            setup(build) {
              build.onLoad({ filter: /\.ts$/ }, ({ path }) => {
                const relative = path.slice(resolve(import.meta.dir, "..").length + 1);
                if (relative === "tests/group-futex-browser.ts")
                  return {
                    contents: readFileSync(path, "utf8")
                      .replaceAll("a.stopRequested();", "")
                      .replaceAll("b.stopRequested();", ""),
                    loader: "ts",
                  };
                if (!replaced.has(relative)) return;
                return {
                  contents: execFileSync(
                    "git",
                    ["show", `${revision}:packages/waffle/${relative}`],
                    { encoding: "utf8" },
                  ),
                  loader: "ts",
                };
              });
            },
          },
        ]
      : [],
  });
  if (!result.success) throw new AggregateError(result.logs, "futex browser build failed");
  return result.outputs[0]!;
}
const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cache-Control": "no-store",
};
const [pageBundle, workerBundle] = await Promise.all([
  bundle("group-futex-browser.ts"),
  bundle("fixtures/group-futex-worker.ts"),
]);
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Awaited<ReturnType<typeof webkit.launch>> | undefined;
async function cleanup() {
  await browser?.close();
  server?.stop(true);
}
async function runArm(browser: Browser, url: string, width: 4 | 8, arm: string): Promise<void> {
  const page = await browser.newPage();
  const closed: string[] = [];
  page.on("worker", (worker) => {
    const url = worker.url();
    worker.on("close", () => closed.push(url));
  });
  try {
    await navigateTestPage(page, url);
    const facts = await page.evaluate(
      async ({ width, arm }) => {
        const tests = (await import(
          "/page.js" as string
        )) as typeof import("./group-futex-browser.ts");
        return arm === "staggered"
          ? tests.passiveStaggered(width)
          : tests.passiveRoot(width, arm === "pre-park");
      },
      { width, arm },
    );
    if (
      arm === "pre-park" &&
      (!("gate" in facts) ||
        !facts.gate ||
        facts.gate.closed !== 0 ||
        facts.gate.closedReads !== 1 ||
        facts.gate.width !== width)
    )
      throw new Error("pre-park seam did not reach the gap after CLOSED=0");
    console.log(
      JSON.stringify({
        phase: "passive-start",
        base,
        revision: base ? revision : "working-source",
        width,
        arm,
        facts,
      }),
    );
    // Observation window only, with no notify, construction, pressure or explicit GC.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    console.log(
      JSON.stringify({
        phase: "passive-end",
        base,
        width,
        arm,
        workerCloseEvents: closed.length,
        nativeRelease:
          "requires positively qualified native log; Worker close is not a backing receipt",
      }),
    );
  } finally {
    await page.close();
  }
}
process.once("SIGTERM", () => void cleanup().finally(() => process.exit(143)));
process.once("SIGINT", () => void cleanup().finally(() => process.exit(130)));
try {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/page.js")
        return new Response(pageBundle, {
          headers: { ...headers, "Content-Type": "text/javascript" },
        });
      if (path === "/worker.js")
        return new Response(workerBundle, {
          headers: { ...headers, "Content-Type": "text/javascript" },
        });
      return new Response("<!doctype html><title>Group futex passive control</title>", { headers });
    },
  });
  browser = await webkit.launch({ env: { ...process.env, JSC_logWasmMemory: "1" } });
  for (const width of [4, 8] as const) {
    for (const arm of base ? ["root", "staggered"] : ["root", "staggered", "pre-park"]) {
      await runArm(browser, `http://127.0.0.1:${server.port}/`, width, arm);
    }
  }
} finally {
  await cleanup();
}
