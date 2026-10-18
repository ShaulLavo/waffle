import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { chromium, firefox, webkit, type Browser, type BrowserContext } from "playwright";

export const engines = { chromium, firefox, webkit };
/** Shared storage-test/benchmark lifecycle. Ownership is registered before every await.
 * Shutdown must be confirmed before deleting profiles; queue teardown is the outer fence. */
export class BrowserRunnerLifecycle {
  private directories = new Set<Promise<string>>();
  private browsers = new Set<Promise<Browser>>();
  private contexts = new Set<Promise<BrowserContext>>();
  private cleaning?: Promise<void>;
  private server?: ReturnType<typeof Bun.serve>;
  private interrupted = () => { void this.close().finally(() => process.exit(1)); };
  private deadline: ReturnType<typeof setTimeout>;
  scratch = "";
  constructor(timeoutMs = 600_000) {
    process.once("SIGINT", this.interrupted); process.once("SIGTERM", this.interrupted);
    this.deadline = setTimeout(() => { console.error("Browser runner timed out"); this.interrupted(); }, timeoutMs);
  }
  private assertLive(): void { if (this.cleaning) throw new Error("Browser runner is shutting down"); }
  async directory(root: string, prefix: string): Promise<string> {
    this.assertLive(); await mkdir(root, { recursive: true }); this.assertLive();
    const creation = mkdtemp(resolve(root, prefix)); this.directories.add(creation); const path = await creation; this.assertLive(); return path;
  }
  async init(root = process.env.STORAGE_SCRATCH_ROOT ?? (process.platform === "darwin" ? resolve(homedir(), "tmp") : tmpdir())): Promise<void> { this.scratch = await this.directory(root, "w-"); }
  async removeDirectory(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
    for (const pending of this.directories) if (await pending.catch(() => undefined) === path) this.directories.delete(pending);
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
    this.assertLive(); const pending = engines[name].launch({ headless: true, downloadsPath: this.scratch, tracesDir: this.scratch });
    this.browsers.add(pending); const browser = await pending; this.assertLive(); return browser;
  }
  async persistent(name: keyof typeof engines, profile: string): Promise<BrowserContext> {
    this.assertLive(); const pending = engines[name].launchPersistentContext(profile, { headless: true, downloadsPath: this.scratch, tracesDir: this.scratch });
    this.contexts.add(pending); const context = await pending; this.assertLive(); return context;
  }
  async closeContext(context: BrowserContext): Promise<void> {
    await context.close(); for (const pending of this.contexts) if (await pending.catch(() => undefined) === context) this.contexts.delete(pending);
  }
  async closeBrowser(browser: Browser): Promise<void> {
    await browser.close(); for (const pending of this.browsers) if (await pending.catch(() => undefined) === browser) this.browsers.delete(pending);
  }
  close(): Promise<void> {
    return this.cleaning ??= (async () => {
      clearTimeout(this.deadline); process.removeListener("SIGINT", this.interrupted); process.removeListener("SIGTERM", this.interrupted);
      const failures: unknown[] = [];
      for (const pending of this.contexts) { const context = await pending.catch(() => undefined); try { await context?.close(); } catch (e) { failures.push(e); } }
      for (const pending of this.browsers) { const browser = await pending.catch(() => undefined); try { await browser?.close(); } catch (e) { failures.push(e); } }
      this.server?.stop(true);
      if (!failures.length) for (const pending of this.directories) { const path = await pending.catch(() => undefined); if (path) await rm(path, { recursive: true, force: true }); }
      else { console.error("Shutdown unconfirmed; retaining owned profiles until outer teardown", await Promise.all(this.directories)); throw new AggregateError(failures, "Browser shutdown failed"); }
    })();
  }
}
export async function browserBundle(path: string): Promise<Blob> {
  const build = await Bun.build({ entrypoints: [path], target: "browser" });
  if (!build.success) throw new AggregateError(build.logs, `Browser bundle failed: ${path}`);
  return build.outputs[0]!;
}
