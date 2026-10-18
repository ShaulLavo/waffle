import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { chromium, firefox, webkit, type Browser, type BrowserContext } from "playwright";
import { stopBrowserResource, type BrowserResourceOwner } from "./process-recycling-browser-runner-control.js";

export const engines = { chromium, firefox, webkit };
type Owner<T extends Browser | BrowserContext> = BrowserResourceOwner & { creation: Promise<T>; parent?: Owner<Browser> };
async function bounded<T>(operation: Promise<T>, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Browser runner ${phase} timed out`)), 10000); })]); }
  finally { clearTimeout(timer); }
}
/** Register ownership before allocation. Unconfirmed shutdown stops admission;
 * bounded cleanup attempts every resource, retaining profiles for outer teardown. */
export class BrowserRunnerLifecycle {
  private directories = new Set<Promise<string>>();
  private browsers = new Set<Owner<Browser>>();
  private contexts = new Set<Owner<BrowserContext>>();
  private cleaning?: Promise<void>;
  private admissionStopped = false;
  private server?: ReturnType<typeof Bun.serve>;
  private previousTmp = process.env.TMPDIR;
  private interrupted = () => { void this.close().catch(console.error).finally(() => process.exit(1)); };
  private deadline: ReturnType<typeof setTimeout>;
  scratch = "";
  get shuttingDown(): boolean { return !!this.cleaning || this.admissionStopped; }
  constructor(timeoutMs = 600_000, private cleanupTimeoutMs = 5000) {
    process.once("SIGINT", this.interrupted); process.once("SIGTERM", this.interrupted);
    this.deadline = setTimeout(() => { console.error("Browser runner timed out"); this.interrupted(); }, timeoutMs);
  }
  private assertLive(): void { if (this.cleaning || this.admissionStopped) throw new Error("Browser runner is shutting down; no further admission"); }
  async directory(root: string, prefix: string): Promise<string> {
    this.assertLive(); await mkdir(root, { recursive: true }); this.assertLive();
    const creation = mkdtemp(resolve(root, prefix)); this.directories.add(creation); const path = await creation; this.assertLive(); return path;
  }
  async init(root = process.env.STORAGE_SCRATCH_ROOT ?? process.env.TMPDIR ?? (process.platform === "darwin" ? resolve(homedir(), "tmp") : "/work/tmp")): Promise<void> {
    this.scratch = await this.directory(root, "w-");
    // The remote dispatcher already owns a physically short TMPDIR. Do not add
    // another profile component to it and exceed Chromium's Unix socket limit.
    if (process.env.TMPDIR && process.env.TMPDIR === process.env.SCRATCH && (await realpath(process.env.TMPDIR)).length <= 48) return;
    if ((await realpath(this.scratch)).length > 48) throw new Error("Use a data-drive scratch root short enough for a <=48-byte browser TMPDIR");
    process.env.TMPDIR = this.scratch;
  }
  async removeDirectory(path: string): Promise<void> {
    await bounded(rm(path, { recursive: true, force: true }), `remove ${path}`);
    for (const pending of this.directories) if (await bounded(pending.catch(() => undefined), "directory allocation") === path) this.directories.delete(pending);
  }
  serve(routes: Record<string, Blob | string>, port = 0): string {
    this.assertLive(); if (this.server) throw new Error("Runner already owns a server");
    this.server = Bun.serve({ hostname: "127.0.0.1", port, fetch(request) {
      const path = new URL(request.url).pathname, body = routes[path];
      return new Response(body ?? "Not found", { status: body === undefined ? 404 : 200, headers: {
        "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp", "cache-control": "no-store",
        "content-type": path.endsWith(".js") ? "text/javascript" : "text/html",
      } });
    } });
    return `http://127.0.0.1:${this.server.port}`;
  }
  async launch(name: keyof typeof engines): Promise<Browser> {
    this.assertLive(); const owner: Owner<Browser> = { creation: engines[name].launch({ headless: true, downloadsPath: this.scratch, tracesDir: this.scratch }), stopped: false };
    this.browsers.add(owner); const browser = await owner.creation; this.assertLive(); return browser;
  }
  async persistent(name: keyof typeof engines, profile: string): Promise<BrowserContext> {
    this.assertLive(); const owner: Owner<BrowserContext> = { creation: engines[name].launchPersistentContext(profile, { headless: true, downloadsPath: this.scratch, tracesDir: this.scratch }), stopped: false };
    this.contexts.add(owner); const context = await owner.creation;
    const browser = context.browser();
    if (browser) { owner.parent = { creation: Promise.resolve(browser), stopped: false }; this.browsers.add(owner.parent); }
    this.assertLive(); return context;
  }
  async closeContext(context: BrowserContext): Promise<void> {
    try {
      for (const owner of this.contexts) if (await bounded(owner.creation.catch(() => undefined), "context allocation") === context) await stopBrowserResource(this.contexts, owner);
      const browser = context.browser(); if (browser) await this.closeBrowser(browser);
    } catch (error) { this.admissionStopped = true; throw error; }
  }
  async closeBrowser(browser: Browser): Promise<void> {
    try {
      for (const owner of this.browsers) if (await bounded(owner.creation.catch(() => undefined), "browser allocation") === browser) await stopBrowserResource(this.browsers, owner);
    } catch (error) { this.admissionStopped = true; throw error; }
  }
  close(): Promise<void> {
    return this.cleaning ??= (async () => {
      // Keep interruption armed until cleanup settles; the host queue remains
      // the outer kill fence if a native process cannot be confirmed stopped.
      const hardStop = setTimeout(() => { console.error("Browser cleanup exceeded its 60-second fence"); process.exit(1); }, 60000);
      let failures: unknown[] = [];
      try {
        for (const owner of this.contexts) {
          try { await stopBrowserResource(this.contexts, owner, this.cleanupTimeoutMs); }
          catch (error) { failures.push(error); }
        }
        for (const owner of this.browsers) {
          try { await stopBrowserResource(this.browsers, owner, this.cleanupTimeoutMs); }
          catch (error) { failures.push(error); }
          // A known enclosing browser's confirmed closure proves only its own
          // contexts dead. An empty browser set proves nothing about an unresolved
          // independent persistent launch or a context with browser() === null.
          if (owner.stopped) for (const context of this.contexts) if (context.parent === owner) { context.stopped = true; this.contexts.delete(context); }
        }
        try { this.server?.stop(true); } catch (error) { failures.push(error); }
        if (!this.contexts.size && !this.browsers.size) {
          for (const pending of Array.from(this.directories)) {
            try { const path = await bounded(pending.catch(() => undefined), "directory allocation"); if (path) await this.removeDirectory(path); }
            catch (error) { failures.push(error); }
          }
        }
        if (this.directories.size) console.error("Retained owned directories for outer teardown", await Promise.all(Array.from(this.directories, pending => bounded(pending, "directory report").catch(String))));
        if (failures.length) throw new AggregateError(failures, "Browser runner cleanup failed");
      } finally {
        if (this.previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = this.previousTmp;
        clearTimeout(hardStop); clearTimeout(this.deadline); process.removeListener("SIGINT", this.interrupted); process.removeListener("SIGTERM", this.interrupted);
      }
    })();
  }
}
export async function browserBundle(path: string): Promise<Blob> {
  const build = await Bun.build({ entrypoints: [path], target: "browser" });
  if (!build.success) throw new AggregateError(build.logs, `Browser bundle failed: ${path}`);
  return build.outputs[0]!;
}
