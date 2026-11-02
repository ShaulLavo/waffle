import { createHash } from "node:crypto";
import { mkdir, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { verifiedThreadFixture } from "../scripts/build-thread-fixture.ts";
import { threadBrowserModes, type ThreadBrowserMode } from "./threads-browser-contract.ts";
import { runIsolatedPages } from "./isolated-page-runner.ts";

export const threadBrowserSources = {
  "/threads-page.js": new URL("./threads-browser-page.ts", import.meta.url).pathname,
  "/threads-guest.js": new URL("./threads-browser-guest-worker.ts", import.meta.url).pathname,
  "/threads-service.js": new URL("./threads-browser-service-worker.ts", import.meta.url).pathname,
  "/fs-worker.js": new URL("../browser/fs-worker.ts", import.meta.url).pathname,
};
/** @public Prepare a portable, compiler-free packet for the actual Safari runner. */
export async function prepareThreadsBrowser(directory: string, receiptDirectory: string) {
  const wasm = verifiedThreadFixture(receiptDirectory);
  await mkdir(directory, { recursive: true });
  const assets: { path: string; sha256: string }[] = [];
  for (const [path, source] of Object.entries(threadBrowserSources)) {
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, source)],
      target: "browser",
      minify: true,
    });
    if (!build.success || !build.outputs[0])
      throw new AggregateError(build.logs, `bundle ${source}`);
    await Bun.write(join(directory, path.slice(1)), build.outputs[0]);
    assets.push({
      path: path.slice(1),
      sha256: createHash("sha256")
        .update(await build.outputs[0].arrayBuffer().then((value) => new Uint8Array(value)))
        .digest("hex"),
    });
  }
  await Bun.write(join(directory, "threads.wasm"), wasm);
  await copyFile(
    join(receiptDirectory, "threads.receipt.json"),
    join(directory, "threads.receipt.json"),
  );
  const source = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: import.meta.dir })
    .stdout.toString()
    .trim();
  const diff = Bun.spawnSync(["git", "diff", "HEAD"], { cwd: import.meta.dir }).stdout;
  const manifest = {
    source,
    trackedDiffSha256: createHash("sha256").update(diff).digest("hex"),
    receiptSha256: createHash("sha256")
      .update(
        await Bun.file(join(receiptDirectory, "threads.receipt.json"))
          .arrayBuffer()
          .then((value) => new Uint8Array(value)),
      )
      .digest("hex"),
    fixtureSha256: createHash("sha256").update(wasm).digest("hex"),
    assets,
  };
  await Bun.write(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const runner = await Bun.build({
    entrypoints: [new URL("./threads-safari-runner.ts", import.meta.url).pathname],
    target: "bun",
    minify: true,
  });
  if (!runner.success || !runner.outputs[0])
    throw new AggregateError(runner.logs, "Safari runner build");
  await Bun.write(join(directory, "runner.mjs"), runner.outputs[0]);
  return manifest;
}
/** @public Receipt verification never invokes a compiler or repairs an artifact. */
export async function runThreadBrowsers(
  names: readonly string[],
  modes: readonly ThreadBrowserMode[] = threadBrowserModes(),
) {
  const directory = process.env.THREAD_FIXTURE_DIR;
  const scratchRoot = process.env.PROCESS_SCRATCH_ROOT;
  const port = Number(process.env.THREAD_BROWSER_PORT);
  if (!directory || !scratchRoot || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(
      "set THREAD_FIXTURE_DIR, PROCESS_SCRATCH_ROOT and explicit THREAD_BROWSER_PORT",
    );
  const wasm = verifiedThreadFixture(directory);
  const fixtureSha256 = createHash("sha256").update(wasm).digest("hex");
  await runIsolatedPages({
    label: "threads-low-level",
    scratchRoot,
    scratchPrefix: "wthread-",
    port,
    sources: threadBrowserSources,
    names,
    route: (path, headers) =>
      path === "/threads.wasm"
        ? new Response(wasm, { headers: { ...headers, "content-type": "application/wasm" } })
        : undefined,
    evaluate: async (page) => {
      const report = await page.evaluate(async (selected) => {
        const module = (await import(
          "/threads-page.js" as string
        )) as typeof import("./threads-browser-page.ts");
        return module.runThreadsBrowser(selected);
      }, modes);
      if (report.fixtureSha256 !== fixtureSha256)
        throw new Error("browser consumed a different artifact");
      return { browserVersion: page.context().browser()?.version(), report };
    },
  });
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--prepare") {
    const directory = args[1];
    const receipt = process.env.THREAD_FIXTURE_DIR;
    if (!directory || !receipt) throw new Error("--prepare DIRECTORY needs THREAD_FIXTURE_DIR");
    console.log(JSON.stringify(await prepareThreadsBrowser(resolve(directory), receipt)));
  } else {
    const index = args.indexOf("--case");
    if (index >= 0 && !args[index + 1]) throw new Error("--case requires a mode");
    const modes = threadBrowserModes(index < 0 ? undefined : args[index + 1]);
    if (index >= 0) args.splice(index, 2);
    await runThreadBrowsers(args.length ? args : ["chromium", "firefox"], modes);
  }
}
