import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { threadBrowserModes, type ThreadBrowserMode } from "./threads-browser-contract.ts";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("expected JSON object");
  return Object.fromEntries(Object.entries(value));
}
async function command(
  base: string,
  path: string,
  body?: unknown,
  method = "POST",
): Promise<unknown> {
  const options: RequestInit = {
    method,
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(method === "DELETE" ? 10000 : 90000),
  };
  if (body !== undefined) options.body = JSON.stringify(body);
  const response = await fetch(base + path, options);
  const result = object(await response.json());
  if (!response.ok) throw new Error(`WebDriver ${path}: ${JSON.stringify(result)}`);
  return result.value;
}
async function closeSession(
  driver: string,
  session: string | undefined,
  server: ReturnType<typeof Bun.serve> | undefined,
) {
  try {
    if (session) await command(driver, `/session/${session}`, undefined, "DELETE");
  } finally {
    server?.stop(true);
  }
}
/** @public Uses a task-owned desktop Safari session, never a simulator or Playwright WebKit. */
export async function runThreadsSafari(
  directory: string,
  driver: string,
  port: number,
  modes: readonly ThreadBrowserMode[] = threadBrowserModes(),
) {
  const allowed = [
    "threads-page.js",
    "threads-guest.js",
    "threads-service.js",
    "fs-worker.js",
    "threads.wasm",
  ];
  const manifest = object(await Bun.file(resolve(directory, "manifest.json")).json());
  if (!Array.isArray(manifest.assets)) throw new Error("missing packet asset digests");
  const expectedScripts = allowed.filter((name) => name.endsWith(".js"));
  const remaining = new Set(expectedScripts);
  for (const asset of manifest.assets) {
    const record = object(asset);
    if (typeof record.path !== "string" || !remaining.delete(record.path))
      throw new Error("invalid asset path");
    const bytes = await Bun.file(resolve(directory, record.path)).arrayBuffer();
    if (createHash("sha256").update(new Uint8Array(bytes)).digest("hex") !== record.sha256)
      throw new Error(`packet digest mismatch ${record.path}`);
  }
  if (remaining.size) throw new Error("packet is missing required scripts");
  const receipt = await Bun.file(resolve(directory, "threads.receipt.json")).arrayBuffer();
  if (createHash("sha256").update(new Uint8Array(receipt)).digest("hex") !== manifest.receiptSha256)
    throw new Error("receipt digest mismatch");
  const wasm = await Bun.file(resolve(directory, "threads.wasm")).arrayBuffer();
  if (createHash("sha256").update(new Uint8Array(wasm)).digest("hex") !== manifest.fixtureSha256)
    throw new Error("fixture digest mismatch");
  let session: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let cleaning: Promise<void> | undefined;
  const cleanup = () => (cleaning ??= closeSession(driver, session, server));
  const interrupt = () => void cleanup().finally(() => process.exit(1));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const deadline = setTimeout(interrupt, 180000);
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch(request) {
        const path = new URL(request.url).pathname.slice(1);
        const body =
          path === ""
            ? "<!doctype html><title>Waffle thread browser proof</title>"
            : allowed.includes(path)
              ? Bun.file(resolve(directory, path))
              : undefined;
        return new Response(body ?? "Not found", {
          status: body === undefined ? 404 : 200,
          headers: {
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
            "Cache-Control": "no-store",
            "Content-Type": path.endsWith(".js")
              ? "text/javascript"
              : path.endsWith(".wasm")
                ? "application/wasm"
                : "text/html",
          },
        });
      },
    });
    const created = object(
      await command(driver, "/session", {
        capabilities: { alwaysMatch: { browserName: "safari", platformName: "mac" } },
      }),
    );
    if (typeof created.sessionId !== "string") throw new Error("Safari session missing identity");
    session = created.sessionId;
    const capabilities = object(created.capabilities);
    if (capabilities.browserName !== "Safari" && capabilities.browserName !== "safari")
      throw new Error("not actual Safari");
    if (capabilities.platformName !== "macOS" || capabilities["safari:useSimulator"] !== false)
      throw new Error("not desktop Safari");
    await command(driver, `/session/${session}/timeouts`, { script: 90000 });
    await command(driver, `/session/${session}/url`, { url: server.url.href });
    const window = await command(driver, `/session/${session}/window`, undefined, "GET");
    const report = object(
      await command(driver, `/session/${session}/execute/async`, {
        script: `const selected = arguments[0]; const done = arguments[arguments.length - 1]; import('/threads-page.js').then(module => module.runThreadsBrowser(selected)).then(report => done({report}), error => done({failure: String(error), stack: error?.stack}));`,
        args: [modes],
      }),
    );
    if ("failure" in report) throw new Error(JSON.stringify(report));
    const result = object(report.report);
    if (result.fixtureSha256 !== manifest.fixtureSha256)
      throw new Error("Safari artifact hash differs");
    await cleanup();
    return {
      manifest,
      capabilities,
      window,
      report: result,
      cleanup: { sessionDeleted: true, serverStopped: true },
    };
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await cleanup();
  }
}
if (import.meta.main) {
  const directory = process.argv[2];
  const driver = process.argv[3];
  const port = Number(process.argv[4]);
  if (!directory || !driver || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("usage: runner.mjs PACKET DRIVER_URL EXPLICIT_PORT");
  console.log(
    JSON.stringify(
      await runThreadsSafari(resolve(directory), driver, port, threadBrowserModes(process.argv[5])),
      null,
      2,
    ),
  );
}
