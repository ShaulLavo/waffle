import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  prepareWorkspaceSafari,
  runWorkspaceSafariSession,
  serveWorkspaceSafari,
} from "../tooling/workspace-safari-runner.js";

async function driverFixture(mode: "success" | "failure" | "wrong-browser" | "abort") {
  const abort = new AbortController();
  const calls: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
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
  const directory = await mkdtemp(resolve(process.env.TMPDIR ?? "/work/tmp", "w-safari-"));
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
  } finally {
    await server?.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("local Chromium controller import does not start a browser", async () => {
  const entry = await import("./workspace-safari-local.js");
  expect(typeof entry.runWorkspaceSafariLocal).toBe("function");
});
