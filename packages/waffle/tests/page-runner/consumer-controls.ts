import { mkdir, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  runPageSuite,
  ownedDatabase,
  type SuiteAdapter,
  type PreparationContext,
  type SuiteResult,
} from "waffle/testing/page-runner";
import { PlaywrightDriver } from "waffle/testing/page-runner/playwright";

export const consumerControlModes = [
  "pass",
  "slow-seed",
  "cleanup-fail",
  "late-error",
  "wrong-allocation",
  "null",
  "missing",
  "oversize",
  "wrong-label",
  "duplicate",
  "reordered",
  "missing-errors",
  "errors",
  "partial",
];
type Request = { databaseName: string; encoded: string };
const id = "consumer: default",
  labels = ["chunk", "worker", "finally"];
function checkResult(_id: string, result: unknown): void {
  if (
    !result ||
    typeof result !== "object" ||
    !("ok" in result) ||
    result.ok !== true ||
    !("checks" in result) ||
    !Array.isArray(result.checks) ||
    result.checks.length !== labels.length ||
    result.checks.some((value, index) => value !== labels[index]) ||
    !("errors" in result) ||
    !Array.isArray(result.errors) ||
    result.errors.length ||
    !("settled" in result) ||
    result.settled !== true
  )
    throw new Error("Wrong settled consumer result");
}
export async function controlAssets(
  scratch: string,
  mode: string,
): Promise<Record<string, Blob | string>> {
  const out = join(scratch, "current");
  const built = await Bun.build({
    entrypoints: ["consumer-control-page.ts", "consumer-control-worker.ts"].map((file) =>
      join(import.meta.dir, file),
    ),
    outdir: out,
    target: "browser",
    splitting: true,
    naming: { entry: "[name].js", chunk: "chunks/[name]-[hash].[ext]" },
    define: { CONSUMER_CONTROL: JSON.stringify(mode) },
  });
  if (!built.success) throw new AggregateError(built.logs, "Consumer fixture build failed");
  await mkdir(join(out, "__bunwasm/chunks"), { recursive: true });
  await Promise.all([
    Bun.write(join(out, "index.html"), "<p>static sibling</p>"),
    Bun.write(
      join(out, "desktop.html"),
      '<script type="module" src="/current/consumer-control-page.js"></script>',
    ),
    Bun.write(join(out, "data.json"), '{"fixture":true}'),
    Bun.write(join(out, "module.wasm"), new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
    Bun.write(join(out, "__bunwasm/mirror.js"), 'export { marker } from "./chunks/mirror.js";'),
    Bun.write(join(out, "__bunwasm/chunks/mirror.js"), 'export const marker = "mirrored";'),
  ]);
  const files = await readdir(out, { recursive: true, withFileTypes: true });
  const assets: Record<string, Blob | string> = {};
  for (const file of files.filter((file) => file.isFile())) {
    const path = join(file.parentPath, file.name);
    assets[`/current/${relative(out, path)}`] = Bun.file(path);
  }
  if (!Object.keys(assets).some((path) => path.startsWith("/current/chunks/")))
    throw new Error(
      `Control has no real generated chunk: ${built.outputs.map((output) => output.path)}; files=${Object.keys(assets)}`,
    );
  return assets;
}
async function seedSentinel(): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("waffle-workspace");
    request.onupgradeneeded = () => request.result.createObjectStore("fixture");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("fixture", "readwrite");
      transaction.objectStore("fixture").put("W1-foreign-sentinel", "sentinel");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
async function removeSentinel(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("waffle-workspace");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Fixture sentinel removal blocked"));
  });
}
class ConsumerDriver extends PlaywrightDriver {
  seeded = false;
  verified = false;
  bodyVerified = false;
  injected = false;
  constructor(
    engine: "chromium" | "webkit",
    scratch: string,
    readonly mode: string,
    readonly assets: Record<string, Blob | string>,
  ) {
    super(engine, scratch);
  }
  override async navigate(url: string, signal: AbortSignal): Promise<void> {
    if (this.seeded) await this.verifyBody(signal);
    else await this.beforeHostedNavigation(new URL(url).origin, signal);
    await super.navigate(url, signal);
    const role = await this.inspect("return window.__suiteConfiguration.role", signal);
    if (role !== "list") return;
    const calls = await this.inspect(
      "return [window.__consumerBodyCalls, window.__consumerOpened]",
      signal,
    );
    if (JSON.stringify(calls) !== "[0,0]")
      throw new Error(`Hosted list invoked consumer envelope: ${JSON.stringify(calls)}`);
    await this.seed(signal);
  }
  private async inspect(source: string, signal: AbortSignal): Promise<unknown> {
    try {
      return await super.script(source, signal);
    } catch (error) {
      throw new Error(`Consumer ${this.mode} script ${source.slice(0, 90)}: ${String(error)}`, {
        cause: error,
      });
    }
  }
  private async waitForFixture(source: string, signal: AbortSignal): Promise<unknown> {
    for (;;) {
      signal.throwIfAborted();
      const value = await this.inspect(source, signal);
      if (value !== undefined) return value;
      await Bun.sleep(25);
    }
  }
  private async seed(signal: AbortSignal): Promise<void> {
    const delay = this.mode === "slow-seed" ? 3500 : 0;
    await this.inspect(
      `window.__consumerSeed = undefined;
      void new Promise(resolve => setTimeout(resolve, ${delay})).then(${seedSentinel.toString()})
        .then(() => { window.__consumerSeed = "ready"; },
          error => { window.__consumerSeed = "error: " + String(error); }); return null;`,
      signal,
    );
    const state = await this.waitForFixture("return window.__consumerSeed", signal);
    if (state !== "ready") throw new Error(String(state));
    this.seeded = true;
  }
  private async beforeHostedNavigation(origin: string, signal: AbortSignal): Promise<void> {
    await checkAssets(origin, this.assets);
    if (this.mode !== "pass") return;
    await super.navigate(`${origin}/current/desktop.html`, signal);
    const actual = await this.waitForFixture("return window.__consumerDesktopResult", signal);
    checkResult(id, actual);
  }
  private async verifyBody(signal: AbortSignal): Promise<void> {
    const value = await this.inspect(
      "return [window.__suiteConfiguration.role, window.__consumerBodyCalls, window.__consumerOpened]",
      signal,
    );
    if (!Array.isArray(value) || value[0] !== "case") return;
    const expectedOpened = this.mode === "wrong-allocation" ? 0 : 2;
    if (value[1] !== 1 || value[2] !== expectedOpened)
      throw new Error(`Wrong invocation/allocation count ${JSON.stringify(value)}`);
    this.bodyVerified = true;
  }
  override async script(source: string, signal: AbortSignal): Promise<unknown> {
    const role = await this.inspect("return window.__suiteConfiguration.role", signal);
    if (role === "case" && this.mode === "late-error" && !this.injected) {
      this.injected = true;
      await this.inspect(
        'window.dispatchEvent(new ErrorEvent("error", { message: "STICKY_LATE_ERROR" })); return new Promise(resolve => setTimeout(resolve, 50));',
        signal,
      );
    }
    if (role === "finish") await this.verifyFinish(signal);
    return this.inspect(source, signal);
  }
  private async verifyFinish(signal: AbortSignal): Promise<void> {
    const value = await this.inspect(
      "return [window.__consumerForeignVerified, window.__consumerBodyCalls, window.__consumerOpened]",
      signal,
    );
    if (JSON.stringify(value) !== "[true,0,0]")
      throw new Error(`Finish violated foreign/list isolation: ${JSON.stringify(value)}`);
    this.verified = true;
  }
  override async stop() {
    let failure: unknown;
    try {
      if (this.seeded)
        await this.inspect(`return (${removeSentinel.toString()})();`, AbortSignal.timeout(2000));
    } catch (error) {
      failure = error;
    }
    const result = await super.stop();
    if (failure) result.session = { status: "unconfirmed", detail: String(failure) };
    return result;
  }
}
async function checkAssets(origin: string, assets: Record<string, Blob | string>): Promise<void> {
  for (const [path, expected] of Object.entries(assets)) {
    if (typeof expected === "string") continue;
    const response = await fetch(origin + path);
    if ((await expected.arrayBuffer()).byteLength === 0)
      throw new Error(`Empty generated asset ${path}`);
    if (
      response.status !== 200 ||
      response.headers.get("Content-Type") !== expected.type ||
      response.headers.get("Cross-Origin-Opener-Policy") !== "same-origin" ||
      response.headers.get("Cross-Origin-Embedder-Policy") !== "require-corp" ||
      response.headers.get("Cache-Control") !== "no-store" ||
      !Buffer.from(await response.arrayBuffer()).equals(Buffer.from(await expected.arrayBuffer()))
    )
      throw new Error(`Asset bytes, MIME or headers lost at ${path}`);
  }
  for (const [path, status] of [
    ["/current/", 404],
    ["/absent", 404],
    ["/favicon.ico", 204],
    ["/report", 405],
    ["/heartbeat", 405],
  ] as const) {
    if ((await fetch(origin + path)).status !== status)
      throw new Error(`Reserved path shadowed: ${path}`);
  }
}
export async function consumerControl(
  engine: "chromium" | "webkit",
  mode: string,
  root: string,
): Promise<void> {
  let driver: ConsumerDriver | undefined,
    produced = 0,
    assets: Record<string, Blob | string> = {};
  const adapter: SuiteAdapter<Request> = {
    suite: "consumer-control",
    inventory: () => [
      {
        id,
        label: "default",
        request: (run) => ({
          databaseName: `consumer-${run}`,
          encoded: '</script><script>throw "unsafe"</script>',
        }),
      },
    ],
    policy: {
      listIds: () => [id],
      requireResult: true,
      allocation: ownedDatabase("consumer"),
      check: checkResult,
    },
    assets: async ({ scratch, signal }: PreparationContext) => {
      produced++;
      signal.throwIfAborted();
      assets = await controlAssets(scratch, mode);
      signal.throwIfAborted();
      return assets;
    },
    page: { path: "/current/", script: "/current/consumer-control-page.js" },
    budgets: () => ({ hello: 8000, heartbeat: 5000, case: 10_000, group: 15_000, run: 40_000 }),
  };
  const result = await runPageSuite(
    adapter,
    (scratch) => {
      driver = new ConsumerDriver(engine, scratch, mode, assets);
      return driver;
    },
    {
      resultPath: join(root, `consumer-${mode}.json`),
      scratchRoot: process.env.STORAGE_SCRATCH_ROOT,
    },
  );
  checkControl(result, mode, produced, driver?.verified === true && driver.bodyVerified);
}
function checkControl(
  result: SuiteResult,
  mode: string,
  produced: number,
  verified: boolean,
): void {
  const expected = ["pass", "slow-seed"].includes(mode)
    ? 0
    : ["late-error", "wrong-allocation"].includes(mode)
      ? 2
      : 1;
  if (
    result.exit !== expected ||
    produced !== 1 ||
    !verified ||
    Object.values(result.cleanup).some(
      (step) => typeof step === "object" && step.status === "unconfirmed",
    )
  )
    throw new Error(`Consumer control ${mode}: ${JSON.stringify(result)}`);
  const actual = result.results[id];
  if (
    !["missing", "oversize", "cleanup-fail", "wrong-allocation"].includes(mode) &&
    !(id in result.results)
  )
    throw new Error("Actual transported result was lost");
  if (mode === "null" && actual !== null)
    throw new Error("Null was not retained as a present wrong result");
  if (
    mode === "partial" &&
    (!actual ||
      typeof actual !== "object" ||
      !("currentTest" in actual) ||
      actual.currentTest !== "worker")
  )
    throw new Error("Partial failure evidence was lost");
  if (result.ledger.length !== (mode === "wrong-allocation" ? 0 : 1))
    throw new Error("Wrong exact-name ledger");
  if (
    mode === "cleanup-fail" &&
    !JSON.stringify(result.outcomes).includes("SETTLED_FINALLY_FAILURE")
  )
    throw new Error("Finally failure lost");
  if (mode === "late-error" && !JSON.stringify(result.failures).includes("STICKY_LATE_ERROR"))
    throw new Error("Late error lost");
}
