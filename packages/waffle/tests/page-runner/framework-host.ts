import { FrameworkTraceOwner, tracePath } from "./framework-trace.js";
import { writeResult } from "./result-file.js";
import { readFileSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { bounded, type CleanupStep, type DriverCleanup } from "./driver.js";
import { SafariDriver } from "./safari-driver.js";
import { HostConsumers } from "./owned-consumers.js";
import { FrameworkQueue } from "./framework-queue.js";
import { FrameworkCollector } from "./framework-collector.js";
import { frameworkMiddleware } from "./framework-middleware.js";
import { validateFrameworkOptions, parseVitestEnd } from "./framework-validation.js";
import { record } from "./protocol.js";
import type {
  AttachedConnection,
  FrameAdapter,
  FrameworkGeometry,
  FrameworkHost,
  FrameworkOptions,
  FrameworkMiddlewareStack,
  FrameworkResult,
  ProviderOperation,
  ViewportOperation,
  ScreenshotOperation,
  VitestEnd,
} from "./framework-types.js";

const mountedFrameworkServers = new WeakSet<object>();
const absent = (): CleanupStep => ({ status: "not-created", detail: "Not allocated" });
function bootstrapSource(): string {
  let root = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(root, "package.json"))) {
    const next = dirname(root);
    if (root === next) throw new Error("Prepared framework bootstrap not found");
    root = next;
  }
  return readFileSync(join(root, "dist/tests/page-runner/framework-bootstrap.js"), "utf8");
}
function snapshot(value: unknown) {
  if (
    !record(value) ||
    typeof value.doc !== "string" ||
    typeof value.token !== "string" ||
    value.valid !== true ||
    typeof value.ackedThrough !== "number" ||
    typeof value.pending !== "number" ||
    typeof value.contentClosed !== "boolean" ||
    (value.failure !== null && typeof value.failure !== "string")
  )
    throw new Error("Invalid actual document observation");
  if (value.failure) throw new Error(`Page reporting failed: ${value.failure}`);
  return {
    doc: value.doc,
    token: value.token,
    ackedThrough: value.ackedThrough,
    pending: value.pending,
    paired: value.paired === true,
    contentClosed: value.contentClosed,
  };
}
function geometry(value: unknown): FrameworkGeometry {
  if (!record(value) || !record(value.tester) || !record(value.top) || !record(value.iframe))
    throw new Error("Missing bound geometry");
  const { tester, top, iframe } = value;
  const dimensions = [
    tester.width,
    tester.height,
    tester.dpr,
    top.width,
    top.height,
    top.visualWidth,
    top.visualHeight,
    top.scale,
    iframe.width,
    iframe.height,
  ];
  if (
    dimensions.some(
      (value) => typeof value !== "number" || !Number.isFinite(value) || value <= 0,
    ) ||
    ![iframe.x, iframe.y].every((value) => typeof value === "number" && Number.isFinite(value))
  )
    throw new Error("Actual geometry is not finite and positive");
  return value as FrameworkGeometry;
}
export class PageFrameworkHost implements FrameworkHost {
  private readonly started = performance.now();
  private readonly controller = new AbortController();
  private readonly consumers = new HostConsumers();
  private readonly collector: FrameworkCollector;
  private readonly queue: FrameworkQueue;
  readonly middleware: FrameworkHost["middleware"];
  private readonly mounts = new Set<FrameworkMiddlewareStack>();
  private scratch = "";
  private driver: SafariDriver | undefined;
  private frames: FrameAdapter | undefined;
  private disconnect: (() => Promise<void>) | undefined;
  private closeContext: (() => Promise<void>) | undefined;
  private executing: Promise<VitestEnd> | undefined;
  private running = false;
  private finalizing: Promise<FrameworkResult> | undefined;
  private finalized = false;
  private detaching: Promise<void> | undefined;
  private fileStarted: number | null = null;
  private openedUrl: string | null = null;
  private handle: string | null = null;
  private bound = false;
  private binding: FrameworkResult["binding"] = null;
  private viewportPermit: string | null = null;
  private geometryValue: FrameworkGeometry | null = null;
  private framework: VitestEnd | null = null;
  private monitorTimer: ReturnType<typeof setInterval> | undefined;
  private monitorBusy = false;
  private retired = false;
  private traceOwner: FrameworkTraceOwner | undefined;
  private destructionStarted = false;
  private traceGeneration: string | undefined;
  private retirementStarted: number | null = null;
  constructor(
    private readonly options: FrameworkOptions,
    private readonly controlEndpoint?: string,
  ) {
    validateFrameworkOptions(options);
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (
      !process.versions.bun &&
      (major === undefined || major < 22 || (major === 22 && (minor ?? 0) < 18))
    )
      throw new Error("Framework host requires Node 22.18 or later");
    this.collector = new FrameworkCollector(options.expected, (detail) => this.cancel(detail));
    this.queue = new FrameworkQueue(
      this.consumers,
      () => this.check(),
      (detail) => this.fault("transport", detail),
    );
    this.controller.signal.addEventListener(
      "abort",
      () => {
        this.queue.revoke();
        this.traceOwner?.cancelLiveOperations();
      },
      { once: true },
    );
    this.middleware = frameworkMiddleware(this.collector, () => this.traceOwner);
  }
  captureTesterTrace(
    options: Parameters<FrameworkHost["captureTesterTrace"]>[0],
  ): ReturnType<FrameworkHost["captureTesterTrace"]> {
    if (this.running || this.finalizing || this.traceOwner)
      throw new Error("Trace capture must be armed exactly once before run");
    this.traceOwner = new FrameworkTraceOwner(options, (reason) => this.fault("trace", reason));
    return this.traceOwner.capture;
  }
  mount(server: FrameworkMiddlewareStack): void {
    if (this.driver?.uncertain || this.frames || this.finalizing)
      throw new Error("Collector mount must precede session allocation");
    if (
      mountedFrameworkServers.has(server) ||
      this.mounts.has(server) ||
      server.stack.some(
        (item) =>
          ["/report", "/heartbeat", "/retire"].includes(item.route) ||
          item.route.startsWith(tracePath) ||
          item.handle === this.middleware,
      )
    )
      throw new Error("Collector mount conflicts with a reserved route");
    server.use(this.middleware);
    this.mounts.add(server);
    mountedFrameworkServers.add(server);
  }
  private fault(category: string, detail: string): void {
    if (this.finalized) return;
    this.collector.fail(category, detail);
    this.cancel(detail);
  }
  private cancel(detail: string): void {
    this.collector.cancel();
    if (!this.controller.signal.aborted) this.controller.abort(new Error(detail));
  }
  private check(): void {
    if (performance.now() - this.started >= 900000)
      this.fault("run-timeout", "Absolute 900000 ms run deadline");
    if (
      this.fileStarted !== null &&
      !this.retired &&
      performance.now() - this.fileStarted >= 600000
    )
      this.fault("file-timeout", "Absolute 600000 ms file deadline");
    if (this.collector.failures.length) this.cancel("Sticky framework host failure");
    this.controller.signal.throwIfAborted();
    if (!this.running || this.finalizing) throw new Error("Framework host is not executing");
  }
  instrumentDocument(input: Parameters<FrameworkHost["instrumentDocument"]>[0]): string {
    this.check();
    if (!input.html.includes("<head>"))
      throw new Error("Framework HTML has no head insertion point");
    const state = this.collector.expect(input.kind, input.url);
    const config = JSON.stringify({
      run: this.collector.run,
      token: state.token,
      kind: state.kind,
      url: state.url,
      trace: this.traceOwner !== undefined,
    }).replaceAll("<", "\\u003c");
    const script = bootstrapSource().replaceAll("</script", "<\\/script");
    return input.html.replace(
      "<head>",
      `<head><script>window.__waffleFrameworkConfiguration=${config};\n${script}</script>`,
    );
  }
  async attach<T>(input: {
    connect: (connection: AttachedConnection) => Promise<T>;
    detach: () => Promise<void>;
    frames: FrameAdapter;
  }): Promise<T> {
    this.check();
    if (!this.mounts.size) throw new Error("Collector must be mounted before session creation");
    if (!this.closeContext)
      throw new Error("Actual framework context close must be registered before session creation");
    for (const server of this.mounts) {
      if (
        server.stack.some(
          (item) =>
            item.handle !== this.middleware &&
            (["/report", "/heartbeat", "/retire"].includes(item.route) ||
              item.route.startsWith(tracePath)),
        )
      )
        throw new Error("Collector mount conflicts with a reserved route before session creation");
    }
    if (this.frames) throw new Error("Provider attachment repeated or reopened");
    this.fileStarted ??= performance.now();
    this.frames = input.frames;
    this.disconnect = input.detach;
    return this.queue.run(async () => {
      const driver = this.driver;
      if (!driver) throw new Error("Framework driver not allocated");
      if (this.controlEndpoint)
        await driver.startControl(this.controlEndpoint, this.controller.signal);
      else await driver.start(this.controller.signal);
      this.check();
      this.handle = await driver.handle(this.controller.signal);
      this.check();
      const connection = driver.connection();
      this.queue.bindSession(connection.sessionId);
      const browser = await this.consumers.invoke(() => input.connect(connection));
      this.check();
      return browser;
    }, "attach");
  }
  async openPage(actualUrl: string, open: () => Promise<void>): Promise<void> {
    this.check();
    if (this.openedUrl !== null) throw new Error("Framework file navigation repeated");
    this.fileStarted ??= performance.now();
    this.openedUrl = actualUrl;
    await this.queue.run(async () => {
      if (!this.driver) throw new Error("No owned driver");
      await this.consumers.invoke(open);
      if (!this.frames || this.handle === null)
        throw new Error("Provider navigation did not attach the owned session");
    }, "open");
    // No admission wait inside navigation. The monitor owns the next queue entry.
  }
  provider(operation: ViewportOperation): Promise<void>;
  provider<T>(
    operation: ProviderOperation | ScreenshotOperation,
    callback: () => Promise<T>,
  ): Promise<T>;
  provider<T>(
    operation: ProviderOperation | ViewportOperation | ScreenshotOperation,
    callback?: () => Promise<T>,
  ): Promise<T | void> {
    this.check();
    if (typeof operation === "string") {
      if (
        !["open", "test-frame", "main-frame", "framework-cleanup"].includes(operation) ||
        typeof callback !== "function"
      )
        return Promise.reject(new Error("Invalid lifecycle operation"));
      return this.queue.run(callback, operation);
    }
    try {
      return this.domain(this.validateDomain(operation, callback), callback);
    } catch (reason) {
      this.fault("operation", "Framework domain admission failed");
      return Promise.reject(reason);
    }
  }
  private validateDomain(
    operation: ViewportOperation | ScreenshotOperation,
    callback: unknown,
  ): ViewportOperation | ScreenshotOperation {
    if (!record(operation)) throw new Error("Invalid framework domain operation");
    if (operation.kind === "viewport") {
      if (
        callback !== undefined ||
        ![operation.width, operation.height].every(
          (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
        )
      )
        throw new Error("Viewport requires finite positive dimensions and no callback");
      return { kind: "viewport", width: operation.width, height: operation.height };
    }
    if (
      operation.kind !== "screenshot" ||
      typeof operation.file !== "string" ||
      typeof callback !== "function"
    )
      throw new Error("Screenshot requires an actual file and callback");
    return { kind: "screenshot", file: operation.file };
  }
  private content(file: string, binding: FrameworkResult["binding"]): void {
    this.check();
    if (
      !binding ||
      this.binding !== binding ||
      !this.bound ||
      !this.collector.viewportConsumed ||
      this.collector.executionFlushed ||
      this.collector.cleanupSettled ||
      this.collector.cleanupResponse ||
      this.retired ||
      file !== this.options.scope.files[0] ||
      !this.collector.collection.some((task) => task.file === file)
    )
      throw new Error("Framework file content is not live and admitted");
  }
  private async selectedDocument(): Promise<void> {
    const driver = this.driver,
      frames = this.frames;
    if (!driver || !frames || this.handle === null)
      throw new Error("Missing bound driver or frame");
    if (
      (await driver.handle(this.controller.signal)) !== this.handle ||
      !(await driver.handles(this.controller.signal)).includes(this.handle)
    )
      throw new Error("Owned framework window changed");
    const expected = this.collector.document(frames.isTestFrame() ? "tester" : "orchestrator");
    const value = await driver.script(
      "const b=window.__waffleFramework; return b ? b.snapshot() : null;",
      this.controller.signal,
    );
    const actual = snapshot(value);
    if (
      !record(value) ||
      !expected ||
      value.kind !== expected.kind ||
      actual.doc !== expected.doc ||
      actual.token !== expected.token ||
      actual.contentClosed ||
      !actual.paired
    )
      throw new Error("Selected framework document changed or closed");
    const challenge = `const b=window.__waffleFramework; return !!b && b.challenge(${JSON.stringify(expected.token)},${JSON.stringify(expected.doc)});`;
    if ((await driver.script(challenge, this.controller.signal)) !== true)
      throw new Error("Selected framework document challenge failed");
  }
  private async observeContent(operation: ViewportOperation | ScreenshotOperation): Promise<void> {
    await this.selectedDocument();
    await this.main(() => this.observeBoundContent(operation));
    await this.selectedDocument();
  }
  private async observeBoundContent(
    operation: ViewportOperation | ScreenshotOperation,
  ): Promise<void> {
    try {
      const top = snapshot(await this.script("return bridge.snapshot();"));
      const tester = snapshot(await this.script("return bridge.testerSnapshot();"));
      const topState = this.collector.document("orchestrator"),
        testerState = this.collector.document("tester");
      if (
        top.doc !== topState?.doc ||
        top.token !== topState.token ||
        tester.doc !== testerState?.doc ||
        tester.token !== testerState.token ||
        !top.paired ||
        !tester.paired ||
        top.contentClosed ||
        tester.contentClosed
      )
        throw new Error("Bound framework documents changed or closed");
      const actual = geometry(await this.script("return bridge.geometry();"));
      if (
        operation.kind === "viewport" &&
        (actual.tester.width !== operation.width || actual.tester.height !== operation.height)
      )
        throw new Error(
          `Viewport target unrealized: tester ${actual.tester.width} by ${actual.tester.height}; iframe ${actual.iframe.width} by ${actual.iframe.height}`,
        );
    } catch (reason) {
      this.fault("operation", "Actual framework document or viewport verification failed");
      throw reason;
    }
  }
  private domain<T>(
    operation: ViewportOperation | ScreenshotOperation,
    callback: (() => Promise<T>) | undefined,
  ): Promise<T | void> {
    const binding = this.binding;
    const file = operation.kind === "screenshot" ? operation.file : this.options.scope.files[0];
    this.content(file, binding);
    let entryTester = false;
    const before = async () => {
      this.content(file, binding);
      entryTester = this.frames?.isTestFrame() === true;
      await this.observeContent(operation);
      this.content(file, binding);
      if (callback) return this.queue.run(callback);
    };
    const finalize = async () => {
      await this.observeContent(operation);
      this.content(file, binding);
      const frames = this.frames;
      if (!frames) throw new Error("Missing frame callbacks at restoration");
      if (frames.isTestFrame() === entryTester) return;
      await this.queue.run(
        entryTester ? frames.tester : frames.main,
        entryTester ? "test-frame" : "main-frame",
      );
      await this.selectedDocument();
    };
    return this.queue
      .run(before, operation.kind, {
        rootOnly: true,
        finalize,
        complete: () => this.content(file, binding),
      })
      .catch((reason: unknown) => {
        this.fault("operation", "Bound framework operation failed");
        throw reason;
      });
  }
  guardRequest<T extends RequestInit>(request: T): T {
    return this.queue.guard(request);
  }
  observeResponse<T extends { statusCode: number; body?: unknown }>(
    response: T,
    request: RequestInit,
  ): T {
    return this.queue.response(response, request);
  }
  requestStarted(client: unknown): void {
    this.queue.observe(client);
    this.queue.commandStarted();
  }
  requestSettled(outcome: Parameters<FrameworkHost["requestSettled"]>[0]): void {
    this.queue.commandSettled();
    if (outcome.kind === "transport-fault") this.fault("command", outcome.detail);
  }
  detach(): Promise<void> {
    if (this.detaching) return this.detaching;
    this.detaching = Promise.resolve().then(async () => {
      this.queue.revoke();
      await this.queue.join();
    });
    return this.detaching;
  }
  private async main<T>(operation: () => Promise<T>): Promise<T> {
    const frames = this.frames;
    if (!frames) throw new Error("Frame callbacks not registered");
    const wasTester = frames.isTestFrame();
    if (wasTester) await this.queue.run(frames.main, "main-frame");
    try {
      return await operation();
    } finally {
      if (wasTester && !this.driver?.uncertain && !this.controller.signal.aborted)
        await this.queue.run(frames.tester, "test-frame");
    }
  }
  private async script(source: string): Promise<unknown> {
    this.check();
    const driver = this.driver;
    if (!driver || this.handle === null || !this.openedUrl)
      throw new Error("No navigated owned framework window");
    const handles = await driver.handles(this.controller.signal);
    if (
      !handles.includes(this.handle) ||
      (await driver.handle(this.controller.signal)) !== this.handle
    )
      throw new Error("Owned framework window changed");
    return driver.script(
      `if(location.href!==${JSON.stringify(this.openedUrl)}) throw new Error('Framework URL changed'); const bridge=window.__waffleFramework; if(!bridge) return null; ${source}`,
      this.controller.signal,
    );
  }
  private async admission(): Promise<void> {
    const top = this.collector.document("orchestrator"),
      tester = this.collector.document("tester");
    if (!top?.doc || !tester?.doc || !this.frames) return;
    const topSnapshot = snapshot(await this.script("return bridge.snapshot();"));
    top.ackedThrough = topSnapshot.ackedThrough;
    top.pending = topSnapshot.pending;
    if (
      topSnapshot.doc !== top.doc ||
      topSnapshot.token !== top.token ||
      top.url !== this.openedUrl
    )
      throw new Error("Top document challenge mismatch");
    if (this.traceOwner && (await this.script("return bridge.traceReady();")) !== true) return;
    const capture = await this.script("return bridge.capture();");
    if (capture === null) return;
    if (
      !record(capture) ||
      capture.doc !== top.doc ||
      capture.testerDoc !== tester.doc ||
      !record(capture.frame) ||
      typeof capture.frame["element-6066-11e4-a52e-4f735466cecf"] !== "string" ||
      !capture.frame["element-6066-11e4-a52e-4f735466cecf"]
    )
      throw new Error("Actual iframe document capture mismatch");
    await this.queue.run(this.frames.tester, "test-frame");
    try {
      const source = `const b=window.__waffleFramework; return !!b && b.challenge(${JSON.stringify(tester.token)},${JSON.stringify(tester.doc)});`;
      if ((await this.driver?.script(source, this.controller.signal)) !== true)
        throw new Error("Tester document challenge mismatch");
      if (this.traceOwner) {
        top.admitted = true;
        tester.admitted = true;
      }
      const generation = this.traceOwner?.admit(top, tester);
      this.traceGeneration = generation;
      await this.driver?.script(
        `return window.__waffleFramework.admit(${JSON.stringify(tester.token)},${JSON.stringify(tester.doc)},null,${JSON.stringify(generation) ?? "undefined"});`,
        this.controller.signal,
      );
    } finally {
      await this.queue.run(this.frames.main, "main-frame");
    }
    if (!this.handle) throw new Error("Missing owned window at admission");
    this.binding = {
      windowHandle: this.handle,
      iframeElementId: String(capture.frame["element-6066-11e4-a52e-4f735466cecf"]),
      topUrl: top.url,
      testerUrl: tester.url,
    };
    this.viewportPermit = crypto.randomUUID();
    top.admitted = true;
    tester.admitted = true;
    this.bound = true;
    await this.script(
      `return bridge.admit(${JSON.stringify(top.token)},${JSON.stringify(top.doc)},${JSON.stringify(this.viewportPermit)},${JSON.stringify(this.traceGeneration) ?? "undefined"});`,
    );
  }
  private async probe(): Promise<void> {
    const top = snapshot(await this.script("return bridge.snapshot();"));
    const tester = snapshot(await this.script("return bridge.testerSnapshot();"));
    const topState = this.collector.document("orchestrator"),
      testerState = this.collector.document("tester");
    if (topState) {
      topState.ackedThrough = top.ackedThrough;
      topState.pending = top.pending;
    }
    if (testerState) {
      testerState.ackedThrough = tester.ackedThrough;
      testerState.pending = tester.pending;
    }
    if (
      top.doc !== this.collector.document("orchestrator")?.doc ||
      tester.doc !== this.collector.document("tester")?.doc ||
      top.paired !== true
    )
      throw new Error("Paired document binding changed");
    if (this.collector.cleanupResponse && this.collector.cleanupSettled) await this.retire();
  }
  private async retire(): Promise<void> {
    this.retirementStarted ??= performance.now();
    if (this.traceOwner?.pending) return;
    const tester = this.collector.document("tester"),
      top = this.collector.document("orchestrator");
    if (!tester || !top) throw new Error("Missing paired documents at retirement");
    tester.retiring = true;
    top.retiring = true;
    if (!tester.ready || !top.ready) return;
    const testerSnapshot = snapshot(await this.script("return bridge.testerSnapshot();"));
    const topSnapshot = snapshot(await this.script("return bridge.snapshot();"));
    tester.ackedThrough = testerSnapshot.ackedThrough;
    tester.pending = testerSnapshot.pending;
    top.ackedThrough = topSnapshot.ackedThrough;
    top.pending = topSnapshot.pending;
    if (
      testerSnapshot.pending !== 0 ||
      topSnapshot.pending !== 0 ||
      testerSnapshot.ackedThrough !== tester.messages.length - 1 ||
      topSnapshot.ackedThrough !== top.messages.length - 1
    )
      return;
    if ((await this.script(`return bridge.testerCutoff(${tester.messages.length - 1});`)) !== true)
      throw new Error("Tester cutoff not confirmed");
    tester.cutoff = performance.now();
    if ((await this.script(`return bridge.cutoff(${top.messages.length - 1});`)) !== true)
      throw new Error("Top cutoff not confirmed");
    top.cutoff = performance.now();
    this.retired = true;
  }
  async initialViewport(request: unknown): Promise<void> {
    this.check();
    if (
      !record(request) ||
      request.permit !== this.viewportPermit ||
      !this.viewportPermit ||
      request.width !== 414 ||
      request.height !== 896 ||
      !this.bound ||
      this.collector.viewportConsumed ||
      this.collector.collection.length
    ) {
      this.fault("viewport-permit", "Automatic initial viewport permit rejected");
      throw new Error("Automatic initial viewport permit rejected");
    }
    await this.queue.run(() => this.measureInitialViewport());
  }
  private async measureInitialViewport(): Promise<void> {
    try {
      this.check();
      if (!this.frames || this.frames.isTestFrame())
        throw new Error("Initial viewport command from the wrong frame");
      if (this.collector.viewportConsumed || this.collector.collection.length)
        throw new Error("Initial viewport permit expired");
      const actual = geometry(await this.script("return bridge.geometry();"));
      if (actual.tester.width !== 414 || actual.tester.height !== 896)
        throw new Error("Actual logical tester is not 414 by 896");
      this.geometryValue = actual;
      this.collector.viewportConsumed = true;
      this.viewportPermit = null;
    } catch (error) {
      this.fault("viewport", String(error));
      throw error;
    }
  }
  private tick(): void {
    if (this.finalizing) return;
    try {
      this.check();
    } catch {
      return;
    }
    if (this.retirementStarted !== null && performance.now() - this.retirementStarted >= 5000)
      this.fault("retirement-timeout", "Final document barrier exceeded 5000 ms");
    if (this.retired || this.fileStarted === null) return;
    if (!this.bound && performance.now() - this.fileStarted > 60000)
      this.fault("startup", "Paired admission exceeded 60000 ms");
    if (
      this.collector.documents.some(
        (document) =>
          document.doc &&
          document.cutoff === null &&
          performance.now() - document.heartbeatAt > 10000,
      )
    )
      this.fault("heartbeat", "Document heartbeat gap exceeded 10000 ms");
    if (this.monitorBusy || this.controller.signal.aborted) return;
    this.monitorBusy = true;
    void this.queue
      .run(() => this.main(() => (this.bound ? this.probe() : this.admission())), "observation")
      .catch((error) => this.fault("observation", String(error)))
      .finally(() => {
        this.monitorBusy = false;
      });
  }
  private async executeFramework(execute: Parameters<FrameworkHost["run"]>[0]): Promise<VitestEnd> {
    const end = await execute((close) => this.registerContextClose(close));
    this.framework = parseVitestEnd(end);
    return this.framework;
  }
  private registerContextClose(close: () => Promise<void>): void {
    if (this.closeContext) throw new Error("Framework context closer registered twice");
    this.closeContext = close;
    if (this.controller.signal.aborted && (!this.traceOwner?.pending || this.destructionStarted))
      void this.closeRegisteredContext().catch(() => {});
  }
  async run(execute: Parameters<FrameworkHost["run"]>[0]): Promise<FrameworkResult> {
    if (this.running) throw new Error("Framework run invoked twice");
    this.running = true;
    const interrupt = () => this.fault("interrupted", "Framework run interrupted");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", interrupt);
    this.monitorTimer = setInterval(() => this.tick(), 25);
    try {
      this.check();
      const root =
        process.env.STORAGE_SCRATCH_ROOT ??
        (process.platform === "darwin" ? join(homedir(), "tmp") : "/work/tmp");
      await this.consumers.invoke(() => mkdir(root, { recursive: true }));
      this.check();
      await this.consumers.invoke(async () => {
        this.scratch = await mkdtemp(join(root, "waffle-framework-"));
      });
      this.check();
      this.driver = new SafariDriver(this.options.native.udid, this.scratch, (facts) =>
        this.queue.recordFailure(facts),
      );
      this.executing = this.consumers.invoke(() => this.executeFramework(execute));
      const failed = new Promise<never>((_, reject) =>
        this.controller.signal.addEventListener(
          "abort",
          () => reject(this.controller.signal.reason),
          { once: true },
        ),
      );
      this.check();
      await Promise.race([this.executing, failed]);
      await this.queue.join();
      this.check();
      if (!this.retired) throw new Error("Framework ended without paired final retirement");
    } catch (error) {
      if (!this.collector.failures.length) this.fault("execution", String(error));
    } finally {
      clearInterval(this.monitorTimer);
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
    return this.finish();
  }
  abort(reason: string): Promise<FrameworkResult> {
    if (this.finalizing) return this.finalizing;
    this.fault("abort", reason);
    return this.finish();
  }
  private closePromise: Promise<void> | undefined;
  private closeRegisteredContext(): Promise<void> {
    if (!this.closeContext)
      return Promise.reject(new Error("Framework context close was not registered"));
    return (this.closePromise ??= this.consumers.invoke(this.closeContext));
  }
  private finish(): Promise<FrameworkResult> {
    return (this.finalizing ??= Promise.resolve().then(() => this.teardown()));
  }
  private async joinContext(context: Promise<void>, deadlineAt: number): Promise<CleanupStep> {
    const detail = "Registered framework context closed";
    try {
      await bounded(context, Math.max(1, deadlineAt - performance.now()), detail);
      return { status: "confirmed", detail };
    } catch (error) {
      this.collector.fail("cleanup", String(error));
      return { status: "unconfirmed", detail: String(error) };
    }
  }
  private async teardown(): Promise<FrameworkResult> {
    const cleanupDeadline = performance.now() + 60000;
    const remaining = () => Math.max(1, Math.min(12000, cleanupDeadline - performance.now()));
    clearInterval(this.monitorTimer);
    this.queue.revoke();
    const contextStepEnd = Math.min(
      cleanupDeadline,
      performance.now() + 12000,
      this.started + 900000,
      this.fileStarted === null ? Infinity : this.fileStarted + 600000,
    );
    const trace = this.traceOwner
      ? await this.traceOwner.settleBeforeDestruction(contextStepEnd)
      : { status: "not-requested" as const };
    if (trace.status === "incomplete") this.collector.fail("trace", trace.reason);
    this.destructionStarted = true;
    const context = this.closeContext ? this.closeRegisteredContext() : undefined;
    let contextStep = absent(),
      provider = absent();
    const step = async (promise: Promise<unknown>, label: string): Promise<CleanupStep> => {
      try {
        await bounded(promise, remaining(), label);
        return { status: "confirmed", detail: label };
      } catch (error) {
        this.collector.fail("cleanup", String(error));
        return { status: "unconfirmed", detail: String(error) };
      }
    };
    await step(this.detach(), "Provider queue stopped");
    const faultStop = this.controller.signal.aborted ? this.driver?.stop() : undefined;
    void faultStop?.catch(() => {});
    if (this.disconnect)
      provider = await step(
        this.consumers.invoke(this.disconnect),
        "Attached provider detached without DELETE",
      );
    if (context)
      contextStep = await this.joinContext(
        context,
        this.traceOwner ? contextStepEnd : performance.now() + remaining(),
      );
    const callbackStepEnd = Math.min(cleanupDeadline, performance.now() + 12000);
    const callbacksStopped = await this.consumers.join(
      Math.max(1, callbackStepEnd - performance.now()),
    );
    if (!context && this.closeContext)
      contextStep = await step(
        this.closeRegisteredContext(),
        "Late registered framework context closed",
      );
    const callbacks: CleanupStep = {
      status: callbacksStopped ? "confirmed" : "unconfirmed",
      detail: callbacksStopped
        ? "All invoked consumers settled"
        : "Consumer settlement unconfirmed",
    };
    let driverCleanup: DriverCleanup = {
      session: absent(),
      launcher: absent(),
      serviceDisposition: "No native launcher allocated",
    };
    if (this.driver) {
      try {
        driverCleanup = await bounded(
          faultStop ?? this.driver.stop(),
          remaining(),
          "Parent driver stop",
        );
      } catch (error) {
        driverCleanup.session = { status: "unconfirmed", detail: String(error) };
      }
    }
    const traceCleanup = this.traceOwner
      ? await this.traceOwner.close(callbackStepEnd, driverCleanup.session.status === "confirmed")
      : absent();
    const stopped =
      callbacksStopped &&
      [traceCleanup, provider, contextStep, driverCleanup.session, driverCleanup.launcher].every(
        (step) => step.status !== "unconfirmed",
      );
    let scratch = absent();
    if (this.scratch)
      scratch = stopped
        ? await step(rm(this.scratch, { recursive: true, force: true }), "Owned scratch removed")
        : {
            status: "unconfirmed",
            detail: `Retained ${this.scratch}; owned consumers unconfirmed`,
          };
    this.queue.releaseObservers();
    const cleanup = {
      ...driverCleanup,
      trace: traceCleanup,
      callbacks,
      provider,
      context: contextStep,
      scratch,
    };
    if (
      Object.values(cleanup).some(
        (value) => typeof value === "object" && value.status === "unconfirmed",
      )
    )
      this.collector.fail("cleanup", "Owned cleanup unconfirmed");
    const fileComplete =
      stopped &&
      this.collector.failures.length === 0 &&
      this.framework?.status === "passed" &&
      trace.status !== "incomplete" &&
      this.retired &&
      this.collector.executionFlushed &&
      this.collector.cleanupResponse &&
      this.collector.cases.every((item) => item.started && item.outcome?.state === "pass");
    const result: FrameworkResult = {
      trace,
      cleanupDeadlineAt: cleanupDeadline,
      suite: this.options.suite,
      run: this.collector.run,
      expected: this.options.expected,
      cases: this.collector.cases,
      collection: this.collector.collection,
      events: this.collector.events,
      documents: this.collector.documents.map((item) => ({
        kind: item.kind,
        doc: item.doc,
        acceptedThrough: item.messages.length - 1,
        ackedThrough: item.ackedThrough,
        pending: item.pending,
        cutoff: item.cutoff,
      })),
      binding: this.binding,
      commandHooks: this.queue.commandHooks.slice(),
      commandFailures: this.queue.commandFailures.slice(),
      geometry: this.geometryValue,
      framework: this.framework,
      failures: this.collector.failures,
      fileComplete,
      rootBrowserSuiteComplete: false,
      omittedRootFiles: "not enumerated",
      cleanup,
      exit: fileComplete ? 4 : 2,
    };
    try {
      await bounded(
        writeResult(this.options.resultPath, result),
        remaining(),
        "Atomic framework result write",
      );
    } catch (error) {
      this.collector.fail("result-write", String(error));
      result.exit = 2;
    }
    this.finalized = true;
    return result;
  }
}
