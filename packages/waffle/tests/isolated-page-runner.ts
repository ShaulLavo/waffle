import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import {
  closeBrowserResources,
  type BrowserResourceOwner,
} from "./process-recycling-browser-runner-control.js";

export const engines = { chromium, firefox, webkit };
type Engine = keyof typeof engines;

export interface IsolatedPageRun {
  /** Logged as the JSON `resources` label and used in failure messages. */
  readonly label: string;
  /** Logged with the owned resources: the page entry points the bundles expose. */
  readonly entries?: readonly string[];
  /** Parent of the disposable mkdtemp browser TMPDIR. */
  readonly scratchRoot: string;
  readonly scratchPrefix: string;
  readonly port: number;
  /** Served path to source module, bundled for the browser relative to the tests directory. */
  readonly sources: Readonly<Record<string, string>>;
  /** A response for a path the bundles do not cover. */
  readonly route?: (
    path: string,
    headers: Record<string, string>,
  ) => Response | undefined | Promise<Response | undefined>;
  readonly names: readonly string[];
  readonly dispose?: () => Promise<void>;
  readonly evaluate: (page: Page) => Promise<unknown>;
}

/** One cross-origin-isolated page per engine. The run owns its server, browsers, contexts
 * and scratch directory, and releases them on success, failure, signal or deadline. */
export async function runIsolatedPages(run: IsolatedPageRun): Promise<void> {
  const browsers = new Set<BrowserResourceOwner>();
  const contexts = new Set<BrowserResourceOwner>();
  let server: ReturnType<typeof Bun.serve> | undefined;
  let scratchCreation: Promise<string> | undefined;
  let cleaning: Promise<void> | undefined;
  const cleanup = () =>
    (cleaning ??= (async () => {
      const errors = await closeBrowserResources(contexts, browsers);
      await server?.stop(true);
      try {
        await run.dispose?.();
      } catch (error) {
        errors.push(error);
      }
      const scratch = await scratchCreation;
      if (scratch && browsers.size === 0) {
        await rm(scratch, { recursive: true, force: true });
        await requireRemoved(scratch);
      }
      if (errors.length) throw new AggregateError(errors, `${run.label} cleanup failed`);
      console.log(
        JSON.stringify({
          cleanup: run.label,
          browsers: browsers.size,
          contexts: contexts.size,
          scratchRemoved: Boolean(scratch),
        }),
      );
    })());
  const stop = () => {
    void cleanup().finally(() => process.exit(1));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const deadline = setTimeout(stop, 600_000);
  try {
    await mkdir(run.scratchRoot, { recursive: true });
    scratchCreation = mkdtemp(resolve(run.scratchRoot, run.scratchPrefix));
    const scratch = await scratchCreation;
    console.log(
      JSON.stringify({
        resources: run.label,
        scratch,
        port: run.port,
        entries: run.entries ?? Object.keys(run.sources),
      }),
    );
    const scripts = await bundle(run.sources);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: run.port,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const headers = {
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "require-corp",
          "Content-Type": path === "/" ? "text/html" : "text/javascript",
        };
        const routed = await run.route?.(path, headers);
        if (routed) return routed;
        if (path === "/")
          return new Response(`<!doctype html><title>${run.label}</title>`, { headers });
        const script = scripts.get(path);
        return new Response(script ?? "Not found", { status: script ? 200 : 404, headers });
      },
    });
    for (const name of run.names) {
      if (!Object.hasOwn(engines, name)) throw Error(`Unknown browser ${name}`);
      await inPage(run, name as Engine, server.url.href, scratch, browsers, contexts);
    }
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await cleanup();
  }
}

async function bundle(sources: Readonly<Record<string, string>>): Promise<Map<string, Blob>> {
  const scripts = new Map<string, Blob>();
  for (const [path, source] of Object.entries(sources)) {
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, source)],
      target: "browser",
    });
    if (!build.success) throw new AggregateError(build.logs, `Failed to build ${source}`);
    scripts.set(path, build.outputs[0]!);
  }
  return scripts;
}

async function inPage(
  run: IsolatedPageRun,
  name: Engine,
  url: string,
  tmp: string,
  browsers: Set<BrowserResourceOwner>,
  contexts: Set<BrowserResourceOwner>,
): Promise<void> {
  const creation: Promise<Browser> = engines[name].launch({
    headless: true,
    env: { ...process.env, TMPDIR: tmp },
  });
  browsers.add({ creation, stopped: false });
  const browser = await creation;
  const contextCreation: Promise<BrowserContext> = browser.newContext();
  contexts.add({ creation: contextCreation, stopped: false });
  const page = await (await contextCreation).newPage();
  page.on("pageerror", (error) => console.error(`${run.label} page: ${error.message}`));
  await page.goto(url);
  console.log(JSON.stringify({ engine: name, passed: await run.evaluate(page) }));
  const errors = await closeBrowserResources(contexts, browsers);
  if (errors.length) throw new AggregateError(errors, `${name} cleanup failed`);
}

async function requireRemoved(path: string): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Browser scratch remains after cleanup: ${path}`);
}
