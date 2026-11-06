import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { storageTests, opfsStorageTests } from "../storage-browser.js";
import { browserBundle } from "../browser-runner-lifecycle.js";
import { storageWorker, type WorkerRequest } from "./storage-worker.js";
import { Collector, type DocumentState, type Group } from "./collector.js";
import { bounded, type CleanupStep, type Driver, type DriverCleanup } from "./driver.js";
import { exactInventory, record, storageBudgets, type Budgets } from "./protocol.js";
export function storageInventory(): { backend: "indexeddb" | "opfs"; label: string; id: string }[] {
  return storageTests("/fs-worker.js", "/open-fs-worker.js")
    .map<{ backend: "indexeddb" | "opfs"; label: string; id: string }>(({ label }) => ({
      backend: "indexeddb" as const,
      label,
      id: `indexeddb: ${label}`,
    }))
    .concat(
      opfsStorageTests("/fs-worker.js").map(({ label }) => ({
        backend: "opfs" as const,
        label,
        id: `opfs: ${label}`,
      })),
    );
}
export async function storageAssets(): Promise<Record<string, Blob | string>> {
  const root = resolve(import.meta.dir, "..");
  return {
    "/page.js": await browserBundle(join(import.meta.dir, "storage-page.ts")),
    "/tests.js": await browserBundle(join(root, "storage-browser.ts")),
    "/fs-worker.js": await browserBundle(resolve(root, "../browser/fs-worker.ts")),
    "/open-fs-worker.js": await browserBundle(join(root, "storage-open-worker.ts")),
    "/worker.js": `(${storageWorker.toString()})();`,
  };
}
const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cache-Control": "no-store",
};
export function serveCollector(collector: Collector, assets: Record<string, Blob | string>) {
  const configurations = new Map<string, unknown>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(process.env.STORAGE_TEST_PORT ?? 0),
    maxRequestBodySize: 65536,
    async fetch(request) {
      const url = new URL(request.url);
      try {
        if (request.method === "POST") return await acceptPost(collector, request, url.pathname);
        if (url.pathname === "/retire") return retirementCommand(collector, url);
        if (url.pathname === "/")
          return pageResponse(configurations.get(url.searchParams.get("token") ?? ""));
        const asset = assets[url.pathname];
        return new Response(asset ?? "Not found", {
          status: asset === undefined ? 404 : 200,
          headers: { ...headers, "Content-Type": "application/javascript" },
        });
      } catch (error) {
        collector.fail("collector", String(error));
        return Response.json({ error: String(error) }, { status: 409, headers });
      }
    },
  });
  return { server, configurations, origin: `http://127.0.0.1:${server.port}` };
}
async function acceptPost(collector: Collector, request: Request, path: string): Promise<Response> {
  const body: unknown = await bounded(request.json(), 2000, "collector request body");
  if (path === "/report") return Response.json(collector.receive(body), { headers });
  if (path !== "/heartbeat") throw new Error("Unknown collector endpoint");
  collector.heartbeat(body);
  return Response.json(true, { headers });
}
function retirementCommand(collector: Collector, url: URL): Response {
  const state = collector.active;
  if (
    url.searchParams.get("run") !== collector.run ||
    !state?.doc ||
    url.searchParams.get("doc") !== state.doc
  )
    throw new Error("Unbound retirement poll");
  return Response.json(state.retiring, { headers });
}
function pageResponse(configuration: unknown): Response {
  if (!configuration) return new Response("Unknown document token", { status: 404, headers });
  const encoded = JSON.stringify(configuration).replaceAll("<", "\\u003c");
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Storage suite</title><script>window.__storageConfiguration=${encoded}</script><script type="module" src="/page.js"></script>`,
    { headers: { ...headers, "Content-Type": "text/html" } },
  );
}
export type RunOptions = {
  resultPath: string;
  scratchRoot?: string;
  filter?: string;
  signal?: AbortSignal;
  budgets?: Budgets;
  assets?: Record<string, Blob | string>;
};
export type StorageResult = {
  suite: string;
  run: string;
  required: string[];
  selected: string[];
  omitted: string[];
  outcomes: Collector["outcomes"];
  failures: Collector["failures"];
  runComplete: boolean;
  documents: { group: string; doc: string | null; cutoff: number | null }[];
  ledger: Collector["ledger"];
  cleanup: DriverCleanup & { server: CleanupStep; storage: CleanupStep; scratch: CleanupStep };
  exit: number;
};
function absent(): CleanupStep {
  return { status: "not-created", detail: "Not allocated" };
}
export async function runStorage(
  factory: (scratch: string) => Driver,
  options: RunOptions,
): Promise<StorageResult> {
  const inventory = storageInventory(),
    required = inventory.map((item) => item.id);
  const selectedCases = inventory.filter(
    (item) => !options.filter || item.label.includes(options.filter),
  );
  const selected = selectedCases.map((item) => item.id),
    run = crypto.randomUUID();
  exactInventory(
    selected,
    selectedCases.map((item) => item.id),
  );
  const collector = new Collector(run, required, selected);
  const controller = new AbortController();
  const budgets = options.budgets ?? {
    ...storageBudgets,
    run: (selected.length + 2) * 90_000 + 120_000,
  };
  const started = performance.now();
  let scratch = "",
    driver: Driver | undefined,
    fixture: ReturnType<typeof serveCollector> | undefined;
  let storage: CleanupStep = absent(),
    server: CleanupStep = absent(),
    scratchCleanup: CleanupStep = absent();
  let driverCleanup: DriverCleanup = {
    session: absent(),
    launcher: absent(),
    serviceDisposition: "No driver allocated",
  };
  let cleaning: Promise<void> | undefined;
  const interrupted = () => {
    collector.fail("interrupted", "Run interrupted");
    controller.abort("interrupted");
  };
  const stop = (): Promise<void> => (cleaning ??= teardown());
  const teardown = async (): Promise<void> => {
    if (driver) {
      try {
        driverCleanup = await bounded(driver.stop(), 12_000, "driver teardown");
      } catch (error) {
        driverCleanup.session = { status: "unconfirmed", detail: String(error) };
        collector.fail("cleanup", String(error));
      }
    }
    const stopped =
      driverCleanup.session.status !== "unconfirmed" &&
      driverCleanup.launcher.status !== "unconfirmed";
    if (fixture) {
      try {
        await bounded(fixture.server.stop(true), 2000, "collector stop");
        server = {
          status: stopped ? "confirmed" : "unconfirmed",
          detail: stopped
            ? "Stopped after owned consumers"
            : "Stopped at cleanup bound; consumer exit unconfirmed",
        };
      } catch (error) {
        server = { status: "unconfirmed", detail: String(error) };
      }
    }
    if (scratch && stopped) {
      try {
        await bounded(rm(scratch, { recursive: true, force: true }), 2000, "scratch cleanup");
        scratchCleanup = {
          status: "confirmed",
          detail: "Owned scratch removed after consumers stopped",
        };
      } catch (error) {
        scratchCleanup = { status: "unconfirmed", detail: String(error) };
      }
    } else if (scratch)
      scratchCleanup = {
        status: "unconfirmed",
        detail: `Retained ${scratch}, consumers not confirmed stopped`,
      };
  };
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  options.signal?.addEventListener("abort", interrupted, { once: true });
  const watchdog = setInterval(() => {
    if (performance.now() - started < budgets.run) return;
    collector.fail("run-timeout", "Absolute run deadline");
    controller.abort("run-timeout");
  }, 100);
  const signal = controller.signal;
  async function document(group: Group, request: WorkerRequest | null): Promise<void> {
    if (!driver || !fixture || driver.uncertain)
      throw new Error("Driver unavailable or command completion uncertain");
    signal.throwIfAborted();
    const token = crypto.randomUUID(),
      url = `${fixture.origin}/?token=${token}`;
    const state = collector.expect(group, token, url, await driver.handle(signal));
    fixture.configurations.set(token, {
      run,
      token,
      group: group.id,
      request,
      ledger: collector.ledger,
    });
    await bounded(
      driver.navigate(url, AbortSignal.any([signal, AbortSignal.timeout(budgets.hello)])),
      budgets.hello,
      "navigation",
    );
    await awaitState(state, () => state.complete, collector, driver, budgets, started, signal);
    state.retiring = true;
    await awaitState(state, () => state.ready, collector, driver, budgets, started, signal);
    await retireDocument(state, collector, driver, signal);
    fixture.configurations.delete(token);
  }
  try {
    const root =
      options.scratchRoot ??
      process.env.STORAGE_SCRATCH_ROOT ??
      (process.platform === "darwin" ? join(homedir(), "tmp") : "/work/tmp");
    await mkdir(root, { recursive: true });
    scratch = await mkdtemp(join(root, "w-pr-"));
    driver = factory(scratch);
    fixture = serveCollector(collector, options.assets ?? (await storageAssets()));
    await bounded(
      driver.start(AbortSignal.any([signal, AbortSignal.timeout(20_000)])),
      20_000,
      "driver startup",
    );
    if (!selected.length) throw new Error("No selected storage cases");
    await document({ id: "list", role: "list", caseIds: [] }, { kind: "list" });
    for (const item of selectedCases) {
      if (collector.failures.length) throw new Error("Sticky host failure stops case dispatch");
      await document(
        { id: item.id, role: "case", caseIds: [item.id] },
        {
          kind: "run",
          backend: item.backend,
          label: item.label,
          allocationPrefix: `bun-wasm-${item.backend === "indexeddb" ? "storage" : "opfs"}-test-${run}`,
        },
      );
      console.log(`${collector.outcomes[item.id]?.status} ${item.id}`);
    }
    await document({ id: "finish", role: "finish", caseIds: [] }, null);
    storage = {
      status:
        collector.runComplete &&
        !collector.failures.some((item) => item.category === "storage-cleanup")
          ? "confirmed"
          : "unconfirmed",
      detail: "Finish document exact-ledger deletion and final acknowledgement",
    };
  } catch (error) {
    collector.fail(driver?.uncertain ? "driver-lost" : "host", String(error));
    storage = {
      status: collector.ledger.length ? "unconfirmed" : "not-created",
      detail: "Run stopped; exact registered ledger retained in result",
    };
  } finally {
    await stop();
    clearInterval(watchdog);
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    options.signal?.removeEventListener("abort", interrupted);
  }
  const cleanup = { ...driverCleanup, server, storage, scratch: scratchCleanup };
  const unconfirmed = [cleanup.session, cleanup.launcher, server, storage, scratchCleanup].some(
    (step) => step.status === "unconfirmed",
  );
  const complete =
    collector.runComplete &&
    selected.every(
      (id) => collector.outcomes[id]?.status === "pass" && !collector.outcomes[id]?.provisional,
    );
  const exit = collector.failures.length || unconfirmed ? 2 : options.filter ? 4 : complete ? 0 : 1;
  const result: StorageResult = {
    suite: "storage",
    run,
    required,
    selected,
    omitted: required.filter((id) => !selected.includes(id)),
    outcomes: collector.outcomes,
    failures: collector.failures,
    runComplete: collector.runComplete,
    documents: collector.documents.map((state) => ({
      group: state.group.id,
      doc: state.doc,
      cutoff: state.cutoff,
    })),
    ledger: collector.ledger,
    cleanup,
    exit,
  };
  await writeResult(options.resultPath, result);
  return result;
}
async function awaitState(
  state: DocumentState,
  done: () => boolean,
  collector: Collector,
  driver: Driver,
  budgets: Budgets,
  started: number,
  signal: AbortSignal,
): Promise<void> {
  while (!done()) {
    signal.throwIfAborted();
    const overdue = collector.deadline(budgets, started);
    if (overdue) {
      const category = await probeDocument(state, driver, signal);
      collector.fail(
        category === "responsive"
          ? overdue === "case-hang"
            ? "case-hang"
            : "report-lost"
          : category,
        overdue,
        state,
      );
      throw new Error(overdue);
    }
    if (collector.failures.length) throw new Error("Collector has sticky failure");
    await Bun.sleep(25);
  }
}
export async function probeDocument(
  state: DocumentState,
  driver: Driver,
  signal: AbortSignal,
): Promise<string> {
  try {
    if (!(await driver.handles(signal)).includes(state.handle)) return "page-closed";
    if (
      (await driver.handle(signal)) !== state.handle ||
      (await driver.url(signal)) !== state.expectedURL
    )
      return "page-reloaded";
    const value = await driver.script("return window.__pageRunner || null", signal);
    return record(value) && value.doc === state.doc ? "responsive" : "page-reloaded";
  } catch (error) {
    return String(error).includes("script") && String(error).includes("timed out")
      ? "page-unresponsive"
      : "driver-lost";
  }
}
async function retireDocument(
  state: DocumentState,
  collector: Collector,
  driver: Driver,
  signal: AbortSignal,
): Promise<void> {
  const classification = await probeDocument(state, driver, signal);
  if (classification !== "responsive") {
    collector.fail(classification, "Document lost before retirement", state);
    throw new Error(classification);
  }
  const until = performance.now() + 5000;
  while (performance.now() < until) {
    const source = `const r = window.__pageRunner; if (!r || r.doc !== ${JSON.stringify(state.doc)} || r.pending !== 0 || r.failure || r.ackedThrough !== ${state.messages.length - 1}) return null; r.retired = true; return { doc: r.doc, ackedThrough: r.ackedThrough };`;
    const value = await driver.script(source, signal);
    if (record(value) && value.doc === state.doc && typeof value.ackedThrough === "number") {
      collector.retire(state, value.ackedThrough);
      return;
    }
    if (collector.failures.length) throw new Error("Sticky failure before retirement");
    await Bun.sleep(25);
  }
  throw new Error("Retirement barrier missing final report acknowledgement");
}

export async function writeResult(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await Bun.write(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
