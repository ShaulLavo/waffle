import type { BrowserContext, Page, Request, Response } from "playwright";

export interface StorageLockStartupDiagnostic {
  phase: "new-page" | "navigation";
  target: string;
  current: string | null;
  closed: boolean;
  events: string[];
}

export async function storageLockKeepAlive(
  context: BrowserContext,
  target: string,
  report: (diagnostic: StorageLockStartupDiagnostic) => void,
): Promise<Page> {
  const events: string[] = [];
  const record = (event: string) => {
    if (events.length === 16) events.shift();
    events.push(event.slice(0, 512));
  };
  const path = (url: string) => new URL(url).pathname;
  const requested = (request: Request) => record(`request ${path(request.url())}`);
  const responded = (response: Response) =>
    record(`response ${response.status()} ${path(response.url())}`);
  const failed = (request: Request) =>
    record(`requestfailed ${path(request.url())} ${request.failure()?.errorText ?? "unknown"}`);
  const loaded = () => record("load");
  const dom = () => record("domcontentloaded");
  const crashed = () => record("crash");
  const errored = (error: Error) => record(`pageerror ${error.message}`);
  let page: Page | undefined;
  let phase: StorageLockStartupDiagnostic["phase"] = "new-page";
  try {
    page = await context.newPage();
    page.on("request", requested);
    page.on("response", responded);
    page.on("requestfailed", failed);
    page.on("load", loaded);
    page.on("domcontentloaded", dom);
    page.on("crash", crashed);
    page.on("pageerror", errored);
    phase = "navigation";
    await page.goto(target);
    return page;
  } catch (error) {
    report({
      phase,
      target: path(target),
      current: page ? path(page.url()) : null,
      closed: page?.isClosed() ?? true,
      events,
    });
    throw error;
  } finally {
    page?.off("request", requested);
    page?.off("response", responded);
    page?.off("requestfailed", failed);
    page?.off("load", loaded);
    page?.off("domcontentloaded", dom);
    page?.off("crash", crashed);
    page?.off("pageerror", errored);
  }
}
