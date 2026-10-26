import { expect, mock, test } from "bun:test";
import { resolve } from "node:path";
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

async function rejectionOf(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to reject");
}

async function navigateWithThrowingReporter(
  fixture: ReturnType<typeof navigationFixture>,
  cleanup: () => void,
): Promise<void> {
  try {
    await storageNavigate({
      diagnostics: new NavigationDiagnostics(),
      page: fixture.page,
      context: fixture.context,
      browser: fixture.browser,
      target: "http://127.0.0.1:33049/",
      caseName: "webkit opfs: labelled case",
      report() {
        throw new Error("diagnostic reporter failure");
      },
    });
  } finally {
    cleanup();
  }
}

function emitPageCallback(
  fixture: ReturnType<typeof navigationFixture>,
  event: string,
  argument: unknown,
): void {
  const registration = fixture.page.on.mock.calls.find(([name]) => name === event);
  expect(registration).toBeDefined();
  if (!registration) return;
  Reflect.apply(registration[1], fixture.page, [argument]);
}

const navigationRejections: unknown[] = [
  new Error("original navigation failure"),
  0,
  false,
  null,
  undefined,
  "",
];
for (const [index, original] of navigationRejections.entries())
  test(`throwing reporter preserves original rejection and cleanup ${index}`, async () => {
    const fixture = navigationFixture();
    fixture.page.goto.mockImplementation(() => Promise.reject(original));
    const cleanup = mock<() => void>();

    const rejection = await rejectionOf(navigateWithThrowingReporter(fixture, cleanup));

    expect(rejection).toBe(original);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expectListenersRemoved(fixture);
  });

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

test("throwing request, response, and abort observers preserve the response", async () => {
  const controller = new AbortController();
  const request = new Request("http://127.0.0.1/", { signal: controller.signal });

  const response = storageNavigationResponse(request, { "/": "ok" }, () => {
    throw new Error("diagnostic observer failure");
  });
  controller.abort();

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("ok");
});

for (const mode of ["acquire", "emit"])
  test(`real loopback survives throwing observer ${mode}`, async () => {
    const lifecycle = new BrowserRunnerLifecycle(60_000, 5);
    const getObserver = () => {
      if (mode === "acquire") throw new Error("diagnostic acquisition failure");
      return () => {
        throw new Error("diagnostic emission failure");
      };
    };
    try {
      const origin = lifecycle.serve({ "/": "ok" }, 0, getObserver);

      const response = await fetch(origin);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
    } finally {
      await lifecycle.close();
    }
  });

test("real route errors remain outside diagnostic guards", () => {
  const routes: Record<string, Blob | string> = {
    get "/"(): string {
      throw new TypeError("real route failure");
    },
  };

  expect(() =>
    storageNavigationResponse(new Request("http://127.0.0.1/"), routes, () => {
      throw new Error("diagnostic observer failure");
    }),
  ).toThrow("real route failure");
});

test("throwing error observers leave real route errors to Bun", () => {
  const script = `import { BrowserRunnerLifecycle } from ${JSON.stringify(resolve(import.meta.dir, "browser-runner-lifecycle.ts"))};
    const lifecycle = new BrowserRunnerLifecycle(60000, 5);
    const routes = { get "/fail"() { throw new TypeError("real route failure"); } };
    try {
      const origin = lifecycle.serve(routes, 0, () => () => { throw new Error("diagnostic observer failure"); });
      const response = await fetch(origin + "/fail");
      console.log(JSON.stringify({ status: response.status }));
    } finally {
      await lifecycle.close();
    }`;

  const result = Bun.spawnSync([process.execPath, "--eval", script], { timeout: 5000 });

  expect(result.stdout.toString()).toBe('{"status":500}\n');
  expect(result.stderr.toString()).toContain("real route failure");
  expect(result.stderr.toString()).not.toContain("diagnostic observer failure");
});

test("registered page callbacks record fixed categories instead of sensitive text", async () => {
  const marker = "SensitiveCategoryProbe token=synthetic-test-token";
  const fixture = navigationFixture();
  const navigationError = new Error("original navigation failure");
  const synthetic = new Error("sensitive error message");
  synthetic.name = marker;
  fixture.page.goto.mockImplementation(async () => {
    emitPageCallback(fixture, "pageerror", synthetic);
    emitPageCallback(fixture, "requestfailed", {
      url: () => "http://127.0.0.1/",
      failure: () => ({ errorText: marker }),
    });
    throw navigationError;
  });
  let report = "";

  await expect(
    storageNavigate({
      diagnostics: new NavigationDiagnostics(),
      page: fixture.page,
      context: fixture.context,
      browser: fixture.browser,
      target: "http://127.0.0.1:33049/",
      caseName: "callback probe",
      report: (text) => {
        report = text;
      },
    }),
  ).rejects.toBe(navigationError);

  expect(report).not.toContain(marker);
  expect(report).not.toContain("sensitive error message");
  expect(report).toContain("page pageerror Error");
  expect(report).toContain("page requestfailed / failed");
});

test("registered pageerror snapshots a mutable category once", async () => {
  const marker = "SyntheticSensitiveMarker";
  const fixture = navigationFixture();
  const navigationError = new Error("original navigation failure");
  const changing = new Error("sensitive error message");
  const throwing = new Error("sensitive error message");
  let changingReads = 0;
  let throwingReads = 0;
  Object.defineProperty(changing, "name", {
    get() {
      return ++changingReads === 1 ? "TypeError" : marker;
    },
  });
  Object.defineProperty(throwing, "name", {
    get() {
      throwingReads++;
      throw new Error("accessor failure");
    },
  });
  fixture.page.goto.mockImplementation(async () => {
    emitPageCallback(fixture, "pageerror", changing);
    emitPageCallback(fixture, "pageerror", throwing);
    throw navigationError;
  });
  let report = "";

  const rejection = await rejectionOf(
    storageNavigate({
      diagnostics: new NavigationDiagnostics(),
      page: fixture.page,
      context: fixture.context,
      browser: fixture.browser,
      target: "http://127.0.0.1:33049/",
      caseName: "accessor callback probe",
      report: (text) => {
        report = text;
      },
    }),
  );

  expect(rejection).toBe(navigationError);
  expect(changingReads).toBe(1);
  expect(throwingReads).toBe(1);
  expect(report).not.toContain(marker);
  expect(report).toContain("page pageerror TypeError");
  expect(report).toContain("page pageerror Error");
  expectListenersRemoved(fixture);
});

test("server errors snapshot mutable categories and contain accessor failures", () => {
  const changing = new Error("secret message");
  const throwing = new Error("secret message");
  let changingReads = 0;
  let throwingReads = 0;
  Object.defineProperty(changing, "name", {
    get() {
      return ++changingReads === 1 ? "TypeError" : "SyntheticSensitiveMarker";
    },
  });
  Object.defineProperty(throwing, "name", {
    get() {
      throwingReads++;
      throw new Error("accessor failure");
    },
  });

  expect(navigationServerError(changing)).toEqual({ kind: "server-error", name: "TypeError" });
  expect(navigationServerError(throwing)).toEqual({ kind: "server-error", name: "Error" });
  expect(changingReads).toBe(1);
  expect(throwingReads).toBe(1);
});

test("server errors retain only their error category", () => {
  const synthetic = new TypeError("secret message");
  synthetic.name = "SensitiveCategoryProbe token=synthetic-test-token";
  expect(navigationServerError(synthetic)).toEqual({
    kind: "server-error",
    name: "Error",
  });
  expect(navigationServerError(new TypeError("secret message"))).toEqual({
    kind: "server-error",
    name: "TypeError",
  });
  expect(navigationServerError("secret message")).toEqual({
    kind: "server-error",
    name: "NonError",
  });
});
