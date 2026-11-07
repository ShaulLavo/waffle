import { storagePolicy } from "./storage-policy.js";
import { expect, test } from "bun:test";
import {
  associateListener,
  nativeCapabilities,
  SafariDriver,
  driverResponseLimit,
  readDriverResponse,
} from "./safari-driver.js";
import { parseSession } from "./driver.js";
import { Collector } from "./collector.js";
import { probeDocument } from "./suite-host.js";
const udid = "10128D70-92A7-4626-9CE5-1537CF27BE84";
const capabilities = {
  browserName: "Safari",
  browserVersion: "26.5",
  platformName: "iOS",
  "safari:useSimulator": true,
  "safari:deviceUDID": udid,
  "safari:platformVersion": "26.5",
  "safari:deviceName": "iPhone",
};
test("native session parser records the exact session before checking its installed runtime tuple", () => {
  const answer = { sessionId: "owned-session", capabilities };
  expect(parseSession(answer)).toBe("owned-session");
  expect(nativeCapabilities(answer, udid)).toEqual({
    browserName: "Safari",
    browserVersion: "26.5",
    platformName: "iOS",
    simulator: true,
    deviceUDID: udid,
    platformVersion: "26.5",
    deviceName: "iPhone",
  });
});
for (const mismatch of [
  { "safari:deviceUDID": "wrong-device" },
  { browserName: "Chrome" },
  { platformName: "macOS" },
  { "safari:useSimulator": false },
  { "safari:useSimulator": undefined },
  { browserVersion: "" },
]) {
  test(`native session rejects mismatched capabilities ${JSON.stringify(mismatch)}`, () => {
    const answer = {
      sessionId: "retained-for-delete",
      capabilities: { ...capabilities, ...mismatch },
    };
    expect(parseSession(answer)).toBe("retained-for-delete");
    expect(() => nativeCapabilities(answer, udid)).toThrow();
  });
}

test("an HTTP response or foreign listener is not a launcher/XPC association", () => {
  const domain = "pid/100/com.apple.WebDriver.HTTPService = {\n\tpid = 321\n}";
  const identity =
    "321 1 501 Fri Nov 6 13:00:00 2026 /System/Library/PrivateFrameworks/WebDriver.framework/Versions/A/XPCServices/com.apple.WebDriver.HTTPService.xpc/Contents/MacOS/com.apple.WebDriver.HTTPService";
  expect(associateListener("p321\nn127.0.0.1:456", domain, identity, 100, 456, 501)?.kind).toBe(
    "launchd-service",
  );
  expect(associateListener("p321\nn127.0.0.1:456", "HTTP 200", identity, 100, 456, 501)).toBeNull();
  expect(associateListener("p321\nn127.0.0.1:456", domain, identity, 100, 456, 999)).toBeNull();
  expect(
    associateListener("p321\nn127.0.0.1:456\nnforeign:456", domain, identity, 100, 456, 501),
  ).toBeNull();
  expect(associateListener("p100\nn127.0.0.1:456", "", "", 100, 456, 501)).toEqual({
    kind: "launcher",
  });
});

test("structured script-timeout code survives HTTP transport and stops later dispatch", async () => {
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests++;
      const path = new URL(request.url).pathname;
      if (path.endsWith("/window/handles")) return Response.json({ value: ["root"] });
      if (path.endsWith("/window")) return Response.json({ value: "root" });
      if (path.endsWith("/url")) return Response.json({ value: "http://fixture/" });
      return Response.json(
        { value: { error: "script timeout", message: "", stacktrace: "" } },
        { status: 500 },
      );
    },
  });
  try {
    const driver = new SafariDriver(udid, "unused-no-native-start");
    Reflect.set(driver, "base", `http://127.0.0.1:${server.port}`);
    Reflect.set(driver, "session", "fixture-session");
    const collector = new Collector("run", [], [], storagePolicy);
    const state = collector.expect(
      { id: "list", role: "list", caseIds: [] },
      "token",
      "http://fixture/",
      "root",
    );
    state.doc = "doc";
    expect(await probeDocument(state, driver, AbortSignal.timeout(2000))).toBe("page-unresponsive");
    expect(driver.uncertain).toBe(true);
    const before = requests;
    await expect(driver.navigate("http://next/", AbortSignal.timeout(1000))).rejects.toThrow(
      "Uncertain",
    );
    expect(requests).toBe(before);
  } finally {
    await server.stop(true);
  }
});

test("bounded WebDriver response retains every interior integer", async () => {
  const actual = Array.from({ length: 196608 }, (_, index) => index % 251);
  actual[123456] = -1;
  const response = new Response(JSON.stringify({ value: actual }));
  const answer = await readDriverResponse(response, AbortSignal.timeout(1000));
  expect(answer).toEqual({ value: actual });
  expect(actual[123456]).toBe(-1);
});
for (const [label, bytes] of [
  [
    "overflow",
    new TextEncoder().encode(JSON.stringify({ value: "x".repeat(driverResponseLimit) })),
  ],
  ["malformed", new TextEncoder().encode('{"value":[1,2,')],
  ["invalid UTF-8", new Uint8Array([123, 34, 120, 34, 58, 34, 255, 34, 125])],
] as const) {
  test(`bounded WebDriver ${label} exposes no partial answer`, async () => {
    await expect(
      readDriverResponse(new Response(bytes), AbortSignal.timeout(1000)),
    ).rejects.toThrow();
  });
}
test("response byte count is streaming and ignores an undersized Content-Length", async () => {
  let offset = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset++ < 65) controller.enqueue(new Uint8Array(65536).fill(32));
        else controller.close();
      },
    }),
    { headers: { "Content-Length": "2" } },
  );
  await expect(readDriverResponse(response, AbortSignal.timeout(1000))).rejects.toThrow("4 MiB");
});
test("a response interrupted mid-array never exposes a value", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":[1,2,'));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await expect(readDriverResponse(response, AbortSignal.timeout(15))).rejects.toThrow();
  expect(cancelled).toBe(true);
});

test("peer WebDriver operations use the exact session paths and returned new-tab handle", async () => {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push({
        method: request.method,
        path,
        body: request.body ? await request.json() : null,
      });
      const value = path.endsWith("/window/new")
        ? { handle: "actual-tab", type: "tab" }
        : request.method === "DELETE"
          ? ["root"]
          : null;
      return Response.json({ value });
    },
  });
  try {
    const driver = new SafariDriver(udid, "no-native-resources");
    Reflect.set(driver, "base", `http://127.0.0.1:${server.port}`);
    Reflect.set(driver, "session", "exact/session");
    const signal = AbortSignal.timeout(2000);
    expect(await driver.createWindow(signal)).toBe("actual-tab");
    await driver.selectWindow("actual-tab", signal);
    await driver.reloadWindow(signal);
    await driver.closeWindow(signal);
    expect(calls).toEqual([
      { method: "POST", path: "/session/exact%2Fsession/window/new", body: { type: "tab" } },
      { method: "POST", path: "/session/exact%2Fsession/window", body: { handle: "actual-tab" } },
      { method: "POST", path: "/session/exact%2Fsession/refresh", body: null },
      { method: "DELETE", path: "/session/exact%2Fsession/window", body: null },
    ]);
    expect(driver.uncertain).toBe(false);
  } finally {
    await server.stop(true);
  }
});
for (const answer of [
  null,
  "guessed",
  { handle: "", type: "tab" },
  { handle: "tab", type: "unexpected" },
]) {
  test(`malformed new-tab answer stops subsequent destructive dispatch ${JSON.stringify(answer)}`, async () => {
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++;
        return Response.json({ value: answer });
      },
    });
    try {
      const driver = new SafariDriver(udid, "no-native-resources");
      Reflect.set(driver, "base", `http://127.0.0.1:${server.port}`);
      Reflect.set(driver, "session", "session");
      await expect(driver.createWindow(AbortSignal.timeout(1000))).rejects.toThrow(
        "Invalid new window",
      );
      await expect(driver.closeWindow(AbortSignal.timeout(1000))).rejects.toThrow("Uncertain");
      expect(requests).toBe(1);
    } finally {
      await server.stop(true);
    }
  });
}
for (const method of ["createWindow", "reloadWindow", "closeWindow"] as const) {
  test(`${method} abort owns uncertain transport and prevents another dispatch`, async () => {
    let requests = 0;
    const stop = Promise.withResolvers<void>();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        requests++;
        await stop.promise;
        return Response.json({ value: null });
      },
    });
    try {
      const driver = new SafariDriver(udid, "no-native-resources");
      Reflect.set(driver, "base", `http://127.0.0.1:${server.port}`);
      Reflect.set(driver, "session", "owned");
      await expect(driver[method](AbortSignal.timeout(15))).rejects.toThrow();
      expect(driver.uncertain).toBe(true);
      await expect(driver.reloadWindow(AbortSignal.timeout(1000))).rejects.toThrow("Uncertain");
      expect(requests).toBe(1);
    } finally {
      stop.resolve();
      await server.stop(true);
    }
  });
}
test("malformed refresh acknowledgement is uncertainty, not confirmed reload", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ value: { unexpected: true } }),
  });
  try {
    const driver = new SafariDriver(udid, "no-native-resources");
    Reflect.set(driver, "base", `http://127.0.0.1:${server.port}`);
    Reflect.set(driver, "session", "owned");
    await expect(driver.reloadWindow(AbortSignal.timeout(1000))).rejects.toThrow("Invalid refresh");
    expect(driver.uncertain).toBe(true);
  } finally {
    await server.stop(true);
  }
});

test("the captured successful Safari New Window reply accepts its actual window context type", async () => {
  // Captured by the parent on November 7, 2026. The requested tab type is a hint.
  const body = '{"value":{"handle":"page-ED5306A0-6D48-4770-B204-6CB3C1A0A2D7","type":"window"}}';
  let requested: unknown;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requested = await request.json();
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  try {
    const driver = new SafariDriver(udid, "no-native-resources");
    Reflect.set(driver, "base", `http://127.0.0.1:${server.port}`);
    Reflect.set(driver, "session", "owned-control");
    expect(await driver.createWindow(AbortSignal.timeout(1000))).toBe(
      "page-ED5306A0-6D48-4770-B204-6CB3C1A0A2D7",
    );
    expect(requested).toEqual({ type: "tab" });
    expect(driver.uncertain).toBe(false);
  } finally {
    await server.stop(true);
  }
});
