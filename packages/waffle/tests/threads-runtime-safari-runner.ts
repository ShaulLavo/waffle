import { open, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { assertRuntimeSafariPacket } from "./threads-runtime-safari-packet.js";
import { runtimeThreadCases, type RuntimeThreadCase } from "./threads-runtime-cases.js";

export const runtimeSafariCases = runtimeThreadCases;
type RuntimeCase = RuntimeThreadCase;
type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
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
    signal: AbortSignal.timeout(method === "DELETE" ? 10000 : 120000),
  };
  if (body !== undefined) options.body = JSON.stringify(body);
  const response = await fetch(base + path, options);
  const result = object(await response.json());
  if (!response.ok) throw new Error(`WebDriver ${path}: ${JSON.stringify(result)}`);
  return result.value;
}

async function durableJson(path: string, value: unknown): Promise<void> {
  const file = await open(path, "wx");
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
}

export function runtimeSafariScript(selected: RuntimeCase, fixtureSha256: string): string {
  return `const done = arguments[arguments.length - 1];
const NativeWorker = globalThis.Worker;
const events = [];
const records = new WeakMap();
globalThis.Worker = class extends NativeWorker {
  constructor(url, options) {
    super(url, options);
    const record = {url: String(url), messages: [], errors: [], nativeStops: 0};
    records.set(this, record);
    events.push(record);
    this.addEventListener('message', event => record.messages.push({kind: event.data?.kind ?? typeof event.data, revoked: event.data?.revoked, causalSequence: event.data?.causalSequence, at: performance.now()}));
    this.addEventListener('error', event => record.errors.push(event.message));
  }
  terminate() {
    records.get(this).nativeStops++;
    return super.terminate();
  }
};
const documentIdentity = () => ({ ...globalThis.__waffleRuntimeSafariDocument,
  url: location.href, observedTimeOrigin: performance.timeOrigin });
import('/runtime-page.js').then(module => module.runThreadsRuntime(${JSON.stringify(selected)}, false, ${JSON.stringify(fixtureSha256)}))
.then(result => done({ document: documentIdentity(), result, causalEvents: globalThis.__waffleRuntimeSafariCausalEvents, workerEvents: events }),
error => done({ document: documentIdentity(), failure: String(error), stack: error?.stack, causalEvents: globalThis.__waffleRuntimeSafariCausalEvents, workerEvents: events }))
.finally(() => { globalThis.Worker = NativeWorker; });`;
}

const workerControlScript = `const done = arguments[arguments.length - 1];
const nonce = arguments[0];
const identity = Object.freeze({ nonce, url: location.href, timeOrigin: performance.timeOrigin });
Object.defineProperty(globalThis, '__waffleRuntimeSafariDocument', {value: identity});
const shared = new SharedArrayBuffer(4);
const url = URL.createObjectURL(new Blob([
  'onmessage = ({data}) => { Atomics.store(new Int32Array(data.shared), 0, 42); postMessage(data.nonce); };'
], {type: 'text/javascript'}));
const worker = new Worker(url);
const finish = value => { clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(url); done(value); };
const timer = setTimeout(() => finish({failure: 'real Worker control timeout'}), 10000);
worker.onerror = event => finish({failure: event.message});
worker.onmessage = event => finish({ nonce: event.data, atomic: Atomics.load(new Int32Array(shared), 0),
  isolated: crossOriginIsolated, url: identity.url, timeOrigin: identity.timeOrigin });
worker.postMessage({shared, nonce});`;

async function execute(
  driver: string,
  session: string,
  script: string,
  args: unknown[],
): Promise<JsonObject> {
  const result = object(
    await command(driver, `/session/${session}/execute/async`, { script, args }),
  );
  return result;
}

function servePacket(directory: string, port: number) {
  const allowed = [
    "runtime-page.js",
    "fs-worker.js",
    "preview1-worker.js",
    "thread-barrier.js",
    "thread-service.js",
    "thread-guest.js",
    "threads.wasm",
  ];
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request) {
      const path = new URL(request.url).pathname.slice(1);
      const body =
        path === ""
          ? "<!doctype html><title>Waffle Runtime Safari proof</title>"
          : allowed.includes(path)
            ? Bun.file(resolve(directory, path))
            : undefined;
      const contentType = path.endsWith(".js")
        ? "text/javascript"
        : path.endsWith(".wasm")
          ? "application/wasm"
          : "text/html";
      return new Response(body ?? "Not found", {
        status: body === undefined ? 404 : 200,
        headers: {
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "require-corp",
          "Cache-Control": "no-store",
          "Content-Type": contentType,
        },
      });
    },
  });
}

function desktopCapabilities(value: unknown): JsonObject {
  const capabilities = object(value);
  if (capabilities.browserName !== "Safari" && capabilities.browserName !== "safari")
    throw new Error("not actual Safari");
  if (capabilities.platformName !== "macOS" || capabilities["safari:useSimulator"] !== false)
    throw new Error("not desktop Safari");
  return capabilities;
}

export async function runThreadsRuntimeSafari(options: {
  directory: string;
  driver: string;
  port: number;
  output: string;
  selected?: readonly RuntimeCase[];
}): Promise<JsonObject> {
  const { directory, driver, port, output } = options;
  const manifest = await assertRuntimeSafariPacket(directory);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid server port");
  if (resolve(directory) === resolve(output))
    throw new Error("results must be outside immutable packet");
  let session: string | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let cleaning: Promise<void> | undefined;
  const cleanup = () =>
    (cleaning ??= (async () => {
      try {
        if (session) await command(driver, `/session/${session}`, undefined, "DELETE");
      } finally {
        await server?.stop(true);
      }
    })());
  const interrupt = () => void cleanup().finally(() => process.exit(1));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const deadline = setTimeout(interrupt, 600000);
  try {
    await mkdir(output, { recursive: true });
    server = servePacket(directory, port);
    const created = object(
      await command(driver, "/session", {
        capabilities: { alwaysMatch: { browserName: "safari", platformName: "mac" } },
      }),
    );
    if (typeof created.sessionId !== "string") throw new Error("Safari session missing identity");
    session = created.sessionId;
    const capabilities = desktopCapabilities(created.capabilities);
    await durableJson(join(output, "session.json"), { session, capabilities, manifest });
    await command(driver, `/session/${session}/timeouts`, { script: 120000 });
    const results: JsonObject[] = [];
    const timeOrigins = new Set<unknown>();
    for (const selected of options.selected ?? runtimeSafariCases) {
      const url = new URL(`?case=${selected}&run=${crypto.randomUUID()}`, server.url).href;
      await command(driver, `/session/${session}/url`, { url });
      const window = await command(driver, `/session/${session}/window`, undefined, "GET");
      const nonce = crypto.randomUUID();
      const control = await execute(driver, session, workerControlScript, [nonce]);
      if (
        control.nonce !== nonce ||
        control.atomic !== 42 ||
        control.isolated !== true ||
        control.url !== url
      )
        throw new Error(`real Worker control failed for ${selected}`);
      if (typeof control.timeOrigin !== "number" || timeOrigins.has(control.timeOrigin))
        throw new Error(`document reused for ${selected}`);
      timeOrigins.add(control.timeOrigin);
      await durableJson(join(output, `${selected}-control.json`), { window, control });
      const report = await execute(
        driver,
        session,
        runtimeSafariScript(selected, manifest.fixtureSha256),
        [],
      );
      await durableJson(join(output, `${selected}-raw.json`), report);
      if ("failure" in report) throw new Error(JSON.stringify(report));
      const document = object(report.document);
      const row = object(report.result);
      if (
        document.nonce !== nonce ||
        document.url !== url ||
        document.timeOrigin !== control.timeOrigin ||
        row.selected !== selected
      )
        throw new Error(
          `Runtime case identity changed for ${selected}: ${JSON.stringify({ control, document, selected: row.selected })}`,
        );
      if (row.isolated !== true) throw new Error(`Runtime case lost isolation for ${selected}`);
      const evidence = {
        selected,
        source: manifest.source,
        manifest,
        capabilities,
        window,
        control,
        ...report,
      };
      await durableJson(join(output, `${selected}.json`), evidence);
      results.push(evidence);
      console.log(JSON.stringify({ case: selected, result: row, document }));
    }
    await cleanup();
    const summary = {
      manifest,
      capabilities,
      results,
      cleanup: { sessionDeleted: true, serverStopped: true },
    };
    await durableJson(join(output, "summary.json"), summary);
    return summary;
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await cleanup();
  }
}

if (import.meta.main) {
  const [directory, driver, port, output, requested] = process.argv.slice(2);
  const selected =
    requested === undefined ? undefined : runtimeSafariCases.filter((mode) => mode === requested);
  if (selected?.length === 0) throw new Error("unknown Runtime case");
  if (!directory || !driver || !output)
    throw new Error("usage: runner.mjs PACKET DRIVER_URL PORT OUTPUT [CASE]");
  await runThreadsRuntimeSafari({
    directory: resolve(directory),
    driver,
    port: Number(port),
    output: resolve(output),
    selected,
  });
}
