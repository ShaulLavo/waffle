import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createRelayBrowserFixture } from "../tests/network-relay-fixture.js";
import { relaySocketModules } from "../tests/network-relay-modules.js";
import type { RelayBrowserConfig } from "../tests/network-relay-contract.js";

const deadlineMs = 120_000;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("WebDriver returned a non-object");
  return Object.fromEntries(Object.entries(value));
}
async function command(
  base: string,
  path: string,
  body?: unknown,
  method = "POST",
  signal?: AbortSignal,
) {
  const options: RequestInit = {
    method,
    headers: { "content-type": "application/json" },
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)])
      : AbortSignal.timeout(deadlineMs),
  };
  if (body !== undefined) options.body = JSON.stringify(body);
  const response = await fetch(`${base}${path}`, options);
  const payload = object(await response.json());
  if (!response.ok) throw new Error(`WebDriver ${path}: ${JSON.stringify(payload)}`);
  return payload.value;
}
function sessionId(value: unknown): string {
  const id = object(value).sessionId;
  if (typeof id !== "string" || !id) throw new Error("WebDriver did not return a session ID");
  return id;
}
function browserFailure(error: unknown) {
  let value: string;
  try {
    value = String(error);
  } catch {
    value = "<unprintable>";
  }
  const failure = { type: error === null ? "null" : typeof error, value };
  try {
    if (error === null || (typeof error !== "object" && typeof error !== "function"))
      return { failure };
    const stack = "stack" in error ? error.stack : undefined;
    if (typeof stack === "string") return { failure: { ...failure, stack } };
  } catch {
    return { failure };
  }
  return { failure };
}
type SessionOutcome =
  | { kind: "success"; value: { capabilities: unknown; report: unknown } }
  | { kind: "failure"; error: unknown };
/** @public Driver boundary also exercised by the portable runner tests. */
export async function runWorkspaceSafariSession(
  driver: string,
  origin: string,
  signal?: AbortSignal,
  entry:
    | keyof typeof import("../tests/workspace-safari-browser.js")
    | keyof typeof import("../tests/network-relay-browser.js") = "runWorkspaceSafari",
) {
  const session = object(
    await command(driver, "/session", {
      capabilities: { alwaysMatch: { browserName: "safari" } },
    }),
  );
  const id = sessionId(session);
  let outcome: SessionOutcome;
  try {
    const capabilities = object(session.capabilities);
    if (
      typeof capabilities.browserName !== "string" ||
      capabilities.browserName.toLowerCase() !== "safari"
    )
      throw new Error("Driver did not allocate Safari");
    await command(driver, `/session/${id}/timeouts`, { script: deadlineMs }, "POST", signal);
    await command(driver, `/session/${id}/url`, { url: origin }, "POST", signal);
    const report = object(
      await command(
        driver,
        `/session/${id}/execute/async`,
        {
          script: `const done = arguments[arguments.length - 1];
          import('/browser.js').then(module => module.${entry}())
            .then(report => done({ report }), error => done((${browserFailure.toString()})(error)));`,
          args: [],
        },
        "POST",
        signal,
      ),
    );
    if ("failure" in report) throw new Error(JSON.stringify(report));
    if (!("report" in report)) throw new Error("Safari did not return a workspace report");
    outcome = {
      kind: "success",
      value: { capabilities: session.capabilities, report: report.report },
    };
  } catch (error) {
    outcome = { kind: "failure", error };
  }
  try {
    await command(driver, `/session/${id}`, undefined, "DELETE", AbortSignal.timeout(10_000));
  } catch (error) {
    if (outcome.kind === "failure")
      throw new AggregateError(
        [outcome.error, error],
        "Safari verification and session cleanup failed",
      );
    throw error;
  }
  if (outcome.kind === "failure") throw outcome.error;
  return outcome.value;
}
/** @public Serves only the three prepared fixture bundles on loopback. */
export function serveWorkspaceSafari(directory: string) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const allowed = ["/browser.js", "/guest.js", "/fs-worker.js"];
      const body =
        path === "/"
          ? "<!doctype html><title>Workspace Safari verification</title>"
          : allowed.includes(path)
            ? Bun.file(resolve(directory, path.slice(1)))
            : undefined;
      return new Response(body ?? "Not found", {
        status: body === undefined ? 404 : 200,
        headers: {
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "require-corp",
          "cache-control": "no-store",
          "content-type": path.endsWith(".js") ? "text/javascript" : "text/html",
        },
      });
    },
  });
}
/** @public Build once on the source host; the Mac needs no checkout or dependency install. */
export async function prepareWorkspaceSafari(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const entries = [
    ["browser", resolve(import.meta.dir, "../tests/workspace-safari-browser.ts")],
    ["guest", resolve(import.meta.dir, "../tests/workspace-safari-guest.ts")],
    ["fs-worker", Bun.resolveSync("waffle/browser/fs-worker", import.meta.dir)],
  ];
  await prepareBundles(directory, entries);
}
async function prepareBundles(
  directory: string,
  entries: readonly (readonly string[])[],
): Promise<void> {
  for (const [filename, entry] of entries) {
    if (!filename || !entry) throw new Error("Missing fixture entry");
    const built = await Bun.build({ entrypoints: [entry], target: "browser", minify: true });
    if (!built.success || !built.outputs[0])
      throw new AggregateError(built.logs, "Fixture build failed");
    await Bun.write(resolve(directory, `${filename}.js`), built.outputs[0]);
  }
  const runner = await Bun.build({
    entrypoints: [import.meta.path],
    target: "bun",
    minify: true,
  });
  if (!runner.success || !runner.outputs[0])
    throw new AggregateError(runner.logs, "Runner build failed");
  await Bun.write(resolve(directory, "runner.mjs"), runner.outputs[0]);
}
/** @public Portable forced-WebSocket relay fixture. No native peer or WebTransport claim. */
export async function prepareNetworkRelaySafari(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await prepareBundles(directory, [
    ["browser", resolve(import.meta.dir, "../tests/network-relay-browser.ts")],
    ["relay-helper-worker", resolve(import.meta.dir, "../tests/network-relay-worker.ts")],
    ["relay-preview1-worker", Bun.resolveSync("waffle/browser/preview1-worker", import.meta.dir)],
    ["relay-fs", Bun.resolveSync("waffle/browser/fs-worker", import.meta.dir)],
  ]);
  for (const [path, bytes] of await relaySocketModules())
    await Bun.write(resolve(directory, path.slice(1)), bytes);
  await Bun.write(
    resolve(directory, "network.wasm"),
    Bun.file(new URL("../browser/net/network.wasm", import.meta.url)),
  );
}
/** @public The portable relay page serves only prepared assets and controlled fixture endpoints. */
export function serveNetworkRelaySafari(
  directory: string,
  fixture: ReturnType<typeof createRelayBrowserFixture>,
  config: () => RelayBrowserConfig,
) {
  const allowed = new Set([
    "/browser.js",
    "/relay-helper-worker.js",
    "/relay-preview1-worker.js",
    "/relay-fs.js",
    "/relay-echo.wasm",
    "/relay-reset.wasm",
    "/network.wasm",
  ]);
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/relay-config") return Response.json(config());
      if (path === "/relay-idle") return fixture.idle();
      const headers = {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "cache-control": "no-store",
        "content-type": path.endsWith(".wasm")
          ? "application/wasm"
          : path.endsWith(".js")
            ? "text/javascript"
            : "text/html",
      };
      if (path === "/")
        return new Response("<!doctype html><title>Local relay Safari verification</title>", {
          headers,
        });
      return new Response(
        allowed.has(path) ? Bun.file(resolve(directory, path.slice(1))) : "Not found",
        { status: allowed.has(path) ? 200 : 404, headers },
      );
    },
  });
}
async function waitForDriver(driver: string, child: ReturnType<typeof Bun.spawn>): Promise<void> {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`safaridriver exited ${child.exitCode}`);
    try {
      await command(driver, "/status", undefined, "GET", AbortSignal.timeout(1000));
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error("safaridriver did not become ready within 10 seconds");
}
async function run(directory: string, relayCase = false): Promise<void> {
  if (process.platform !== "darwin") throw new Error("Actual Safari verification requires macOS");
  let server: ReturnType<typeof serveWorkspaceSafari> | undefined;
  let probe: ReturnType<typeof Bun.serve> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const relay = relayCase ? createRelayBrowserFixture() : undefined;
  let relayConfig: RelayBrowserConfig | undefined;
  const configuration = () => {
    if (!relayConfig) throw new Error("Relay fixture is not ready");
    return relayConfig;
  };
  const interruption = new AbortController();
  const interrupt = () => interruption.abort(new Error("Safari verification interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    server = relay
      ? serveNetworkRelaySafari(directory, relay, configuration)
      : serveWorkspaceSafari(directory);
    if (relay) relayConfig = await relay.start(server.url.origin, false);
    probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port;
    await probe.stop(true);
    child = Bun.spawn(["/usr/bin/safaridriver", "--port", String(port)], {
      stdout: "ignore",
      stderr: "inherit",
    });
    timer = setTimeout(interrupt, deadlineMs + 20_000);
    const driver = `http://127.0.0.1:${port}`;
    await waitForDriver(driver, child);
    interruption.signal.throwIfAborted();
    const result = await runWorkspaceSafariSession(
      driver,
      `http://127.0.0.1:${server.port}`,
      interruption.signal,
      relayCase ? "networkRelayBrowserCases" : "runWorkspaceSafari",
    );
    if (relay) relay.verify(["websocket"]);
    console.log(
      JSON.stringify({ runtime: "actual Safari via /usr/bin/safaridriver", ...result }, null, 2),
    );
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    child?.kill("SIGKILL");
    if (child) await child.exited;
    await probe?.stop(true);
    await server?.stop(true);
    await relay?.close();
  }
}
if (import.meta.main) {
  const [mode, directory] = process.argv.slice(2);
  if (!directory || !["--prepare", "--run", "--relay-prepare", "--relay-run"].includes(mode ?? ""))
    throw new Error(
      "Usage: bun tooling/workspace-safari-runner.ts --prepare|--run|--relay-prepare|--relay-run DIRECTORY",
    );
  if (mode === "--prepare") await prepareWorkspaceSafari(resolve(directory));
  else if (mode === "--relay-prepare") await prepareNetworkRelaySafari(resolve(directory));
  else await run(resolve(directory), mode === "--relay-run");
}
