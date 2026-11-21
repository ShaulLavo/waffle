import { navigateTestPage } from "./browser-navigation.js";
import { runIsolatedPages } from "./isolated-page-runner.js";
import {
  prepareThreadsRuntimeSafari,
  runtimeFixture,
  runtimeSafariSources,
} from "./threads-runtime-safari-packet.js";
import {
  isRuntimeThreadCase,
  isRuntimeThreadRegression,
  runtimeThreadCases,
  runtimeThreadRegressions,
  type BrowserRuntimeThreadCase,
} from "./threads-runtime-cases.js";

type RuntimeThreadCommand =
  | { kind: "native"; args: string[] }
  | { kind: "prepare"; directory: string }
  | { kind: "browser"; engines: string[]; cases: readonly BrowserRuntimeThreadCase[] };

const browserCases: readonly BrowserRuntimeThreadCase[] =
  Array.from<BrowserRuntimeThreadCase>(runtimeThreadCases).concat(runtimeThreadRegressions);

const browserRuntimeSources = {
  ...runtimeSafariSources,
  "/thread-fd-filesystem.js": new URL("./threads-runtime-fd-filesystem.ts", import.meta.url)
    .pathname,
  "/thread-fd-service.js": new URL("./threads-runtime-fd-service.ts", import.meta.url).pathname,
  "/thread-growth.js": new URL("./threads-runtime-growth-worker.ts", import.meta.url).pathname,
};

export function parseRuntimeThreadCommand(args: readonly string[]): RuntimeThreadCommand {
  if (args[0] === "ios-safari") return { kind: "native", args: args.slice(1) };
  if (args[0] === "--prepare") {
    if (args.length !== 2 || !args[1]) throw new Error("expected --prepare OUTPUT_DIRECTORY");
    return { kind: "prepare", directory: args[1] };
  }
  const engines: string[] = [];
  const focused: BrowserRuntimeThreadCase[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg !== "--case") {
      engines.push(arg);
      continue;
    }
    const selected = args[++index];
    if (!isRuntimeThreadCase(selected) && !isRuntimeThreadRegression(selected))
      throw new Error("unknown Runtime case");
    if (focused.includes(selected)) throw new Error(`duplicate Runtime case ${selected}`);
    focused.push(selected);
  }
  if (engines.some((name) => !["chromium", "firefox", "webkit"].includes(name)))
    throw new Error("expected chromium, firefox or webkit, with optional --case NAME");
  return {
    kind: "browser",
    engines: engines.length ? engines : ["chromium"],
    cases: focused.length ? focused : browserCases,
  };
}

async function evaluateRuntimeCase({
  selected,
  fixtureSha256,
}: {
  selected: BrowserRuntimeThreadCase;
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
    sources: browserRuntimeSources,
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
