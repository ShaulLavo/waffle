import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Collector } from "./collector.js";
import { WebDriverError } from "./driver.js";
import { SafariDriver, type NativeCommandFailure } from "./safari-driver.js";
import { probeDocument, runPageSuite, type SuiteAdapter } from "./suite-host.js";
import { record } from "./protocol.js";
import type { CommandFailure } from "./framework-types.js";

const udid = "10128D70-92A7-4626-9CE5-1537CF27BE84";
const secret = "PRIVATE_PAYLOAD_CANARY";
const policy = { listIds: () => ["control"], check() {} };
function controlServer(failPath: string, code = "unknown error", cleanupFails = false) {
  let navigated = false;
  let pageURL = `http://example.invalid/${secret}`;
  const calls: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname.replace(/\/session\/[^/]+/, "/session/:session");
      calls.push(`${request.method} ${path}`);
      if (path === "/session") return sessionResponse();
      if (request.method === "DELETE")
        return cleanupFails ? failure("invalid session id") : Response.json({ value: null });
      if (request.method === "POST" && path.endsWith("/url")) {
        const body: unknown = await request.json();
        if (!record(body) || typeof body.url !== "string") throw new Error("Expected control URL");
        pageURL = body.url;
        await hello(pageURL);
        navigated = true;
        return Response.json({ value: null });
      }
      if (navigated && path.endsWith(failPath)) return failure(code);
      if (path.endsWith("/window/handles")) return Response.json({ value: [secret] });
      if (path.endsWith("/window")) return Response.json({ value: secret });
      if (request.method === "GET" && path.endsWith("/url"))
        return Response.json({ value: pageURL });
      return Response.json({ value: null });
    },
  });
  return {
    server,
    calls,
    pageOrigin: () => new URL(pageURL).origin,
    arm: () => {
      navigated = true;
    },
  };
}
function sessionResponse(): Response {
  return Response.json({
    value: {
      sessionId: secret,
      capabilities: {
        browserName: "Safari",
        browserVersion: "control",
        platformName: "iOS",
        "safari:useSimulator": true,
        "safari:deviceUDID": udid,
      },
    },
  });
}
function failure(code: string): Response {
  return Response.json(
    { value: { error: code, message: secret, stacktrace: secret } },
    { status: 500 },
  );
}
async function hello(url: string): Promise<void> {
  const html = await (await fetch(url)).text();
  const config: unknown = JSON.parse(
    /window\.__suiteConfiguration=(.+?)<\/script>/.exec(html)?.[1] ?? "null",
  );
  if (!record(config)) throw new Error("Missing control configuration");
  const response = await fetch(new URL("/report", url), {
    method: "POST",
    body: JSON.stringify({
      run: config.run,
      token: config.token,
      group: config.group,
      doc: secret,
      seq: 0,
      kind: "hello",
    }),
  });
  expect(response.status).toBe(200);
}
function state() {
  const collector = new Collector("control", [], [], policy);
  const document = collector.expect(
    { id: "list", role: "list", caseIds: [] },
    secret,
    `http://example.invalid/${secret}`,
    secret,
  );
  document.doc = secret;
  return document;
}

for (const path of ["/window/handles", "/window", "/url", "/execute/sync"]) {
  test(`local HTTP probe preserves the first rejected ${path} command before classification`, async () => {
    const fixture = controlServer(
      path,
      path === "/execute/sync" ? "script timeout" : "unknown error",
    );
    const failures: CommandFailure[] = [];
    const driver = new SafariDriver(udid, "no-native-resources", (facts) => failures.push(facts));
    try {
      await driver.startControl(fixture.server.url.origin, AbortSignal.timeout(2000));
      fixture.arm();
      const classification = await probeDocument(state(), driver, AbortSignal.timeout(2000));
      expect(classification).toBe(path === "/execute/sync" ? "page-unresponsive" : "driver-lost");
      expect(driver.uncertain).toBe(true);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        path: `/session/:session${path}`,
        stage: "envelope",
        status: 500,
        abort: null,
        errorName: "WebDriverError",
        errorCode: path === "/execute/sync" ? "script timeout" : "unknown error",
      });
      expect(JSON.stringify(failures)).not.toContain(secret);
    } finally {
      await driver.stop();
      await stopControl(fixture);
    }
    expect(fixture.server.pendingRequests).toBe(0);
  });
}

test("local HTTP command preserves its original WebDriver exception even when observation throws", async () => {
  const fixture = controlServer("/execute/sync");
  let observed: CommandFailure | undefined;
  const driver = new SafariDriver(udid, "no-native-resources", (facts) => {
    observed = facts;
    throw new Error("observer failure");
  });
  try {
    await driver.startControl(fixture.server.url.origin, AbortSignal.timeout(2000));
    fixture.arm();
    const error = await driver
      .script(secret, AbortSignal.timeout(2000))
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(WebDriverError);
    if (!(error instanceof WebDriverError)) throw new Error("Expected original WebDriver error");
    expect(error.code).toBe("unknown error");
    expect(error.message).toBe(`unknown error: ${secret}`);
    expect(observed).toMatchObject({ errorName: "WebDriverError", errorCode: "unknown error" });
  } finally {
    await driver.stop();
    await stopControl(fixture);
  }
});

test("local SafariDriver response retains reporter control facts separately from driver HTTP status", async () => {
  const controlFailure = {
    run: "control-run",
    doc: "control-document",
    method: "POST",
    path: "/heartbeat",
    phase: "transport",
    status: null,
    error: "TimeoutError: control timeout",
    abort: "TimeoutError: control timeout",
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/session") return sessionResponse();
      return Response.json({
        value: path.endsWith("/execute/sync")
          ? { kind: "reporter-error", error: "Collector heartbeat failed", controlFailure }
          : null,
      });
    },
  });
  const failures: CommandFailure[] = [];
  const driver = new SafariDriver(udid, "no-native-resources", (facts) => failures.push(facts));
  try {
    await driver.startControl(server.url.origin, AbortSignal.timeout(2000));
    await expect(driver.script("control", AbortSignal.timeout(2000))).rejects.toThrow(
      JSON.stringify(controlFailure),
    );
    expect(failures[0]).toMatchObject({ stage: "envelope", status: 200 });
    expect(driver.uncertain).toBe(true);
  } finally {
    await driver.stop();
    await server.stop(true);
  }
  expect(server.pendingRequests).toBe(0);
});

for (const cleanupFails of [false, true]) {
  test(`host persists first native control failure with heartbeat age and unchanged cleanup ${cleanupFails}`, async () => {
    const fixture = controlServer("/window/handles", "unknown error", cleanupFails);
    let root = "";
    const adapter: SuiteAdapter<null> = {
      suite: "local-http-control-not-native-proof",
      policy,
      inventory: () => [{ id: "control", label: "control", request: () => null }],
      assets: async () => ({}),
      budgets: () => ({ hello: 1000, heartbeat: 15, case: 2000, group: 2000, run: 4000 }),
    };
    try {
      root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "native-facts-"));
      expect(dirname(root)).toBe(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir());
      const reads = { value: 0 };
      const result = await runPageSuite(
        adapter,
        (scratch, observeFailure) => reentrantDriver(fixture, scratch, observeFailure, reads),
        { resultPath: join(root, "result.json"), scratchRoot: root, port: "ephemeral" },
      );
      expect(result.exit).toBe(2);
      expect(result.runComplete).toBe(false);
      expect(result.results).toEqual({});
      expect(result.failures.slice(0, 2)).toEqual([
        { group: "list", category: "driver-lost", detail: "heartbeat-lost" },
        { group: "list", category: "driver-lost", detail: "Error: heartbeat-lost" },
      ]);
      expect(reads.value).toBe(1);
      const facts = result.firstCommandFailure;
      expect(facts).toMatchObject({
        client: "direct",
        method: "GET",
        path: "/session/:session/window/handles",
        stage: "envelope",
        status: 500,
        errorName: "WebDriverError",
        errorCode: "unknown error",
        abort: null,
      });
      if (!facts) throw new Error("Missing first command failure");
      expect(Object.isFrozen(facts)).toBe(true);
      expect(Reflect.set(facts, "errorCode", "invalid session id")).toBe(false);
      expect(facts.hostNow).toBeGreaterThanOrEqual(facts.settledAt);
      expect(facts.lastHeartbeatAgeMs).toBeGreaterThanOrEqual(15);
      expect(JSON.stringify(facts)).not.toContain(secret);
      expect(await Bun.file(join(root, "result.json")).json()).toEqual(result);
      expect(result.cleanup.session.status).toBe(cleanupFails ? "unconfirmed" : "confirmed");
      expect(result.cleanup.scratch.status).toBe(cleanupFails ? "unconfirmed" : "confirmed");
      expect(result.cleanup.server.status).toBe(cleanupFails ? "unconfirmed" : "confirmed");
      expect(result.cleanup.launcher.status).toBe("not-created");
      expect(fixture.calls.at(-1)).toBe("DELETE /session/:session");
      if (!cleanupFails) expect(await readdir(root)).toEqual(["result.json"]);
      await expect(fetch(fixture.pageOrigin())).rejects.toThrow();
    } finally {
      try {
        await stopControl(fixture);
      } finally {
        if (root) await rm(root, { recursive: true, force: true });
      }
    }
    expect(fixture.server.pendingRequests).toBe(0);
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
}

function reentrantDriver(
  fixture: ReturnType<typeof controlServer>,
  scratch: string,
  observeFailure: (facts: NativeCommandFailure) => void,
  reads: { value: number },
): SafariDriver {
  const driver = new SafariDriver(udid, scratch, (facts) => {
    observeFailure(
      reentrantFacts(facts, observeFailure, () => {
        reads.value++;
      }),
    );
  });
  driver.start = (signal) => driver.startControl(fixture.server.url.origin, signal);
  return driver;
}

function reentrantFacts(
  facts: NativeCommandFailure,
  observe: (facts: NativeCommandFailure) => void,
  read: () => void,
) {
  return {
    ...facts,
    get method() {
      read();
      observe({ ...facts, errorCode: "invalid session id" });
      return facts.method;
    },
    // Extra payload is deliberately outside the diagnostic's selected fields.
    payload: secret,
  };
}

for (const kind of ["accessor", "proxy", "private-name", "type-error"] as const) {
  test(`caller ${kind} rejection stays identical without reading payload or reentering observation`, async () => {
    const fixture = controlServer("/execute/sync");
    let reads = 0;
    const facts: NativeCommandFailure[] = [];
    const rejection = callerRejection(kind, () => {
      reads++;
    });
    const driver = new SafariDriver(udid, "no-native-resources", (fact) => {
      facts.push(fact);
      expect(Object.isFrozen(fact)).toBe(true);
      expect(Reflect.set(fact, "errorCode", secret)).toBe(false);
    });
    try {
      await driver.startControl(fixture.server.url.origin, AbortSignal.timeout(2000));
      const controller = new AbortController();
      controller.abort(rejection);
      const caught = await driver.script(secret, controller.signal).then(
        () => ({ reason: undefined }),
        (reason: unknown) => ({ reason }),
      );
      expect(caught.reason).toBe(rejection);
      expect(driver.uncertain).toBe(true);
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({
        stage: "headers",
        status: null,
        abort: "caller",
        errorName: kind === "type-error" ? "TypeError" : null,
        errorCode: null,
      });
      expect(JSON.stringify(facts)).not.toContain(secret);
      expect(reads).toBe(0);
    } finally {
      await driver.stop();
      await stopControl(fixture);
    }
  });
}
function callerRejection(kind: string, read: () => void): object {
  if (kind === "type-error") return new TypeError(secret);
  const error = new Error(secret);
  if (kind === "private-name") {
    error.name = secret;
    return error;
  }
  if (kind === "proxy")
    return new Proxy(error, {
      get() {
        read();
        throw new Error(secret);
      },
      getOwnPropertyDescriptor() {
        read();
        throw new Error(secret);
      },
      getPrototypeOf() {
        read();
        throw new Error(secret);
      },
    });
  for (const field of ["name", "code", "message", "stack"])
    Object.defineProperty(error, field, {
      get() {
        read();
        throw new Error(secret);
      },
    });
  return error;
}

test("unknown structured codes are omitted only from facts, never from the original rejection", async () => {
  const fixture = controlServer("/execute/sync", secret);
  const facts: NativeCommandFailure[] = [];
  const driver = new SafariDriver(udid, "no-native-resources", (fact) => facts.push(fact));
  try {
    await driver.startControl(fixture.server.url.origin, AbortSignal.timeout(2000));
    fixture.arm();
    const error = await driver
      .script(secret, AbortSignal.timeout(2000))
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(WebDriverError);
    if (!(error instanceof WebDriverError)) throw new Error("Expected original WebDriver error");
    expect(error.code).toBe(secret);
    expect(facts[0]).toMatchObject({ errorName: "WebDriverError", errorCode: null });
    expect(JSON.stringify(facts)).not.toContain(secret);
  } finally {
    await driver.stop();
    await stopControl(fixture);
  }
});

async function stopControl(fixture: ReturnType<typeof controlServer>): Promise<void> {
  const origin = fixture.server.url.origin;
  await fixture.server.stop(true);
  expect(fixture.server.pendingRequests).toBe(0);
  await expect(fetch(origin)).rejects.toThrow();
}
