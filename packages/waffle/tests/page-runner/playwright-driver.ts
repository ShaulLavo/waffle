import { observePlaywrightPage } from "./playwright-observer.js";
import type { HostKey } from "./protocol.js";
import { driverResponseLimit } from "./safari-driver.js";
import { navigateTestPage } from "../browser-navigation.js";
import { dirname } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { BrowserRunnerLifecycle, type engines } from "../browser-runner-lifecycle.js";
import {
  bounded,
  DeadlineError,
  WebDriverError,
  type Driver,
  type DriverCleanup,
  type DriverPressControl,
  type DriverObservationBinding,
  type DriverObservation,
} from "./driver.js";
/** Local runner regressions only. Not an iOS adapter or a replacement storage body. */
export class PlaywrightDriver implements Driver {
  private lifecycle = new BrowserRunnerLifecycle(600_000, 5000, undefined, "caller");
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private readonly pages = new Map<string, Page>();
  private readonly evaluations = new Set<Promise<unknown>>();
  private stopping: Promise<DriverCleanup> | undefined;
  uncertain = false;
  constructor(
    private readonly engine: keyof typeof engines,
    private readonly scratch: string,
    private readonly launchArgs?: readonly string[],
  ) {}
  async start(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    // The host already added its own scratch directory below the supervised root.
    // Give the browser a sibling, not another nested layer in its socket-path budget.
    await this.lifecycle.init(dirname(this.scratch));
    const profile = await this.lifecycle.directory(this.lifecycle.scratch, "p-");
    this.context = await (this.launchArgs === undefined
      ? this.lifecycle.persistent(this.engine, profile)
      : this.lifecycle.persistent(this.engine, profile, this.launchArgs));
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    this.pages.set("root", this.page);
    this.page.on("console", (message) => {
      if (message.type() === "error") console.error("Local runner console", message.text());
    });
    this.page.on("pageerror", (error) => console.error("Local runner page error", error));
    this.page.on("requestfailed", (request) =>
      console.error("Local runner request failed", request.url(), request.failure()),
    );
  }
  private readonly observedWindows = new Map<string, string>();
  private readonly observations = new Map<string, DriverObservation>();
  async observe(binding: DriverObservationBinding): Promise<DriverObservation> {
    if (this.observations.has(binding.expectedURL) || this.observedWindows.has(binding.window))
      throw new Error("Document generation already observed");
    const page = this.current();
    if (
      (await this.handle(binding.signal)) !== binding.window ||
      page.url() !== binding.bootstrapURL
    )
      throw new Error("Observation is not the exact existing Page");
    const observation = observePlaywrightPage(page, binding);
    this.observations.set(binding.expectedURL, observation);
    this.observedWindows.set(binding.window, binding.expectedURL);
    let retirement: Promise<void> | undefined;
    return {
      failure: observation.failure,
      ...(binding.console
        ? { console: () => observation.console(), settleConsole: () => observation.settleConsole() }
        : {}),
      navigationComplete: () => observation.navigationComplete(),
      check: () => observation.check(),
      workers: () => observation.workers(),
      onRequest: (callback) => observation.onRequest(callback),
      onWorker: (callback) => observation.onWorker(callback),
      waitForWorkerClose: (worker) => observation.waitForWorkerClose(worker),
      waitForWorkerURLClose: (url) => observation.waitForWorkerURLClose(url),
      beginDocumentClose: (nextURL) => observation.beginDocumentClose(nextURL),
      documentClosed: () => observation.documentClosed(),
      revokeActions: () => observation.revokeActions(),
      revoke: () => observation.revoke(),
      stop: () =>
        (retirement ??= observation.stop().then(() => {
          this.observations.delete(binding.expectedURL);
          this.observedWindows.delete(binding.window);
        })),
    };
  }
  private current(): Page {
    if (!this.page) throw new Error("No page");
    return this.page;
  }
  async createWindow(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (!this.context) throw new Error("No context");
    const page = await this.context.newPage();
    const handle = crypto.randomUUID();
    this.pages.set(handle, page);
    return handle;
  }
  async selectWindow(handle: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const page = this.pages.get(handle);
    if (!page || page.isClosed()) throw new Error("Unknown window handle");
    this.page = page;
  }
  async reloadWindow(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    try {
      await this.current().reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
    } catch (error) {
      this.uncertain = true;
      throw error;
    }
  }
  async closeWindow(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    try {
      await this.current().close();
    } catch (error) {
      this.uncertain = true;
      throw error;
    }
  }
  async navigate(url: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    try {
      await navigateTestPage(this.current(), url, { timeout: 15_000 });
    } catch (error) {
      this.uncertain = true;
      throw error;
    }
  }
  async handle(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    for (const [handle, page] of this.pages) {
      if (page === this.current() && !page.isClosed()) return handle;
    }
    throw new Error("Current window closed");
  }
  async handles(signal: AbortSignal): Promise<string[]> {
    signal.throwIfAborted();
    return Array.from(this.pages)
      .filter(([, page]) => !page.isClosed())
      .map(([handle]) => handle);
  }
  async url(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    return this.current().url();
  }
  async script(source: string, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    try {
      const raw: Promise<unknown> = this.current().evaluate(
        (script) => new Function(script)(),
        source,
      );
      this.evaluations.add(raw);
      const settled = () => {
        this.evaluations.delete(raw);
      };
      void raw.then(settled, settled);
      const value: unknown = await bounded(raw, 3000, "script probe");
      const encoded = JSON.stringify({ value });
      if (new TextEncoder().encode(encoded).byteLength > driverResponseLimit)
        throw new Error("WebDriver response exceeds 4 MiB UTF-8 limit");
      return value;
    } catch (error) {
      this.uncertain = true;
      if (error instanceof DeadlineError) throw new WebDriverError("script timeout", error.message);
      throw error;
    }
  }
  async press(key: HostKey, control: DriverPressControl): Promise<void> {
    try {
      await control.dispatch(() => this.current().keyboard.press(key));
    } catch (error) {
      this.uncertain = true;
      throw error;
    }
  }
  stop(): Promise<DriverCleanup> {
    return (this.stopping ??= this.stopOnce());
  }
  private async stopOnce(): Promise<DriverCleanup> {
    let observationFailure: { reason: unknown } | undefined;
    try {
      const results = await Promise.allSettled(
        Array.from(this.observations.values(), (owner) => owner.stop()),
      );
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    } catch (error) {
      observationFailure = { reason: error };
    }
    try {
      await this.lifecycle.close();
      await Promise.allSettled(this.evaluations);
      if (observationFailure) throw observationFailure.reason;
      return {
        session: { status: "confirmed", detail: "Local browser context stopped" },
        launcher: { status: "confirmed", detail: "Local browser joined" },
        serviceDisposition: "No native service",
      };
    } catch (error) {
      return {
        session: {
          status: "unconfirmed",
          detail: `${String(error)}; browser root ${this.lifecycle.scratch}`,
        },
        launcher: {
          status: "unconfirmed",
          detail: `${String(error)}; browser root ${this.lifecycle.scratch}`,
        },
        serviceDisposition: "No native service",
      };
    }
  }
}
