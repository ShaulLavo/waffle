import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  prepareWorkspaceSafari,
  prepareNetworkRelaySafari,
  serveNetworkRelaySafari,
  runWorkspaceSafariSession,
  serveWorkspaceSafari,
} from "../tooling/workspace-safari-runner.js";
import { createRelayBrowserFixture } from "./network-relay-fixture.js";

async function driverFixture(
  mode: "success" | "failure" | "wrong-browser" | "abort" | "transport-failure",
  cleanupFails = false,
) {
  const abort = new AbortController();
  const calls: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (cleanupFails && request.method === "DELETE")
        return Response.json(
          { value: { error: "invalid session id", message: "session cleanup failed" } },
          { status: 404 },
        );
      if (mode === "transport-failure" && path.endsWith("/execute/async"))
        return Response.json(
          { value: { error: "unknown error", message: "execution transport failed" } },
          { status: 500 },
        );
      if (mode === "abort" && path.endsWith("/execute/async")) abort.abort();
      const value =
        path === "/session"
          ? {
              sessionId: "fixture-session",
              capabilities: { browserName: mode === "wrong-browser" ? "webkit" : "Safari" },
            }
          : path.endsWith("/execute/async")
            ? mode === "failure"
              ? { failure: "causal fixture failure" }
              : { report: { passed: ["driver transport fixture only"] } }
            : null;
      return Response.json({ value });
    },
  });
  try {
    return {
      result: await runWorkspaceSafariSession(
        `http://127.0.0.1:${server.port}`,
        "http://fixture.invalid",
        abort.signal,
      ),
      calls,
    };
  } finally {
    await server.stop(true);
    expect(calls.at(-1)).toBe("DELETE /session/fixture-session");
  }
}
test("Safari driver transport creates one session and closes it after success", async () => {
  const { result, calls } = await driverFixture("success");
  expect(result.report).toEqual({ passed: ["driver transport fixture only"] });
  expect(calls).toEqual([
    "POST /session",
    "POST /session/fixture-session/timeouts",
    "POST /session/fixture-session/url",
    "POST /session/fixture-session/execute/async",
    "DELETE /session/fixture-session",
  ]);
});
test("Safari driver transport closes the automation session after a browser failure", async () => {
  await expect(driverFixture("failure")).rejects.toThrow("causal fixture failure");
});
test("Safari driver rejects another engine and still closes its session", async () => {
  await expect(driverFixture("wrong-browser")).rejects.toThrow("Driver did not allocate Safari");
});
test("Safari driver closes its session when verification is interrupted", async () => {
  await expect(driverFixture("abort")).rejects.toThrow();
});
test("prepared public-package bundles serve with isolation and no source-tree access", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "w-safari-"));
  let server: ReturnType<typeof serveWorkspaceSafari> | undefined;
  try {
    await prepareWorkspaceSafari(directory);
    server = serveWorkspaceSafari(directory);
    const origin = `http://127.0.0.1:${server.port}`;
    const response = await fetch(`${origin}/browser.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
    expect(await response.text()).toContain("runWorkspaceSafari");
    expect((await fetch(`${origin}/package.json`)).status).toBe(404);
    expect(await Bun.file(resolve(directory, "runner.mjs")).size).toBeGreaterThan(0);
    const compiled: typeof import("../tooling/workspace-safari-runner.js") = await import(
      resolve(directory, "runner.mjs")
    );
    const script = await generatedScript(compiled.runWorkspaceSafariSession);
    const rejected = await executeGeneratedRejection(script, undefined);
    expect(rejected.thrown).toBeUndefined();
    expect(rejected.callbacks).toEqual([{ failure: { type: "undefined", value: "undefined" } }]);
  } finally {
    await server?.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("local Chromium controller import does not start a browser", async () => {
  const entry = await import("./workspace-safari-local.js");
  expect(typeof entry.runWorkspaceSafariLocal).toBe("function");
});

async function capturedFailure(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("Fixture unexpectedly succeeded");
}
const deletionFailure =
  'WebDriver /session/fixture-session: {"value":{"error":"invalid session id","message":"session cleanup failed"}}';
const transportFailure =
  'WebDriver /session/fixture-session/execute/async: {"value":{"error":"unknown error","message":"execution transport failed"}}';

test("verification and DELETE failures retain both exact errors in order", async () => {
  const failure = await capturedFailure(() => driverFixture("failure", true));
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError)) throw failure;
  expect(failure.message).toBe("Safari verification and session cleanup failed");
  expect(failure.errors).toEqual([
    new Error('{"failure":"causal fixture failure"}'),
    new Error(deletionFailure),
  ]);
});
test("execution transport and DELETE failures retain both exact errors in order", async () => {
  const failure = await capturedFailure(() => driverFixture("transport-failure", true));
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError)) throw failure;
  expect(failure.message).toBe("Safari verification and session cleanup failed");
  expect(failure.errors).toEqual([new Error(transportFailure), new Error(deletionFailure)]);
});
test("successful verification still fails when DELETE fails", async () => {
  const failure = await capturedFailure(() => driverFixture("success", true));
  expect(failure).toEqual(new Error(deletionFailure));
  expect(failure).not.toBeInstanceOf(AggregateError);
});
test("execution transport failure survives successful DELETE unchanged", async () => {
  const failure = await capturedFailure(() => driverFixture("transport-failure"));
  expect(failure).toEqual(new Error(transportFailure));
  expect(failure).not.toBeInstanceOf(AggregateError);
});

async function generatedScript(runSession = runWorkspaceSafariSession): Promise<string> {
  let script = "";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/session")
        return Response.json({
          value: { sessionId: "script-session", capabilities: { browserName: "Safari" } },
        });
      if (!path.endsWith("/execute/async")) return Response.json({ value: null });
      const body: unknown = await request.json();
      if (
        !body ||
        typeof body !== "object" ||
        !("script" in body) ||
        typeof body.script !== "string"
      )
        throw new Error("Runner did not send its generated script");
      script = body.script;
      return Response.json({ value: { report: "script captured" } });
    },
  });
  try {
    await runSession(`http://127.0.0.1:${server.port}`, "http://fixture.invalid");
    if (!script) throw new Error("Runner did not execute the browser script");
    return script;
  } finally {
    await server.stop(true);
  }
}
async function executeGeneratedRejection(script: string, rejection: unknown) {
  const imported = "import('/browser.js')";
  if (!script.includes(imported)) throw new Error("Generated script lost its fixture import");
  const execute = new Function("loadFixture", script.replace(imported, "return loadFixture()"));
  const callbacks: unknown[] = [];
  let thrown: unknown;
  try {
    await execute(
      () => Promise.resolve({ runWorkspaceSafari: () => Promise.reject(rejection) }),
      (value: unknown) => callbacks.push(value),
    );
  } catch (error) {
    thrown = error;
  }
  return { callbacks, thrown };
}
test("generated rejection handler calls back once with distinct falsy values and types", async () => {
  const script = await generatedScript();
  const cases = [
    { rejection: null, type: "null", value: "null" },
    { rejection: undefined, type: "undefined", value: "undefined" },
    { rejection: false, type: "boolean", value: "false" },
    { rejection: 0, type: "number", value: "0" },
    { rejection: "", type: "string", value: "" },
    { rejection: "null", type: "string", value: "null" },
    { rejection: "undefined", type: "string", value: "undefined" },
    { rejection: "false", type: "string", value: "false" },
    { rejection: "0", type: "string", value: "0" },
  ];
  for (const entry of cases) {
    const result = await executeGeneratedRejection(script, entry.rejection);
    expect(result.thrown).toBeUndefined();
    expect(result.callbacks).toEqual([{ failure: { type: entry.type, value: entry.value } }]);
    expect(JSON.parse(JSON.stringify(result.callbacks))).toEqual(result.callbacks);
  }
});
test("generated rejection handler narrows string stacks and tolerates unprintable objects", async () => {
  const script = await generatedScript();
  const failure = new Error("fixture rejected");
  const result = await executeGeneratedRejection(script, failure);
  expect(result.thrown).toBeUndefined();
  expect(result.callbacks).toEqual([
    { failure: { type: "object", value: "Error: fixture rejected", stack: failure.stack } },
  ]);
  const nonString = await executeGeneratedRejection(script, { stack: false });
  expect(nonString.thrown).toBeUndefined();
  expect(nonString.callbacks).toEqual([{ failure: { type: "object", value: "[object Object]" } }]);
  const unprintable = {
    toString() {
      throw new Error("string conversion failed");
    },
    get stack() {
      throw new Error("stack access failed");
    },
  };
  const guarded = await executeGeneratedRejection(script, unprintable);
  expect(guarded.thrown).toBeUndefined();
  expect(guarded.callbacks).toEqual([{ failure: { type: "object", value: "<unprintable>" } }]);
});

test("portable relay Safari assets include the shipped Preview 1 worker and remain WebSocket-only", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "w-relay-safari-"));
  const fixture = createRelayBrowserFixture();
  let server: ReturnType<typeof serveNetworkRelaySafari> | undefined;
  let configuration: Awaited<ReturnType<typeof fixture.start>> | undefined;
  try {
    await prepareNetworkRelaySafari(directory);
    server = serveNetworkRelaySafari(directory, fixture, () => {
      if (!configuration) throw new Error("fixture not ready");
      return configuration;
    });
    configuration = await fixture.start(server.url.origin, false);
    const origin = server.url.href;
    const config = await fetch(new URL("/relay-config", origin));
    expect(await config.json()).toMatchObject({ native: false });
    for (const path of [
      "browser.js",
      "relay-helper-worker.js",
      "relay-preview1-worker.js",
      "relay-fs.js",
      "relay-echo.wasm",
      "relay-reset.wasm",
      "network.wasm",
    ]) {
      const response = await fetch(new URL(path, origin));
      expect(response.ok, path).toBe(true);
      expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
      expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
      if (path.endsWith(".wasm"))
        expect(await WebAssembly.compile(await response.arrayBuffer())).toBeInstanceOf(
          WebAssembly.Module,
        );
    }
    expect((await fetch(new URL("package.json", origin))).status).toBe(404);
    const prepared: typeof import("../tooling/workspace-safari-runner.js") = await import(
      resolve(directory, "runner.mjs")
    );
    expect(typeof prepared.serveNetworkRelaySafari).toBe("function");
    expect(typeof prepared.runWorkspaceSafariSession).toBe("function");
    expect(await (await fetch(new URL("/relay-idle", origin))).json()).toEqual({
      sockets: 0,
      active: 0,
    });
  } finally {
    await server?.stop(true);
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});
