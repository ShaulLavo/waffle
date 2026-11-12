import {
  FixtureOwner,
  localPath,
  reservedPath,
  type FixtureDeclaration,
  type FixtureRoute,
} from "./fixture-owner.js";
import type { NativeCommandFailure } from "./safari-driver.js";
import type { WorkerDeclaration } from "./service-worker-page.js";
import type { ServiceWorkerEntry } from "../storage-allocation.js";
import { writeResult } from "./result-file.js";
export { writeResult } from "./result-file.js";
import { readReportBody, dispatchReports } from "./collector-fetch.js";
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
  type FixtureLimits,
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
import { AssetOwner, assetHeaders as headers } from "./asset-owner.js";
export type HostedPage = { path: string; script: string };
export type PreparationContext = { scratch: string; signal: AbortSignal };
const defaultPage: HostedPage = { path: "/", script: "/page.js" };
function validatePage(page: HostedPage): HostedPage {
  localPath(page.path);
  localPath(page.script);
  if (reservedPath(page.path) || reservedPath(page.script) || page.path === page.script)
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
function selectedFixture(
  declaration: FixtureDeclaration | undefined,
  selected: readonly string[],
  fail: (detail: string) => void,
): FixtureOwner | undefined {
  if (!declaration || !selected.includes(declaration.caseId)) return;
  return new FixtureOwner(declaration, fail);
}
export function serveCollector(
  collector: Collector,
  assets: Record<string, Blob | string>,
  page: HostedPage = defaultPage,
  port = Number(process.env.STORAGE_TEST_PORT ?? 0),
  fixtures?: { owner: FixtureOwner; limits: FixtureLimits },
  consumers = new HostConsumers(),
) {
  validatePage(page);
  const configurations = new Map<string, unknown>();
  const assetOwner = new AssetOwner(collector, assets, page, consumers);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: 65536,
    async fetch(request, server) {
      const url = new URL(request.url);
      try {
        if (url.pathname === "/_waffle_worker_close") {
          if (request.method !== "POST")
            return new Response("Method not allowed", { status: 405, headers });
          server.timeout(request, 0);
          return workerCloseResponse(request, collector);
        }
        const report = await dispatchReports(request, {
          receive: (body) => collector.receive(body),
          heartbeat: (body) => collector.heartbeat(body),
          retirement: (url) => retirementCommand(collector, url),
          fail: (category, detail) => collector.fail(category, detail),
        });
        if (report) return report;
        if (fixtures?.owner.has(url.pathname))
          return await fixtureResponse(request, server, collector, fixtures);
        if (request.method !== "GET" && request.method !== "HEAD")
          return new Response("Method not allowed", { status: 405, headers });
        if (url.pathname === "/report" || url.pathname === "/heartbeat")
          return new Response("Method not allowed", { status: 405, headers });
        if (url.pathname === "/_waffle_observation_arrival") {
          if (request.method !== "GET")
            return new Response("Method not allowed", { status: 405, headers });
          const token = url.searchParams.get("token");
          if (!token || !configurations.has(token))
            throw new ObservationClosed("Unbound bootstrap arrival");
          collector.bootstrapArrived(token);
          return new Response(null, { status: 204, headers });
        }
        if (url.pathname === "/_waffle_observation_bootstrap") {
          const token = url.searchParams.get("token");
          if (!token || !configurations.has(token))
            return new Response("Unbound bootstrap", { status: 404, headers });
          return new Response(
            `<!doctype html><html data-waffle-observation="${token}"><meta charset="utf-8"><title>Observation bootstrap</title><script>fetch(${JSON.stringify(`/_waffle_observation_arrival?token=${encodeURIComponent(token)}`)})</script></html>`,
            { headers: { ...headers, "Content-Type": "text/html" } },
          );
        }
        if (url.pathname === "/favicon.ico") return new Response(null, { status: 204, headers });
        const token = url.searchParams.get("token") ?? "";
        const expected = collector.documents.find((item) => item.token === token);
        if (
          expected &&
          new URL(expected.expectedURL).pathname === url.pathname &&
          expected.expectedURL === url.href
        )
          return assetOwner.pageResponse(expected, configurations.get(token), request.method);
        if (url.pathname === page.path || url.pathname.startsWith("/_waffle_owned/"))
          return new Response("Unknown document binding", { status: 404, headers });
        return await assetOwner.response(request, server);
      } catch (error) {
        if (error instanceof ObservationClosed)
          return Response.json({ error: error.message }, { status: 410, headers });
        if (!(error instanceof ReportRejected)) collector.fail("collector", String(error));
        return Response.json({ error: String(error) }, { status: 409, headers });
      }
    },
  });
  return { server, configurations, assetOwner, origin: `http://127.0.0.1:${server.port}` };
}
async function workerCloseResponse(request: Request, collector: Collector): Promise<Response> {
  try {
    await collector.workerCloseQuery(await readReportBody(request));
    return Response.json({ closed: true }, { headers });
  } catch (error) {
    return Response.json(
      { error: String(error) },
      { status: error instanceof ObservationClosed ? 410 : 409, headers },
    );
  }
}

async function observeDocument(
  driver: Driver,
  item: SuiteCase<unknown> | null,
  binding: import("./driver.js").DriverObservationBinding,
  collector: Collector,
  state: DocumentState,
  hello: number,
) {
  if (!item?.observation && !item?.console) return;
  const observe = driver.observe?.bind(driver);
  if (!observe || (item.observation && !item.drive))
    throw new Error("Declared browser observation is unavailable on this driver");
  await driver.navigate(binding.bootstrapURL, binding.signal);
  const remaining = state.startedAt + hello - performance.now();
  if (remaining <= 0) throw new Error("no-hello");
  await collector.waitForBootstrap(
    state,
    AbortSignal.any([binding.signal, AbortSignal.timeout(Math.ceil(remaining))]),
  );
  return binding.consumers.invoke(() => observe(binding));
}
async function navigateDocument(options: {
  driver: Driver;
  url: string;
  signal: AbortSignal;
  hello: number;
  observation: import("./driver.js").DriverObservation | undefined;
}): Promise<void> {
  await bounded(
    options.driver.navigate(
      options.url,
      AbortSignal.any([options.signal, AbortSignal.timeout(options.hello)]),
    ),
    options.hello,
    "navigation",
  );
  options.observation?.navigationComplete();
}
function bindConsoleFailure(
  declared: boolean,
  observation: import("./driver.js").DriverObservation | undefined,
  collector: Collector,
  state: DocumentState,
): void {
  if (!declared) return;
  if (!observation) throw new Error("Console observation unavailable");
  void observation.failure.then((error) =>
    collector.fail("browser-observation", error.message, state),
  );
  if (!observation.console || !observation.settleConsole)
    throw new Error("Console observation unavailable");
}
async function stopConsoleObservation(
  declared: boolean,
  observation: import("./driver.js").DriverObservation | undefined,
  collector: Collector,
  state: DocumentState,
): Promise<void> {
  if (!declared || !observation) return;
  try {
    await observation.stop();
  } catch (error) {
    collector.fail("browser-observation-cleanup", String(error), state);
  }
}
function resultDeadline(group: Group, wait: number | undefined): number | undefined {
  return group.role === "case" && wait !== undefined ? performance.now() + wait : undefined;
}
function sealAssets(fixture: ReturnType<typeof serveCollector> | undefined): void {
  fixture?.assetOwner.seal();
}
function documentTeardown(
  host: HostDrive | undefined,
  deadline: number | undefined,
  signal: AbortSignal,
) {
  if (!host) return { deadline, signal };
  return {
    deadline: Math.min(deadline ?? Infinity, host.teardownDeadline()),
    signal: AbortSignal.any([signal, host.teardownSignal()]),
  };
}
async function fixtureResponse(
  request: Request,
  transport: { timeout(request: Request, seconds: number): void },
  collector: Collector,
  fixtures: { owner: FixtureOwner; limits: FixtureLimits },
): Promise<Response> {
  if (request.method !== "GET")
    return new Response("Method not allowed", {
      status: 405,
      headers: { ...headers, Allow: "GET" },
    });
  if (new URL(request.url).search) throw new Error("Fixture query is not declared");
  const token = request.headers.get("X-Waffle-Fixture"),
    doc = request.headers.get("X-Waffle-Document");
  if (!token || !doc) throw new ObservationClosed("Missing fixture capability");
  const admission = collector.admitFixture(
    token,
    doc,
    fixtures.owner.declaration.caseId,
    fixtures.limits,
  );
  // Only admitted requests disable the idle timeout. Final server.stop(true) owns transport teardown.
  transport.timeout(request, 0);
  const encoded = await fixtures.owner.get(new URL(request.url).pathname, {
    signal: request.signal,
    deadline: admission.deadline,
  });
  collector.completeFixture(admission);
  return new Response(encoded, { headers: { ...headers, "Content-Type": "application/json" } });
}
function retirementCommand(collector: Collector, url: URL): ReturnType<Collector["reply"]> {
  const state = collector.documents.find(
    (item) => item.doc !== null && item.doc === url.searchParams.get("doc"),
  );
  if (
    url.searchParams.get("run") !== collector.run ||
    !state?.doc ||
    url.searchParams.get("doc") !== state.doc
  )
    throw new Error("Unbound retirement poll");
  return collector.reply(state.retiring, state);
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
  port?: number | "ephemeral";
};
type FirstCommandFailure = NativeCommandFailure & {
  readonly hostNow: number;
  readonly lastHeartbeatAgeMs: number | null;
};
export type SuiteResult = {
  firstCommandFailure: FirstCommandFailure | null;
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
    console: import("./console-observation.js").ConsoleSummary | null;
  }[];
  transitions: {
    id: string;
    action: string;
    source: string | null;
    sourceHandle: string;
    deadline: number;
    progress: string;
    detail: string | null;
    target: { peer: string; generation: number; url: string } | null;
    successor: string | null;
    remainingHandles: readonly string[] | null;
  }[];
  ledger: Collector["ledger"];
  storageRemaining: Collector["remaining"];
  registrationAttempts: Collector["registrationAttempts"];
  cleanup: DriverCleanup & {
    server: CleanupStep;
    storage: CleanupStep;
    scratch: CleanupStep;
    fixture: CleanupStep;
    callbacks: CleanupStep;
  };
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
  query?: (run: string) => Readonly<Record<string, string>>;
} & (
  | { drive?: never; observation?: never; console?: "fail-on-error" }
  | {
      drive?: (host: HostCase) => Promise<unknown>;
      observation?: "workers-and-requests";
      console?: never;
    }
);
export type SuiteAdapter<R> = {
  suite: string;
  inventory(): SuiteCase<R>[];
  policy: CollectorPolicy;
  assets(context: PreparationContext): Promise<Record<string, Blob | string>>;
  page?: HostedPage;
  serviceWorker?: WorkerDeclaration;
  fixture?: FixtureDeclaration;
  resultWaitMs?: number;
  budgets(selected: number): Budgets;
};
function selectCases<R>(adapter: SuiteAdapter<R>, options: RunOptions) {
  const inventory = adapter.inventory();
  for (const item of inventory) {
    if (
      item.console !== undefined &&
      (item.console !== "fail-on-error" || item.drive || item.observation)
    )
      throw new Error("Console policy requires an ordinary page case and fail-on-error");
  }
  const required = inventory.map((item) => item.id);
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
  const port =
    options.port === "ephemeral"
      ? 0
      : options.port === undefined
        ? undefined
        : validatePort(options.port);
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
  factory: (scratch: string, observeFailure: (facts: NativeCommandFailure) => void) => Driver,
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
  let firstCommandFailure: FirstCommandFailure | null = null;
  let failureObserved = false;
  const observeFailure = (facts: NativeCommandFailure): void => {
    if (failureObserved) return;
    failureObserved = true;
    const hostNow = performance.now();
    const state = collector.active;
    const lastHeartbeatAgeMs = state?.doc ? hostNow - state.heartbeatAt : null;
    firstCommandFailure = Object.freeze({
      client: facts.client,
      operation: null,
      phase: null,
      method: facts.method,
      path: facts.path,
      dispatchedAt: facts.dispatchedAt,
      settledAt: facts.settledAt,
      stage: facts.stage,
      status: facts.status,
      abort: facts.abort,
      errorName: facts.errorName,
      errorCode: facts.errorCode,
      hostNow,
      lastHeartbeatAgeMs,
    });
  };
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
  let application: FixtureOwner | undefined;
  let applicationCleanup = { fixture: absent(), callbacks: absent() };
  let workerEntry: Omit<ServiceWorkerEntry, "clientURL"> | undefined;
  let sealed = false;
  let preparation: Promise<void> | undefined;
  let cleaning: Promise<void> | undefined;
  const interrupted = () => {
    if (cleaning) return;
    collector.fail("interrupted", "Run interrupted");
    application?.revoke("interrupted");
    controller.abort("interrupted");
  };
  const stop = (): Promise<void> => (cleaning ??= Promise.resolve().then(teardown));
  const teardown = async (): Promise<void> => {
    collector.cancel();
    application?.revoke("execution stopped");
    consumers.revoke();
    collector.abandon("execution stopped");
    controller.abort("execution stopped");
    const cleanupMs = options.cleanupTimeoutMs ?? 12_000;
    const cleanupDeadline = performance.now() + cleanupMs;
    const [producerStopped, hostStopped] = await Promise.all([
      joinPreparation(preparation, cleanupMs),
      consumers.join(cleanupMs),
      driver
        ? stopDriver(driver, cleanupMs).then((result) => {
            driverCleanup = result;
          })
        : undefined,
      application
        ? application.finish(cleanupDeadline).then((result) => {
            applicationCleanup = result;
          })
        : undefined,
    ]);
    const stopped =
      producerStopped &&
      hostStopped &&
      applicationCleanup.fixture.status !== "unconfirmed" &&
      applicationCleanup.callbacks.status !== "unconfirmed" &&
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
    const token = crypto.randomUUID();
    const capabilities = documentCapabilities({
      adapter,
      item,
      worker: workerEntry,
      application,
      origin: fixture.origin,
      page: page.path,
      token,
      run,
      collector,
    });
    const { url } = capabilities;
    const handle = await driver.handle(operationSignal);
    if (!cleanupOnly) checkExecution();
    operationSignal.throwIfAborted();
    const state = collector.expect(group, token, url, handle, cleanupOnly);
    const configuration = pageConfiguration(group, item, run);
    fixture.configurations.set(token, {
      run,
      token,
      group: group.id,
      ...configuration,
      teardownMs: budgets.teardown ?? budgets.case,
      ledger: collector.ledger,
      ...capabilities,
      registrationAttempts: collector.registrationAttempts,
    });
    const consoleDeclared = item?.console === "fail-on-error";
    const observation = await observeDocument(
      driver,
      item,
      {
        window: handle,
        bootstrapURL: `${fixture.origin}/_waffle_observation_bootstrap?token=${token}`,
        expectedURL: url,
        signal: operationSignal,
        consumers,
        console: consoleDeclared,
      },
      collector,
      state,
      budgets.hello,
    );
    try {
      bindConsoleFailure(consoleDeclared, observation, collector, state);
      collector.bindObservation(
        state,
        observation,
        consumers,
        () => started + budgets.run,
        consoleDeclared,
      );
      await navigateDocument({
        driver,
        url,
        signal: operationSignal,
        hello: budgets.hello,
        observation,
      });
      const resultUntil = resultDeadline(group, adapter.resultWaitMs);
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
              const peerConfiguration = {
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
              };
              fixture.configurations.set(lookup, peerConfiguration);
              fixture.configurations.set(peer.token, peerConfiguration);
            },
            fixture.assetOwner,
            observation,
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
      const teardown = documentTeardown(host, resultUntil, operationSignal);
      await awaitState(
        state,
        () => state.complete,
        collector,
        documentDriver,
        budgets,
        cleanupOnly ? performance.now() : started,
        teardown.signal,
        priorFailures,
        teardown.deadline,
      );
      if (host?.uncontainedPageWork()) throw new Error("Uncontained page task or teardown");
      if (collector.reply(false, state).kind === "cancelled")
        throw new Error("Reporting cancelled before retirement");
      state.retiring = true;
      await awaitState(
        state,
        () => state.ready,
        collector,
        documentDriver,
        budgets,
        cleanupOnly ? performance.now() : started,
        teardown.signal,
        priorFailures,
        teardown.deadline,
      );
      await retireDocument(state, collector, documentDriver, teardown.signal, priorFailures);
      operationSignal.throwIfAborted();
      if (!cleanupOnly) checkDeadline();
      operationSignal.throwIfAborted();
      fixture.configurations.delete(token);
      if (item?.id === adapter.fixture?.caseId) application?.revoke("case document retired");
    } finally {
      await stopConsoleObservation(consoleDeclared, observation, collector, state);
    }
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
    application?.revoke("interrupted finish");
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
    validateDeclarations(adapter, required, page);
    application = selectedFixture(adapter.fixture, selected, (detail) => {
      if (!sealed) collector.fail("fixture", detail);
    });
    controller.signal.addEventListener("abort", () => application?.revoke("run cancelled"), {
      once: true,
    });
    if (port !== undefined && port !== 0) probePort(port);
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
    validateAssets(assets, page);
    fixture = serveCollector(
      collector,
      assets,
      page,
      port,
      application && { owner: application, limits: { budgets, runStartedAt: started } },
      consumers,
    );
    workerEntry = workerLocation(adapter.serviceWorker, fixture.origin, run, assets);
    if (application) {
      const startup = application.start(
        { origin: fixture.origin, run, scratch, signal },
        (routes) => validateRoutes(routes, assets, page),
      );
      await untilAborted(startup, signal);
    }
    checkExecution();
    driver = factory(scratch, observeFailure);
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
  sealed = true;
  sealAssets(fixture);
  if (!adapter.policy.allocation && !adapter.serviceWorker)
    storage = { status: "not-created", detail: "suite declares no durable allocations" };
  const cleanup = {
    ...driverCleanup,
    server,
    storage,
    scratch: scratchCleanup,
    ...applicationCleanup,
  };
  const exit = resultExit(collector, cleanup, options.filter);
  const result: SuiteResult = {
    firstCommandFailure,
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
      console: collector.consoleObservation(state)?.console?.() ?? null,
    })),
    transitions: collector.transitions.map((transition) => ({
      id: transition.id,
      action: transition.action,
      source: transition.source.doc,
      sourceHandle: transition.source.handle,
      deadline: transition.deadline,
      progress: transition.progress.kind,
      detail: transition.progress.kind === "failed" ? transition.progress.detail : null,
      target: transition.target
        ? {
            peer: transition.target.peer,
            generation: transition.target.generation,
            url: transition.target.url,
          }
        : null,
      successor:
        transition.progress.kind === "completed"
          ? (transition.progress.successor?.doc ?? null)
          : null,
      remainingHandles:
        transition.progress.kind === "completed" ? transition.progress.remainingHandles : null,
    })),
    ledger: collector.ledger,
    registrationAttempts: collector.registrationAttempts,
    storageRemaining: collector.remaining,
    cleanup,
    exit,
  };
  const snapshot = structuredClone(result);
  Object.freeze(snapshot.firstCommandFailure);
  await writeResult(options.resultPath, snapshot);
  return snapshot;
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
  const unconfirmed = [
    cleanup.session,
    cleanup.launcher,
    server,
    storage,
    scratchCleanup,
    cleanup.fixture,
    cleanup.callbacks,
  ].some((step) => step.status === "unconfirmed");
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
  driver: Omit<Driver, "press">,
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
  driver: Omit<Driver, "press">,
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
  driver: Omit<Driver, "press">,
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
  driver: Omit<Driver, "press">,
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
      await collector.consoleObservation(state)?.settleConsole?.();
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

function validateDeclarations<R>(
  adapter: SuiteAdapter<R>,
  required: readonly string[],
  page: HostedPage,
): void {
  for (const declaration of [adapter.serviceWorker, adapter.fixture]) {
    if (declaration && !required.includes(declaration.caseId))
      throw new Error("Declaration case is not in inventory");
  }
  if (!adapter.serviceWorker) return;
  localPath(adapter.serviceWorker.script);
  if (
    reservedPath(adapter.serviceWorker.script) ||
    [page.path, page.script].includes(adapter.serviceWorker.script)
  )
    throw new Error("Worker script conflicts with host routes");
}
function validateAssets(assets: Record<string, Blob | string>, page: HostedPage): void {
  for (const path of Object.keys(assets)) {
    localPath(path);
    if (reservedPath(path) || path === page.path)
      throw new Error(`Asset conflicts with host route: ${path}`);
  }
}
function validateRoutes(
  routes: readonly FixtureRoute[],
  assets: Record<string, Blob | string>,
  page: HostedPage,
): void {
  const paths = new Set<string>();
  for (const route of routes) {
    localPath(route.path);
    if (
      reservedPath(route.path) ||
      [page.path, page.script].includes(route.path) ||
      Object.hasOwn(assets, route.path) ||
      paths.has(route.path) ||
      typeof route.get !== "function"
    )
      throw new Error("Fixture route conflicts with host route or asset");
    paths.add(route.path);
  }
}

function workerLocation(
  declaration: WorkerDeclaration | undefined,
  origin: string,
  run: string,
  assets: Record<string, Blob | string>,
): Omit<ServiceWorkerEntry, "clientURL"> | undefined {
  if (!declaration) return;
  if (!Object.hasOwn(assets, declaration.script)) throw new Error("Missing declared worker asset");
  return {
    kind: "service-worker",
    name: `${origin}/_waffle_owned/${run}/`,
    scriptURL: `${origin}${declaration.script}?waffle-run=${run}`,
  };
}
function documentCapabilities<R>({
  adapter,
  item,
  worker,
  application,
  origin,
  page,
  token,
  run,
  collector,
}: {
  adapter: SuiteAdapter<R>;
  item: SuiteCase<R> | null;
  worker: Omit<ServiceWorkerEntry, "clientURL"> | undefined;
  application: FixtureOwner | undefined;
  origin: string;
  page: string;
  token: string;
  run: string;
  collector: Collector;
}) {
  const owned = item && adapter.serviceWorker && item.id === adapter.serviceWorker.caseId && worker;
  const path = owned ? `/_waffle_owned/${run}/client.html` : page;
  const url = documentURL(
    origin,
    path,
    token,
    !item || item.query === undefined ? {} : item.query(run),
  );
  const serviceWorker = owned ? { ...owned, clientURL: url } : undefined;
  if (serviceWorker && item) collector.declareWorker(item.id, serviceWorker);
  const fixturePaths =
    item && application && item.id === application.declaration.caseId
      ? application.paths()
      : undefined;
  return { url, serviceWorker, fixturePaths };
}

function documentURL(origin: string, path: string, token: string, query: unknown): string {
  const url = new URL(path, origin);
  copyQuery(url.searchParams, query);
  url.searchParams.set("token", token);
  return url.href;
}
function copyQuery(parameters: URLSearchParams, query: unknown): void {
  if (!record(query) || ![Object.prototype, null].includes(Object.getPrototypeOf(query)))
    throw new Error("Case query must be a string record");
  const reserved = new Set([
    "token",
    "url",
    "path",
    "href",
    "origin",
    "protocol",
    "host",
    "hostname",
    "port",
    "pathname",
    "search",
    "hash",
    "username",
    "password",
  ]);
  for (const key of Reflect.ownKeys(query)) {
    if (!Object.prototype.propertyIsEnumerable.call(query, key)) continue;
    if (
      typeof key !== "string" ||
      !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key) ||
      reserved.has(key.toLowerCase())
    )
      throw new Error("Invalid or reserved case query key");
    const value = query[key];
    if (typeof value !== "string") throw new Error("Case query values must be strings");
    parameters.set(key, value);
  }
}
