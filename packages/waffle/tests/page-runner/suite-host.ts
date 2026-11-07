import { writeResult } from "./result-file.js";
export { writeResult } from "./result-file.js";
import { dispatchReports } from "./collector-fetch.js";
import { HostDrive } from "./host-drive.js";
import { HostConsumers } from "./owned-consumers.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  Collector,
  ObservationClosed,
  ReportRejected,
  type DocumentState,
  type CollectorPolicy,
  type Group,
} from "./collector.js";
import {
  bounded,
  WebDriverError,
  type CleanupStep,
  type Driver,
  type DriverCleanup,
} from "./driver.js";
import { record, type Budgets, type HostCase } from "./protocol.js";
const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cache-Control": "no-store",
};
export type HostedPage = { path: string; script: string };
export type PreparationContext = { scratch: string; signal: AbortSignal };
const defaultPage: HostedPage = { path: "/", script: "/page.js" };
function localPath(path: string): void {
  const url = new URL(path, "http://localhost");
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    url.origin !== "http://localhost" ||
    url.pathname !== path ||
    url.search ||
    url.hash ||
    /[\\\s<>"']/u.test(path)
  )
    throw new Error("Expected a same-origin local page path");
}
function validatePage(page: HostedPage): HostedPage {
  localPath(page.path);
  localPath(page.script);
  if (["/report", "/heartbeat", "/retire", "/favicon.ico"].includes(page.path))
    throw new Error("Hosted page conflicts with a reserved endpoint");
  return page;
}
function validatePort(port: number): number {
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
    throw new Error("Expected a port from 1024 through 65535");
  return port;
}
function probePort(port: number): void {
  const listener = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
  listener.stop(true);
}
export function serveCollector(
  collector: Collector,
  assets: Record<string, Blob | string>,
  page: HostedPage = defaultPage,
  port = Number(process.env.STORAGE_TEST_PORT ?? 0),
) {
  validatePage(page);
  const configurations = new Map<string, unknown>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: 65536,
    async fetch(request) {
      const url = new URL(request.url);
      try {
        const report = await dispatchReports(request, {
          receive: (body) => collector.receive(body),
          heartbeat: (body) => collector.heartbeat(body),
          retirement: (url) => retirementCommand(collector, url),
          fail: (category, detail) => collector.fail(category, detail),
        });
        if (report) return report;
        if (request.method === "POST") throw new Error("Unknown collector endpoint");
        if (url.pathname === "/report" || url.pathname === "/heartbeat")
          return new Response("Method not allowed", { status: 405, headers });
        if (url.pathname === "/favicon.ico") return new Response(null, { status: 204, headers });
        if (url.pathname === page.path)
          return pageResponse(configurations.get(url.searchParams.get("token") ?? ""), page.script);
        const asset = Object.hasOwn(assets, url.pathname) ? assets[url.pathname] : undefined;
        return new Response(asset ?? "Not found", {
          status: asset === undefined ? 404 : 200,
          headers: {
            ...headers,
            "Content-Type":
              typeof asset === "string"
                ? "application/javascript"
                : asset?.type || "application/octet-stream",
          },
        });
      } catch (error) {
        if (error instanceof ObservationClosed)
          return Response.json({ error: error.message }, { status: 410, headers });
        if (!(error instanceof ReportRejected)) collector.fail("collector", String(error));
        return Response.json({ error: String(error) }, { status: 409, headers });
      }
    },
  });
  return { server, configurations, origin: `http://127.0.0.1:${server.port}` };
}
function retirementCommand(collector: Collector, url: URL): boolean {
  const state = collector.documents.find(
    (item) => item.doc !== null && item.doc === url.searchParams.get("doc"),
  );
  if (
    url.searchParams.get("run") !== collector.run ||
    !state?.doc ||
    url.searchParams.get("doc") !== state.doc
  )
    throw new Error("Unbound retirement poll");
  return state.retiring;
}
function pageResponse(configuration: unknown, script: string): Response {
  if (!configuration) return new Response("Unknown document token", { status: 404, headers });
  const encoded = JSON.stringify(configuration).replaceAll("<", "\\u003c");
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Page suite</title><script>window.__suiteConfiguration=${encoded}</script><script type="module" src="${script.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></script>`,
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
  cleanupTimeoutMs?: number;
  startedAt?: number;
  port?: number;
};
export type SuiteResult = {
  suite: string;
  run: string;
  required: string[];
  selected: string[];
  omitted: string[];
  outcomes: Collector["outcomes"];
  results: Collector["results"];
  failures: Collector["failures"];
  runComplete: boolean;
  documents: {
    group: string;
    doc: string | null;
    cutoff: number | null;
    handle: string;
    peer: string | null;
    generation: number | null;
    physical: DocumentState["physical"];
  }[];
  transitions: { id: string; action: string; source: string | null; progress: string }[];
  ledger: Collector["ledger"];
  storageRemaining: Collector["remaining"];
  cleanup: DriverCleanup & { server: CleanupStep; storage: CleanupStep; scratch: CleanupStep };
  exit: number;
};
function absent(): CleanupStep {
  return { status: "not-created", detail: "Not allocated" };
}
async function stopDriver(driver: Driver, ms: number): Promise<DriverCleanup> {
  try {
    return await bounded(driver.stop(), ms, "driver teardown");
  } catch (error) {
    return {
      session: { status: "unconfirmed", detail: String(error) },
      launcher: {
        status: "unconfirmed",
        detail: "Driver teardown did not return a launcher disposition",
      },
      serviceDisposition: "Driver teardown incomplete; no service signals",
    };
  }
}
async function stopCollector(
  server: ReturnType<typeof Bun.serve>,
  stopped: boolean,
): Promise<CleanupStep> {
  try {
    await bounded(server.stop(true), 2000, "collector stop");
    return {
      status: stopped ? "confirmed" : "unconfirmed",
      detail: stopped
        ? "Stopped after owned consumers"
        : "Stopped at cleanup bound; consumer exit unconfirmed",
    };
  } catch (error) {
    return { status: "unconfirmed", detail: String(error) };
  }
}
async function removeScratch(scratch: string, stopped: boolean): Promise<CleanupStep> {
  if (!stopped)
    return {
      status: "unconfirmed",
      detail: `Retained ${scratch}, consumers not confirmed stopped`,
    };
  try {
    await bounded(rm(scratch, { recursive: true, force: true }), 2000, "scratch cleanup");
    return { status: "confirmed", detail: "Owned scratch removed after consumers stopped" };
  } catch (error) {
    return { status: "unconfirmed", detail: String(error) };
  }
}
export type SuiteCase<R> = {
  id: string;
  label: string;
  request: (run: string) => R;
  drive?: (host: HostCase) => Promise<unknown>;
};
export type SuiteAdapter<R> = {
  suite: string;
  inventory(): SuiteCase<R>[];
  policy: CollectorPolicy;
  assets(context: PreparationContext): Promise<Record<string, Blob | string>>;
  page?: HostedPage;
  resultWaitMs?: number;
  budgets(selected: number): Budgets;
};
function selectCases<R>(adapter: SuiteAdapter<R>, options: RunOptions) {
  const inventory = adapter.inventory(),
    required = inventory.map((item) => item.id);
  const selectedCases = inventory.filter(
    (item) => !options.filter || item.label.includes(options.filter),
  );
  const selected = selectedCases.map((item) => item.id),
    run = crypto.randomUUID();
  const collector = new Collector(run, required, selected, adapter.policy);
  const budgets = options.budgets ?? adapter.budgets(selected.length);
  for (const value of Object.values(budgets)) {
    if (!Number.isFinite(value) || value <= 0)
      throw new Error("Budgets must be positive and finite");
  }

  return { required, selectedCases, selected, run, collector, budgets };
}
function runConfiguration<R>(adapter: SuiteAdapter<R>, options: RunOptions) {
  const entered = performance.now();
  const started = options.startedAt ?? entered;
  if (!Number.isFinite(started) || started > entered)
    throw new Error(
      "startedAt must be a finite same-process monotonic timestamp, not in the future",
    );
  const port = options.port === undefined ? undefined : validatePort(options.port);
  const page = validatePage(adapter.page ?? defaultPage);
  if (
    adapter.resultWaitMs !== undefined &&
    (!Number.isFinite(adapter.resultWaitMs) || adapter.resultWaitMs <= 0)
  )
    throw new Error("resultWaitMs must be positive and finite");
  return { started, port, page };
}
export async function runPageSuite<R>(
  adapter: SuiteAdapter<R>,
  factory: (scratch: string) => Driver,
  options: RunOptions,
): Promise<SuiteResult> {
  const { started, port, page } = runConfiguration(adapter, options);
  const controller = new AbortController();
  let expire = () => {};
  const watchdog = setInterval(() => expire(), 25);
  let selection: ReturnType<typeof selectCases<R>>;
  try {
    selection = selectCases(adapter, options);
  } catch (error) {
    clearInterval(watchdog);
    throw error;
  }
  const { required, selectedCases, selected, run, collector, budgets } = selection;
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
  const consumers = new HostConsumers();
  const hostCases: HostDrive[] = [];
  let preparation: Promise<void> | undefined;
  let cleaning: Promise<void> | undefined;
  const interrupted = () => {
    if (cleaning) return;
    collector.fail("interrupted", "Run interrupted");
    controller.abort("interrupted");
  };
  const stop = (): Promise<void> => (cleaning ??= Promise.resolve().then(teardown));
  const teardown = async (): Promise<void> => {
    consumers.revoke();
    controller.abort("execution stopped");
    const cleanupMs = options.cleanupTimeoutMs ?? 12_000;
    const [producerStopped, hostStopped] = await Promise.all([
      joinPreparation(preparation, cleanupMs),
      consumers.join(cleanupMs),
      driver
        ? stopDriver(driver, cleanupMs).then((result) => {
            driverCleanup = result;
          })
        : undefined,
    ]);
    const stopped =
      producerStopped &&
      hostStopped &&
      driverCleanup.session.status !== "unconfirmed" &&
      driverCleanup.launcher.status !== "unconfirmed";
    if (!stopped)
      collector.fail(
        "cleanup",
        !hostStopped
          ? "Host callback or command settlement unconfirmed"
          : producerStopped
            ? driverCleanup.session.detail
            : "Asset producer settlement unconfirmed",
      );
    if (fixture) server = await stopCollector(fixture.server, stopped);
    let diagnosticsSaved = true;
    if (
      hostCases.length &&
      (collector.failures.length ||
        Object.values(collector.outcomes).some((outcome) => outcome.status === "fail"))
    ) {
      try {
        await writeResult(`${options.resultPath}.diagnostics.json`, {
          host: hostCases.map((host) => host.failureEvidence()),
          outcomes: collector.outcomes,
          results: collector.results,
          failures: collector.failures,
        });
      } catch (error) {
        diagnosticsSaved = false;
        collector.fail("diagnostics-write", String(error));
      }
    }
    if (scratch) scratchCleanup = await removeScratch(scratch, stopped && diagnosticsSaved);
  };
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  options.signal?.addEventListener("abort", interrupted, { once: true });
  if (options.signal?.aborted) interrupted();
  const checkDeadline = () => {
    if (signal.aborted || performance.now() - started < budgets.run) return;
    collector.fail("run-timeout", "Absolute run deadline");
    controller.abort("run-timeout");
  };
  const signal = controller.signal;
  const checkExecution = () => {
    checkDeadline();
    signal.throwIfAborted();
  };
  expire = checkDeadline;
  checkDeadline();
  async function document(
    group: Group,
    item: SuiteCase<R> | null,
    cleanupOnly = false,
  ): Promise<void> {
    const operationSignal = cleanupOnly ? AbortSignal.timeout(15_000) : signal;
    let priorFailures = cleanupOnly ? collector.failures.length : 0;
    if (!driver || !fixture || driver.uncertain)
      throw new Error("Driver unavailable or command completion uncertain");
    if (!cleanupOnly) checkExecution();
    operationSignal.throwIfAborted();
    const token = crypto.randomUUID(),
      url = `${fixture.origin}${page.path}?token=${token}`,
      handle = await driver.handle(operationSignal);
    if (!cleanupOnly) checkExecution();
    operationSignal.throwIfAborted();
    const state = collector.expect(group, token, url, handle);
    const configuration = pageConfiguration(group, item, run);
    fixture.configurations.set(token, {
      run,
      token,
      group: group.id,
      ...configuration,
      teardownMs: budgets.teardown ?? budgets.case,
      ledger: collector.ledger,
    });
    await bounded(
      driver.navigate(url, AbortSignal.any([operationSignal, AbortSignal.timeout(budgets.hello)])),
      budgets.hello,
      "navigation",
    );
    const resultDeadline =
      group.role === "case" && adapter.resultWaitMs !== undefined
        ? performance.now() + adapter.resultWaitMs
        : undefined;
    const host = item?.drive
      ? new HostDrive(
          driver,
          collector,
          state,
          consumers,
          budgets,
          started,
          operationSignal,
          (peer, lookup) => {
            if (!fixture || peer.owner.kind !== "peer" || !("request" in configuration))
              throw new Error("Missing peer configuration owner");
            fixture.configurations.set(lookup, {
              run,
              token: peer.token,
              group: group.id,
              role: "peer",
              caseId: item.id,
              request: configuration.request,
              peer: peer.owner.peer,
              generation: peer.owner.generation,
              execution: "host",
              ledger: collector.ledger,
            });
          },
        )
      : undefined;
    if (host) hostCases.push(host);
    const documentDriver = host?.transport ?? driver;
    if (host && item?.drive) {
      await awaitState(
        state,
        () => state.host?.kind === "ready",
        collector,
        documentDriver,
        budgets,
        started,
        operationSignal,
      );
      await host.admit();
      await host.drive(item.drive);
      priorFailures = collector.failures.length;
    }
    await awaitState(
      state,
      () => state.complete,
      collector,
      documentDriver,
      budgets,
      cleanupOnly ? performance.now() : started,
      operationSignal,
      priorFailures,
      resultDeadline,
    );
    if (host?.uncontainedPageWork()) throw new Error("Uncontained page task or teardown");
    state.retiring = true;
    await awaitState(
      state,
      () => state.ready,
      collector,
      documentDriver,
      budgets,
      cleanupOnly ? performance.now() : started,
      operationSignal,
      priorFailures,
    );
    await retireDocument(state, collector, documentDriver, operationSignal, priorFailures);
    operationSignal.throwIfAborted();
    if (!cleanupOnly) checkDeadline();
    operationSignal.throwIfAborted();
    fixture.configurations.delete(token);
  }
  async function interruptedFinish(error: unknown): Promise<void> {
    if (
      !driver ||
      !fixture ||
      driver.uncertain ||
      collector.runComplete ||
      hostCases.some(
        (host) =>
          host.transport.uncertain ||
          host.uncontainedPageWork() ||
          (host.state.cutoff === null && host.state.host?.kind !== "terminal"),
      )
    )
      return;
    collector.abandon(String(error));
    try {
      await document({ id: "cleanup-finish", role: "finish", caseIds: [] }, null, true);
    } catch (cleanupError) {
      collector.fail("storage-cleanup", String(cleanupError));
    }
  }
  try {
    checkExecution();
    const root =
      options.scratchRoot ??
      process.env.STORAGE_SCRATCH_ROOT ??
      (process.platform === "darwin" ? join(homedir(), "tmp") : "/work/tmp");
    if (port !== undefined) probePort(port);
    checkExecution();
    await mkdir(root, { recursive: true });
    checkExecution();
    scratch = await mkdtemp(join(root, "w-pr-"));
    checkExecution();
    const producing = Promise.resolve().then(() => {
      checkExecution();
      return options.assets ?? adapter.assets({ scratch, signal });
    });
    preparation = producing.then(
      () => {},
      () => {},
    );
    const assets = await untilAborted(producing, signal);
    checkExecution();
    fixture = serveCollector(collector, assets, page, port);
    checkExecution();
    driver = factory(scratch);
    checkExecution();
    await bounded(
      driver.start(AbortSignal.any([signal, AbortSignal.timeout(20_000)])),
      20_000,
      "driver startup",
    );
    if (!selected.length) throw new Error("No selected suite cases");
    await document({ id: "list", role: "list", caseIds: [] }, null);
    for (const item of selectedCases) {
      if (collector.failures.length) throw new Error("Sticky host failure stops case dispatch");
      await document(
        {
          id: item.id,
          role: "case",
          caseIds: [item.id],
          execution: item.drive ? "host" : undefined,
        },
        item,
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
    await interruptedFinish(error);
    storage = {
      status:
        collector.runComplete && collector.remaining?.length === 0
          ? "confirmed"
          : collector.ledger.length
            ? "unconfirmed"
            : "not-created",
      detail: "Run stopped; exact registered ledger retained in result",
    };
  } finally {
    checkDeadline();
    clearInterval(watchdog);
    await stop();
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    options.signal?.removeEventListener("abort", interrupted);
  }
  if (!adapter.policy.allocation)
    storage = { status: "not-created", detail: "suite declares no durable allocations" };
  const cleanup = { ...driverCleanup, server, storage, scratch: scratchCleanup };
  const exit = resultExit(collector, cleanup, options.filter);
  const result: SuiteResult = {
    suite: adapter.suite,
    run,
    required,
    selected,
    omitted: required.filter((id) => !selected.includes(id)),
    outcomes: collector.outcomes,
    results: collector.results,
    failures: collector.failures,
    runComplete: collector.runComplete,
    documents: collector.documents.map((state) => ({
      group: state.group.id,
      doc: state.doc,
      cutoff: state.cutoff,
      handle: state.handle,
      peer: state.owner.kind === "peer" ? state.owner.peer : null,
      generation: state.owner.kind === "peer" ? state.owner.generation : null,
      physical: state.physical,
    })),
    transitions: collector.transitions.map((transition) => ({
      id: transition.id,
      action: transition.action,
      source: transition.source.doc,
      progress: transition.progress.kind,
    })),
    ledger: collector.ledger,
    storageRemaining: collector.remaining,
    cleanup,
    exit,
  };
  await writeResult(options.resultPath, result);
  return result;
}
function pageConfiguration<R>(group: Group, item: SuiteCase<R> | null, run: string) {
  if (group.role !== "case") return { role: group.role };
  if (!item) throw new Error("Missing host case descriptor");
  return {
    role: "case",
    caseId: item.id,
    request: item.request(run),
    execution: item.drive ? "host" : undefined,
  };
}
function resultExit(
  collector: Collector,
  cleanup: SuiteResult["cleanup"],
  filtered: string | undefined,
): number {
  const selected = collector.selected;
  const { server, storage, scratch: scratchCleanup } = cleanup;
  const unconfirmed = [cleanup.session, cleanup.launcher, server, storage, scratchCleanup].some(
    (step) => step.status === "unconfirmed",
  );
  const complete =
    collector.runComplete &&
    selected.every(
      (id) => collector.outcomes[id]?.status === "pass" && !collector.outcomes[id]?.provisional,
    );
  return collector.failures.length || unconfirmed ? 2 : filtered ? 4 : complete ? 0 : 1;
}
async function awaitState(
  state: DocumentState,
  done: () => boolean,
  collector: Collector,
  driver: Driver,
  budgets: Budgets,
  started: number,
  signal: AbortSignal,
  priorFailures = 0,
  resultDeadline?: number,
): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    const resultOverdue =
      resultDeadline !== undefined && (state.terminalAt ?? performance.now()) >= resultDeadline;
    if (!resultOverdue && done()) return;
    const overdue = resultOverdue ? "result-timeout" : collector.deadline(budgets, started);
    if (overdue) {
      const category = await probeDocument(state, driver, signal);
      collector.fail(
        category === "responsive"
          ? overdue === "case-hang" || overdue === "result-timeout"
            ? overdue
            : "report-lost"
          : category,
        overdue,
        state,
      );
      throw new Error(overdue);
    }
    if (collector.failures.length > priorFailures) throw new Error("Collector has sticky failure");
    await Bun.sleep(25);
  }
}
export async function probeDocument(
  state: DocumentState,
  driver: Driver,
  signal: AbortSignal,
): Promise<string> {
  const probeSignal = AbortSignal.any([signal, AbortSignal.timeout(4000)]);
  try {
    return await bounded(inspectDocument(state, driver, probeSignal), 4000, "document probe");
  } catch {
    return "driver-lost";
  }
}
async function inspectDocument(
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
    return error instanceof WebDriverError && error.code === "script timeout"
      ? "page-unresponsive"
      : "driver-lost";
  }
}
export async function retireDocument(
  state: DocumentState,
  collector: Collector,
  driver: Driver,
  signal: AbortSignal,
  priorFailures = 0,
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
    if (collector.failures.length > priorFailures)
      throw new Error("Sticky failure before retirement");
    await Bun.sleep(25);
  }
  throw new Error("Retirement barrier missing final report acknowledgement");
}

async function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
async function joinPreparation(
  preparation: Promise<void> | undefined,
  ms: number,
): Promise<boolean> {
  if (!preparation) return true;
  try {
    await bounded(preparation, ms, "asset producer join");
    return true;
  } catch {
    return false;
  }
}
