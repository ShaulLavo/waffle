import { expect, mock, test } from "bun:test";
import type { Browser, BrowserContext, Page } from "playwright";
import { BrowserRunnerLifecycle } from "./browser-runner-lifecycle.ts";
import {
  NavigationDiagnostics,
  navigationServerError,
  storageNavigate,
  storageNavigationResponse,
  type NavigationServerEvent,
} from "./storage-navigation-diagnostics.ts";

test("navigation capture stays bounded and labels construction without claiming delivery", () => {
  const diagnostics = new NavigationDiagnostics();
  for (let index = 0; index < 97; index++) diagnostics.record(`event ${index}`);
  diagnostics.record("third\ncontinued");

  const report = diagnostics.report("webkit opfs: labelled case");

  expect(report).toContain("Navigation diagnostics for webkit opfs: labelled case");
  expect(report).not.toContain("event 0");
  expect(report).toContain("event 96");
  expect(report).toContain("third continued");
  expect(report).toContain("2 earlier event(s) dropped");
  expect(report).toContain(
    "response-constructed is local only; wire delivery and native cancellation reason remain unknown",
  );
});

function navigationFixture() {
  type NavigationPage = Parameters<typeof storageNavigate>[0]["page"];
  const page = {
    on: mock<(event: string, listener: (...args: never[]) => void) => Page>(),
    off: mock<(event: string, listener: (...args: never[]) => void) => Page>(),
    mainFrame: mock<NavigationPage["mainFrame"]>(),
    goto: mock<Page["goto"]>().mockResolvedValue(null),
  };
  const context = {
    on: mock<(event: string, listener: (...args: never[]) => void) => BrowserContext>(),
    off: mock<(event: string, listener: (...args: never[]) => void) => BrowserContext>(),
  };
  const browser = {
    on: mock<(event: string, listener: (...args: never[]) => void) => Browser>(),
    off: mock<(event: string, listener: (...args: never[]) => void) => Browser>(),
  };
  return { page, context, browser };
}

function expectListenersRemoved({ page, context, browser }: ReturnType<typeof navigationFixture>) {
  expect(page.on.mock.calls.map(([event]) => event)).toEqual([
    "request",
    "response",
    "requestfailed",
    "requestfinished",
    "framenavigated",
    "load",
    "domcontentloaded",
    "crash",
    "close",
    "pageerror",
  ]);
  expect(page.off.mock.calls).toEqual(page.on.mock.calls);
  expect(context.on.mock.calls.map(([event]) => event)).toEqual(["close"]);
  expect(context.off.mock.calls).toEqual(context.on.mock.calls);
  expect(browser.on.mock.calls.map(([event]) => event)).toEqual(["disconnected"]);
  expect(browser.off.mock.calls).toEqual(browser.on.mock.calls);
}

test("failed navigation dumps its capture before unregistering every listener", async () => {
  const fixture = navigationFixture();
  const navigationError = new Error("labelled navigation failure");
  fixture.page.goto.mockRejectedValue(navigationError);
  const report = mock<(diagnostic: string) => void>(() => {
    expect(fixture.page.off).not.toHaveBeenCalled();
    expect(fixture.context.off).not.toHaveBeenCalled();
    expect(fixture.browser.off).not.toHaveBeenCalled();
  });
  const diagnostics = new NavigationDiagnostics();
  diagnostics.record("before navigation");

  await expect(
    storageNavigate({
      diagnostics,
      page: fixture.page,
      context: fixture.context,
      browser: fixture.browser,
      target: "http://127.0.0.1:33049/",
      caseName: "webkit opfs: labelled case",
      report,
    }),
  ).rejects.toBe(navigationError);

  expect(report).toHaveBeenCalledTimes(1);
  expect(report.mock.calls[0]?.[0]).toContain("before navigation");
  expect(report.mock.calls[0]?.[0]).toContain("webkit opfs: labelled case");
  expectListenersRemoved(fixture);
});

test("successful navigation preserves the target and stays silent", async () => {
  const fixture = navigationFixture();
  const report = mock<(diagnostic: string) => void>();

  await storageNavigate({
    diagnostics: new NavigationDiagnostics(),
    page: fixture.page,
    context: fixture.context,
    browser: fixture.browser,
    target: "http://127.0.0.1:33049/",
    caseName: "webkit indexeddb: labelled case",
    report,
  });

  expect(fixture.page.goto).toHaveBeenCalledWith("http://127.0.0.1:33049/");
  expect(report).not.toHaveBeenCalled();
  expectListenersRemoved(fixture);
});

test("request abort is recorded once without changing the constructed response", async () => {
  const controller = new AbortController();
  const request = new Request("http://127.0.0.1/", { signal: controller.signal });
  const events: NavigationServerEvent[] = [];

  const response = storageNavigationResponse(request, { "/": "ok" }, (event) => events.push(event));
  controller.abort();
  controller.abort();

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("ok");
  expect(events).toEqual([
    { kind: "request", method: "GET", path: "/" },
    { kind: "response-constructed", path: "/", status: 200 },
    { kind: "request-aborted", path: "/" },
  ]);
});

test("real loopback preserves the root response and records only local server milestones", async () => {
  const interruptListeners = process.listenerCount("SIGINT");
  const terminateListeners = process.listenerCount("SIGTERM");
  const lifecycle = new BrowserRunnerLifecycle(60_000, 5);
  const events: NavigationServerEvent[] = [];
  try {
    const origin = lifecycle.serve(
      { "/": "<!doctype html><title>Storage tests</title>" },
      0,
      () => (event) => events.push(event),
    );

    const response = await fetch(origin);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("text/html");
    expect(await response.text()).toBe("<!doctype html><title>Storage tests</title>");
    expect(events).toEqual([
      { kind: "request", method: "GET", path: "/" },
      { kind: "response-constructed", path: "/", status: 200 },
    ]);
  } finally {
    await lifecycle.close();
  }
  expect(process.listenerCount("SIGINT")).toBe(interruptListeners);
  expect(process.listenerCount("SIGTERM")).toBe(terminateListeners);
});

test("server errors retain only their error category", () => {
  expect(navigationServerError(new TypeError("secret message"))).toEqual({
    kind: "server-error",
    name: "TypeError",
  });
  expect(navigationServerError("secret message")).toEqual({
    kind: "server-error",
    name: "NonError",
  });
});
