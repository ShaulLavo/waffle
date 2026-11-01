import { verifiedThreadFixture } from "../scripts/build-thread-fixture.js";
import { runIsolatedPages } from "./isolated-page-runner.js";
import {
  prepareThreadsRuntimeSafari,
  runtimeSafariSources,
} from "./threads-runtime-safari-packet.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const directory = process.env.THREAD_FIXTURE_DIR;
  if (!directory)
    throw new Error("set THREAD_FIXTURE_DIR to an existing reviewed producer artifact");
  if (args[0] === "--prepare") {
    const output = args[1];
    if (args.length !== 2 || !output) throw new Error("expected --prepare OUTPUT_DIRECTORY");
    console.log(JSON.stringify(await prepareThreadsRuntimeSafari(output, directory)));
    return;
  }
  const caseIndex = args.indexOf("--case");
  const selected = caseIndex < 0 ? "pair" : args.splice(caseIndex, 2)[1]!;
  if (
    ![
      "pair",
      "repeat",
      "nested",
      "join",
      "child-exit",
      "kill-start",
      "cpu",
      "wait32",
      "wait64",
    ].includes(selected)
  )
    throw new Error("unknown Runtime case");
  const wasm = verifiedThreadFixture(directory);
  await runIsolatedPages({
    label: "threads-runtime",
    scratchRoot: process.env.PROCESS_SCRATCH_ROOT ?? "/work/tmp",
    scratchPrefix: "run-",
    port: Number(process.env.THREAD_RUNTIME_PORT ?? 19447),
    names: args.length ? args : ["chromium"],
    sources: runtimeSafariSources,
    route: (path, headers) =>
      path === "/threads.wasm"
        ? new Response(wasm, { headers: { ...headers, "content-type": "application/wasm" } })
        : undefined,
    evaluate: async (page) => {
      const report = await page.evaluate(async (selected) => {
        const module = (await import(
          "/runtime-page.js" as string
        )) as typeof import("./threads-runtime-browser.js");
        return module.runThreadsRuntime(
          selected as import("./threads-runtime-browser.js").RuntimeThreadCase,
        );
      }, selected);
      return { browserVersion: page.context().browser()?.version(), ...report };
    },
  });
}
await main();
