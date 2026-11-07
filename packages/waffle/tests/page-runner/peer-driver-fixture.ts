import { record, type Body } from "./protocol.js";
import { OrderedReporter } from "./ordered-reporter.js";
import { FakeDriver } from "./fake-driver.js";

export type PeerFault =
  | "none"
  | "close-present"
  | "close-wrong"
  | "reload-old"
  | "reload-handle"
  | "create-existing"
  | "create-hang";
class PeerDocument {
  readonly reporter: OrderedReporter<Body>;
  readonly window: Record<string, unknown>;
  private retiring: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  readonly host = {
    phase: "admitting",
    transition: null as { id: string; acknowledgedThrough: number | null } | null,
    prepareTransition: (id: string) => {
      if (this.host.transition) throw new Error("Duplicate transition");
      const transition = { id, acknowledgedThrough: null as number | null };
      this.host.transition = transition;
      void this.reporter
        .send({ kind: "transition-ready", transitionId: id })
        .then(() => {
          transition.acknowledgedThrough = this.reporter.observation.ackedThrough;
        })
        .catch(() => {});
    },
    task: (operation: string, source: string) => {
      const task: Promise<unknown> = new Function("window", `return (async () => {${source}\n})()`)(
        this.window,
      );
      void task.then(() =>
        this.reporter.send({ kind: "task-end", caseId: "peer", operation, status: "pass" }),
      );
    },
    verdict: (body: { status: "pass" | "fail"; result?: unknown; error?: string }) => {
      this.host.phase = "teardown";
      void this.terminal(body);
    },
  };
  constructor(
    readonly config: Record<string, unknown>,
    readonly url: string,
    readonly driver: PeerDriverFixture,
  ) {
    const origin = new URL(url).origin;
    this.reporter = new OrderedReporter(String(config.run), async (path, init) => {
      const response = await fetch(origin + path, init);
      if (
        driver.holdPeerReadyAcknowledgement &&
        String(init.body).includes('"kind":"peer-ready"')
      ) {
        driver.peerReadyReceived.resolve();
        await driver.release.promise;
      }
      if (String(init.body).includes('"kind":"transition-ready"')) {
        driver.prepared.resolve();
        if (driver.holdAcknowledgement) await driver.release.promise;
      }
      return response;
    });
    this.window = {
      __suiteConfiguration: config,
      __pageRunner: this.reporter.observation,
      __hostCase: this.host,
      effects: driver.effects,
    };
  }
  async start(): Promise<void> {
    await this.reporter.send({
      kind: "hello",
      token: String(this.config.token),
      group: String(this.config.group),
    });
    this.reporter.startHeartbeat(5);
    if (this.config.role === "peer") {
      await this.reporter.send({ kind: "peer-ready" });
      this.host.phase = "driving";
      return;
    }
    if (this.config.role === "case") {
      await this.reporter.send({ kind: "case-ready", caseId: "peer" });
      this.host.phase = "ready";
      return;
    }
    await this.reporter.send(
      this.config.role === "list"
        ? { kind: "list", cases: ["peer"] }
        : { kind: "run-complete", remaining: [] },
    );
    await this.complete();
  }
  private async terminal(body: {
    status: "pass" | "fail";
    result?: unknown;
    error?: string;
  }): Promise<void> {
    await this.reporter.send({ kind: "case-teardown", caseId: "peer" });
    await this.reporter.send({
      kind: "case-end",
      caseId: "peer",
      ...body,
      result: { body, teardown: { status: "pass" } },
    });
    this.host.phase = "terminal";
    await this.complete();
  }
  private async complete(): Promise<void> {
    await this.reporter.send({ kind: "doc-complete" });
    this.retiring = setInterval(() => {
      void this.poll();
    }, 1);
  }
  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const url = new URL(this.url);
      const response = await fetch(
        `${url.origin}/retire?run=${String(this.config.run)}&doc=${this.reporter.observation.doc}`,
      );
      if ((await response.json()) !== true) return;
      clearInterval(this.retiring);
      await this.reporter.send({ kind: "retire-ready" });
    } finally {
      this.polling = false;
    }
  }
  stop(): void {
    clearInterval(this.retiring);
    this.reporter.stop();
  }
}
export class PeerDriverFixture extends FakeDriver {
  readonly windows = new Map<string, PeerDocument | null>([["root", null]]);
  readonly effects: number[] = [];
  readonly actions: string[] = [];
  prepared = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();
  holdAcknowledgement = false;
  holdPeerReadyAcknowledgement = false;
  readonly peerReadyReceived = Promise.withResolvers<void>();
  readonly peerAdmissionObserved = Promise.withResolvers<{ phase: string; pending: number }>();
  private readonly peerStarts: Promise<void>[] = [];
  selectionGate: Promise<void> | undefined;
  selected = "root";
  constructor(readonly fault: PeerFault = "none") {
    super("pass");
  }
  override async createWindow(): Promise<string> {
    this.actions.push("create");
    if (this.fault === "create-existing") return "root";
    if (this.fault === "create-hang") {
      this.uncertain = true;
      await this.release.promise;
    }
    const handle = crypto.randomUUID();
    this.windows.set(handle, null);
    return handle;
  }
  override async selectWindow(handle: string): Promise<void> {
    if (this.selectionGate) await this.selectionGate;
    if (!this.windows.has(handle)) throw new Error("Exact peer missing");
    this.selected = handle;
  }
  override async handle(): Promise<string> {
    return this.selected;
  }
  override async handles(): Promise<string[]> {
    return Array.from(this.windows.keys());
  }
  override async url(): Promise<string> {
    return this.document().url;
  }
  private document(): PeerDocument {
    const value = this.windows.get(this.selected);
    if (!value) throw new Error("No fake document");
    return value;
  }
  override async navigate(url: string): Promise<void> {
    this.navigations++;
    this.windows.get(this.selected)?.stop();
    const html = await (await fetch(url)).text();
    const value: unknown = JSON.parse(
      /window\.__suiteConfiguration=(.+?)<\/script>/.exec(html)?.[1] ?? "null",
    );
    if (!record(value)) throw new Error("No fake configuration");
    const page = new PeerDocument(value, url, this);
    this.windows.set(this.selected, page);
    const started = page.start();
    if (value.role === "peer" && this.holdPeerReadyAcknowledgement) {
      this.peerStarts.push(started);
      void started.catch(() => {});
      await this.peerReadyReceived.promise;
      return;
    }
    await started;
  }
  override async reloadWindow(): Promise<void> {
    this.actions.push("reload");
    if (this.fault === "reload-old") return;
    await this.navigate(this.document().url);
    if (this.fault === "reload-handle") this.selected = "root";
  }
  override async closeWindow(): Promise<void> {
    this.actions.push("close");
    if (this.fault === "close-present") return;
    const handle = this.fault === "close-wrong" ? "root" : this.selected;
    this.windows.get(handle)?.stop();
    this.windows.delete(handle);
  }
  override async script(source: string): Promise<unknown> {
    const page = this.document();
    const value: unknown = new Function("window", "location", source)(page.window, {
      href: page.url,
    });
    if (source.includes("return h.phase === 'driving' && window.__pageRunner.pending === 0;"))
      this.peerAdmissionObserved.resolve({
        phase: page.host.phase,
        pending: page.reporter.observation.pending,
      });
    return value;
  }
  override async stop() {
    this.release.resolve();
    for (const page of this.windows.values()) page?.stop();
    await Promise.all(this.peerStarts);
    return super.stop();
  }
}
