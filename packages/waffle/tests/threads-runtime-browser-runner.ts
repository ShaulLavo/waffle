import { navigateTestPage } from "./browser-navigation.js";
import { runIsolatedPages } from "./isolated-page-runner.js";
import {
  prepareThreadsRuntimeSafari,
  runtimeFixture,
  runtimeSafariSources,
} from "./threads-runtime-safari-packet.js";
import {
  isRuntimeThreadCase,
  runtimeThreadCases,
  type RuntimeThreadCase,
} from "./threads-runtime-cases.js";

type RuntimeThreadCommand =
  | { kind: "native"; args: string[] }
  | { kind: "prepare"; directory: string }
  | { kind: "browser"; engines: string[]; cases: readonly RuntimeThreadCase[] };

export function parseRuntimeThreadCommand(args: readonly string[]): RuntimeThreadCommand {
  if (args[0] === "ios-safari") return { kind: "native", args: args.slice(1) };
  if (args[0] === "--prepare") {
    if (args.length !== 2 || !args[1]) throw new Error("expected --prepare OUTPUT_DIRECTORY");
    return { kind: "prepare", directory: args[1] };
  }
  const names = args.slice();
  const caseIndex = names.indexOf("--case");
  let cases: readonly RuntimeThreadCase[] = runtimeThreadCases;
  if (caseIndex >= 0) {
    const selected = names.splice(caseIndex, 2)[1];
    if (!isRuntimeThreadCase(selected)) throw new Error("unknown Runtime case");
    cases = [selected];
  }
  if (names.some((name) => !["chromium", "firefox", "webkit"].includes(name)))
    throw new Error("expected chromium, firefox or webkit, with optional --case NAME");
  return { kind: "browser", engines: names.length ? names : ["chromium"], cases };
}

async function evaluateRuntimeCase({
  selected,
  fixtureSha256,
}: {
  selected: RuntimeThreadCase;
  fixtureSha256: string;
}) {
  const module = (await import(
    "/runtime-page.js" as string
  )) as typeof import("./threads-runtime-browser.js");
  return module.runThreadsRuntime(selected, false, fixtureSha256);
}

async function main(): Promise<void> {
  const startedAt = performance.now();
  const command = parseRuntimeThreadCommand(process.argv.slice(2));
  if (command.kind === "native") {
    const { threadsRuntimeNative } = await import("./page-runner/threads-runtime-native.js");
    process.exitCode = await threadsRuntimeNative(command.args, startedAt);
    return;
  }
  const directory = process.env.THREAD_FIXTURE_DIR;
  if (!directory)
    throw new Error("set THREAD_FIXTURE_DIR to an existing reviewed producer artifact");
  if (command.kind === "prepare") {
    console.log(JSON.stringify(await prepareThreadsRuntimeSafari(command.directory, directory)));
    return;
  }
  const fixture = await runtimeFixture(directory);
  await runIsolatedPages({
    label: "threads-runtime",
    scratchRoot: process.env.PROCESS_SCRATCH_ROOT ?? "/work/tmp",
    scratchPrefix: "run-",
    port: Number(process.env.THREAD_RUNTIME_PORT ?? 19447),
    names: command.engines,
    sources: runtimeSafariSources,
    route: (path, headers) =>
      path === "/threads.wasm"
        ? new Response(fixture.wasm, {
            headers: { ...headers, "content-type": "application/wasm" },
          })
        : undefined,
    evaluate: async (page) => {
      const reports = [];
      for (const selected of command.cases) {
        const url = new URL(page.url());
        url.search = new URLSearchParams({ selected, document: crypto.randomUUID() }).toString();
        await navigateTestPage(page, url.href);
        const report = await page.evaluate(evaluateRuntimeCase, {
          selected,
          fixtureSha256: fixture.fixtureSha256,
        });
        reports.push({ browserVersion: page.context().browser()?.version(), ...report });
      }
      return reports;
    },
  });
}
if (import.meta.main) await main();
