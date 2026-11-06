import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createVitest } from "vitest/node";
import type { ViteUserConfig } from "vitest/config";
import type { ViteDevServer } from "vite";
import { webdriverio, WebdriverBrowserProvider } from "@vitest/browser-webdriverio";
import { attach } from "webdriverio";
import {
  createFrameworkControl,
  type AttachedConnection,
  type FrameworkHost,
  type VitestEnd,
} from "waffle/testing/page-runner/framework";

function settleLater<T>(promise: Promise<T>, settled: () => void): void {
  void promise.then(settled, settled);
}
const directory = process.cwd();
const mode = process.env.W3_MODE ?? "unowned";
const requests: { method: string; path: string; body: unknown }[] = [];
const element = { "element-6066-11e4-a52e-4f735466cecf": "actual-frame" };
const caps = {
  browserName: "Safari",
  browserVersion: "26.5",
  platformName: "iOS",
  "safari:useSimulator": true,
  "safari:deviceUDID": "control-device",
  extraActual: "retained",
};
let malformed = false;
let releaseLookup: (() => void) | undefined;
let lookupHeld = false;
let navigation: string | undefined;
async function answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString();
  const body: unknown = text ? JSON.parse(text) : null;
  const path = request.url ?? "/";
  requests.push({ method: request.method ?? "", path, body });
  if (path.endsWith("/element") && lookupHeld)
    await new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
  if (path.endsWith("/execute/sync") && malformed) {
    response.end("{broken");
    return;
  }
  if (
    path.endsWith("/url") &&
    request.method === "POST" &&
    typeof body === "object" &&
    body !== null &&
    "url" in body
  )
    navigation = String(body.url);
  let value: unknown = null;
  if (path === "/session") value = { sessionId: "owned-session", capabilities: caps };
  if (path.endsWith("/context")) {
    response.statusCode = 405;
    value = {
      error: "unknown command",
      message: "CONTROL ONLY: tolerated context request",
      stacktrace: "",
    };
  }
  if (path.endsWith("/window")) value = "actual-window";
  if (path.endsWith("/window/handles")) value = ["actual-window"];
  if (path.endsWith("/element")) value = element;
  if (path.endsWith("/elements")) value = [element];
  if (path.endsWith("/element/actual-frame/name")) value = "iframe";
  if (path.endsWith("/execute/sync")) value = null;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ value }));
}
const fake = createServer((request, response) => {
  void answer(request, response).catch((error) => {
    response.statusCode = 500;
    response.end(String(error));
  });
});
// Teardown is installed before either owned listener is started.
let host: FrameworkHost | undefined;
let descriptor: AttachedConnection | undefined;
let provider: WebdriverBrowserProvider | undefined;
const trace: string[] = [];
const navigationEnd = Promise.withResolvers<void>();
void navigationEnd.promise.catch(() => {});
const viteServers = new Set<ViteDevServer>();
let context: Awaited<ReturnType<typeof createVitest>> | undefined;
const close = async () => {
  await context?.close();
  fake.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    fake.close((error) => (error ? reject(error) : resolve())),
  );
};
try {
  fake.listen(0, "127.0.0.1");
  await once(fake, "listening");
  const address = fake.address();
  if (!address || typeof address === "string") throw new Error("No fake listener");
  const file = join(directory, "control.browser.test.ts");
  await writeFile(
    file,
    'import { test } from "vitest"; test("not executed by the HTTP fake", () => { throw new Error("must not execute"); });',
  );
  host = createFrameworkControl(
    {
      suite: "installed-sdk-control",
      native: { udid: "control-device" },
      expected: [
        {
          file,
          fullName: "not executed by the HTTP fake",
          sourceKey: "control:1",
          timeoutMs: 15000,
          retries: 0,
        },
      ],
      scope: { kind: "root-selection", command: "test:browser", files: [file] },
      resultPath: join(directory, "result.json"),
    },
    `http://127.0.0.1:${address.port}/`,
  );
  const ownedHost = host;
  class AttachedProvider extends WebdriverBrowserProvider {
    private closed = false;
    override async openBrowser() {
      if (this.closed) throw new Error("Attached provider closed");
      if (this.browser) return this.browser;
      this.browser = await ownedHost.attach({
        connect: (connection) => {
          descriptor = connection;
          return attach({
            ...connection,
            options: {
              ...connection.options,
              beforeCommand: function () {
                ownedHost.requestStarted(this);
              },
              transformRequest: (request) => ownedHost.guardRequest(request),
              transformResponse: (response, request) =>
                ownedHost.observeResponse(response, request),
              afterCommand: () => ownedHost.requestSettled({ kind: "completed" }),
            },
          });
        },
        detach: () => this.close(),
        frames: {
          isTestFrame: () => this.isIframeSwitched(),
          main: () => this.switchToMainFrame(),
          tester: () => this.switchToTestFrame(),
        },
      });
      return this.browser;
    }
    override async openPage(sessionId: string, url: string) {
      if (this.closed) throw new Error("Attached provider closed");
      await this.openBrowser();
      await ownedHost.openPage(url, () => super.openPage(sessionId, url));
      await navigationEnd.promise;
    }
    override switchToTestFrame() {
      return ownedHost.provider("test-frame", () => super.switchToTestFrame());
    }
    override switchToMainFrame() {
      return ownedHost.provider("main-frame", () => super.switchToMainFrame());
    }
    override async close() {
      this.closed = true;
      await ownedHost.detach();
      this.browser = null;
    }
    override async setViewport() {
      throw new Error("Explicit viewport unsupported");
    }
  }
  const stock = webdriverio({});
  const attached = {
    ...stock,
    providerFactory(project: ConstructorParameters<typeof WebdriverBrowserProvider>[0]) {
      provider = new AttachedProvider(project, {});
      return provider;
    },
  };
  const result = await host.run(async (registerClose) => {
    const nativeConfig = {
      test: {
        reporters: ["default"],
        testTimeout: 15000,
        hookTimeout: 30000,
        retry: 0,
        fileParallelism: false,
        include: [file],
        browser: {
          enabled: true,
          headless: false,
          ui: false,
          screenshotFailures: false,
          connectTimeout: 60000,
          provider: attached,
          instances: [{ browser: "safari" }],
        },
      },
      plugins: [
        {
          name: "owned-collector",
          configureServer(server) {
            viteServers.add(server);
            server.middlewares.use(ownedHost.middleware);
          },
        },
      ],
    } satisfies ViteUserConfig;
    context = await createVitest(
      "test",
      { root: directory, config: false, watch: false },
      nativeConfig,
    );
    registerClose(async () => {
      await context?.close();
      for (const server of viteServers) assert.equal(server.httpServer?.listening, false);
      trace.push("context-closed");
    });
    const starting = context.start([file]);
    void starting.catch(() => {});
    for (let attempt = 0; !navigation && attempt < 200; attempt++) await delay(10);
    assert.ok(navigation, "normal start must call inherited openPage");
    assert.ok(descriptor);
    assert.equal(descriptor.sessionId, "owned-session");
    assert.deepEqual(descriptor.capabilities, caps);
    assert.equal(descriptor.requestedCapabilities.browserName, "Safari");
    assert.equal(descriptor.options.connectionRetryCount, 0);
    assert.equal(descriptor.options.connectionRetryTimeout, 5000);
    const server = context.projects.find((project) => project.browser)?.browser;
    assert.ok(server);
    const url = new URL(navigation);
    assert.equal(url.pathname, "/__vitest_test__/");
    const vite = await fetch(new URL("/@vite/client", navigation));
    assert.equal(vite.status, 200);
    assert.match(await vite.text(), /WebSocket/);
    assert.equal((await fetch(new URL("/report", navigation))).status, 405);
    assert.ok(provider?.browser);
    const actualProvider = provider;
    const browser = provider.browser;
    assert.equal(actualProvider.isIframeSwitched(), false);
    await ownedHost.provider("test-frame", () => actualProvider.switchToTestFrame());
    assert.equal(actualProvider.isIframeSwitched(), true);
    await ownedHost.provider("main-frame", () => actualProvider.switchToMainFrame());
    assert.equal(actualProvider.isIframeSwitched(), false);
    lookupHeld = true;
    const switching = actualProvider.switchToTestFrame();
    for (let attempt = 0; !releaseLookup && attempt < 100; attempt++) await delay(5);
    assert.ok(releaseLookup, "Inherited lookup must be pending");
    let probed = false;
    const probe = ownedHost.provider("framework-cleanup", async () => {
      probed = true;
      trace.push("serialized-probe");
    });
    await delay(30);
    assert.equal(probed, false, "Probe must not pass an inherited pending frame operation");
    lookupHeld = false;
    releaseLookup();
    await switching;
    await probe;
    assert.equal(actualProvider.isIframeSwitched(), true);
    await actualProvider.switchToMainFrame();
    trace.push("nested-public-frame-bookkeeping");
    const beforeForbidden = requests.length;
    try {
      if (mode === "malformed") {
        malformed = true;
        await ownedHost.provider("framework-cleanup", async () => {
          await browser.execute(() => true).catch(() => {});
        });
      } else if (mode === "expired") {
        const later = Promise.withResolvers<void>();
        await ownedHost.provider("framework-cleanup", async () => {
          setTimeout(() => {
            settleLater(browser.getTitle(), later.resolve);
          }, 15);
        });
        await later.promise;
        assert.equal(requests.length, beforeForbidden);
      } else {
        if (mode === "revoked") await actualProvider.close();
        await browser.getTitle().catch(() => {});
        assert.equal(requests.length, beforeForbidden);
      }
    } finally {
      navigationEnd.reject(new Error("EXPECTED_FINITE_FAKE_ABORT"));
    }
    trace.push(`${mode}-rejection-caught`);
    await starting;
    return { status: "interrupted", errors: ["finite fake abort"] } satisfies VitestEnd;
  });
  await writeFile(
    join(directory, `result-${mode}.json`),
    JSON.stringify({ result, requests, trace }, null, 2),
  );
  assert.equal(result.exit, 2);
  assert.equal(result.fileComplete, false);
  assert.equal(result.rootBrowserSuiteComplete, false);
  assert.equal(
    requests.filter((request) => request.method === "POST" && request.path === "/session").length,
    1,
  );
  assert.equal(requests.filter((request) => request.method === "DELETE").length, 1);
  assert.equal(result.cleanup.callbacks.status, "confirmed");
  assert.equal(result.cleanup.scratch.status, "confirmed");
  assert.ok(provider);
  await assert.rejects(provider.openBrowser(), /closed/);
  await mkdir(join(directory, "evidence"), { recursive: true });
  await writeFile(
    join(directory, "evidence/checkpoint.json"),
    JSON.stringify(
      {
        descriptor,
        navigation,
        requests,
        trace,
        result,
        browserExecuted: false,
        nativeCredit: false,
      },
      null,
      2,
    ),
  );
  process.exitCode = 0; // The ordinary reporter correctly failed the deliberately aborted fake run.
  console.log(
    "Installed Node / real Vite / normal createVitest.start / real attached provider: finite abort and checked cleanup confirmed",
  );
} finally {
  navigationEnd.reject(new Error("EXPECTED_FINITE_FAKE_ABORT"));
  await close();
}
