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
} from "./driver.js";
/** Local runner regressions only. Not an iOS adapter or a replacement storage body. */
export class PlaywrightDriver implements Driver {
  private lifecycle = new BrowserRunnerLifecycle();
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private readonly pages = new Map<string, Page>();
  private stopping: Promise<DriverCleanup> | undefined;
  uncertain = false;
  constructor(
    private readonly engine: keyof typeof engines,
    private readonly scratch: string,
  ) {}
  async start(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    // The host already added its own scratch directory below the supervised root.
    // Give the browser a sibling, not another nested layer in its socket-path budget.
    await this.lifecycle.init(dirname(this.scratch));
    const profile = await this.lifecycle.directory(this.lifecycle.scratch, "p-");
    this.context = await this.lifecycle.persistent(this.engine, profile);
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
      const value: unknown = await bounded(
        this.current().evaluate((script) => new Function(script)(), source),
        3000,
        "script probe",
      );
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
  stop(): Promise<DriverCleanup> {
    return (this.stopping ??= this.stopOnce());
  }
  private async stopOnce(): Promise<DriverCleanup> {
    try {
      await this.lifecycle.close();
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
