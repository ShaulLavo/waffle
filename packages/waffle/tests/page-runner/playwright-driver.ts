import type { BrowserContext, Page } from "playwright";
import { BrowserRunnerLifecycle, type engines } from "../browser-runner-lifecycle.js";
import type { Driver, DriverCleanup } from "./driver.js";
/** Local runner regressions only. Not an iOS adapter or a replacement storage body. */
export class PlaywrightDriver implements Driver {
  private lifecycle = new BrowserRunnerLifecycle();
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private stopping: Promise<DriverCleanup> | undefined;
  uncertain = false;
  constructor(
    private readonly engine: keyof typeof engines,
    private readonly scratch: string,
  ) {}
  async start(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.lifecycle.init(this.scratch);
    const profile = await this.lifecycle.directory(this.lifecycle.scratch, "p-");
    this.context = await this.lifecycle.persistent(this.engine, profile);
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
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
  async navigate(url: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    try {
      await this.current().goto(url, { timeout: 15_000 });
    } catch (error) {
      this.uncertain = true;
      throw error;
    }
  }
  async handle(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    return "root";
  }
  async handles(signal: AbortSignal): Promise<string[]> {
    signal.throwIfAborted();
    return this.current().isClosed() ? [] : ["root"];
  }
  async url(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    return this.current().url();
  }
  async script(source: string, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    return this.current().evaluate((script) => new Function(script)(), source);
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
        session: { status: "unconfirmed", detail: String(error) },
        launcher: { status: "unconfirmed", detail: String(error) },
        serviceDisposition: "No native service",
      };
    }
  }
}
