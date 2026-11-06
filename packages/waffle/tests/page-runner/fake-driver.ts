import type { StorageEntry } from "../storage-allocation.js";
import type { Driver, DriverCleanup } from "./driver.js";
import { record, type Body } from "./protocol.js";
import { listIds } from "./storage-policy.js";
import { storageTests, opfsStorageTests } from "../storage-browser.js";
import type { Observation } from "./reporter.js";
export type FakeMode =
  | "pass"
  | "unretired"
  | "assertion"
  | "finish-error"
  | "final-ack-loss"
  | "reload"
  | "close"
  | "driver-lost"
  | "hang-delete"
  | "cleanup-fails";
export type FakeCommand = {
  list: unknown;
  result?: unknown;
  allocation?: StorageEntry;
};
/** Deterministic host/lifecycle control. Never used to claim browser suite coverage. */
export class FakeDriver implements Driver {
  uncertain = false;
  stopCalls = 0;
  navigations = 0;
  origin = "";
  currentURL = "";
  currentDoc = "";
  closed = false;
  private observation: Observation = {
    doc: "",
    ackedThrough: -1,
    failure: null,
    pending: 0,
    retired: false,
  };
  private retirement: ReturnType<typeof setInterval> | undefined;
  private retirementBusy = false;
  private configuration: Record<string, unknown> = {};
  constructor(
    readonly mode: FakeMode,
    readonly command?: FakeCommand,
  ) {}
  async start(): Promise<void> {}
  async navigate(url: string): Promise<void> {
    clearInterval(this.retirement);
    this.navigations++;
    this.currentURL = url;
    this.origin = new URL(url).origin;
    const html = await (await fetch(url)).text();
    const encoded = /window\.__suiteConfiguration=(.+?)<\/script>/.exec(html)?.[1];
    const config: unknown = JSON.parse(encoded ?? "null");
    if (!record(config)) throw new Error("Missing fake page configuration");
    this.configuration = config;
    this.currentDoc = crypto.randomUUID();
    this.observation = {
      doc: this.currentDoc,
      ackedThrough: -1,
      failure: null,
      pending: 0,
      retired: false,
    };
    await this.send({ kind: "hello", token: String(config.token), group: String(config.group) });
    await this.run(config.role, config.request);
  }
  private async run(role: unknown, request: unknown): Promise<void> {
    if (role === "finish") {
      if (this.mode === "finish-error")
        await this.send({ kind: "error", message: "finish failed without active case" });
      await this.send({ kind: "run-complete", remaining: [] });
      if (this.mode === "final-ack-loss") {
        this.observation.failure = "Final acknowledgement lost";
        return;
      }
    } else if (role === "list") {
      const cases = {
        indexeddb: storageTests("/fs-worker.js", "/open-fs-worker.js").map((item) => item.label),
        opfs: opfsStorageTests("/fs-worker.js").map((item) => item.label),
      };
      if (!this.command) listIds(cases);
      await this.send({ kind: "list", cases: this.command ? this.command.list : cases });
    } else if (record(request)) await this.case(request);
    await this.send({ kind: "doc-complete" });
    this.retirement = setInterval(() => {
      void this.pollRetirement();
    }, 1);
  }
  private async pollRetirement(): Promise<void> {
    if (this.retirementBusy || (this.mode === "unretired" && this.configuration.role === "case"))
      return;
    this.retirementBusy = true;
    try {
      const url = `${this.origin}/retire?run=${String(this.configuration.run)}&doc=${this.observation.doc}`;
      const response = await fetch(url);
      if ((await response.json()) !== true) return;
      clearInterval(this.retirement);
      await this.send({ kind: "retire-ready" });
    } catch {
    } finally {
      this.retirementBusy = false;
    }
  }
  private async case(_request: Record<string, unknown>): Promise<void> {
    const caseId = String(this.configuration.caseId);
    await this.send({ kind: "case-start", caseId });
    if (this.command?.allocation)
      await this.send({ kind: "allocation", entry: this.command.allocation });
    const result = this.command && "result" in this.command ? { result: this.command.result } : {};
    await this.send(
      this.mode === "assertion"
        ? { kind: "case-end", caseId, status: "fail", error: "Original assertion" }
        : { kind: "case-end", caseId, status: "pass", ...result },
    );
    if (this.mode === "reload") this.currentDoc = "replacement-document";
    if (this.mode === "close") this.closed = true;
    if (this.mode === "driver-lost") this.uncertain = true;
  }
  private async send(body: Body): Promise<void> {
    const response = await fetch(`${this.origin}/report`, {
      method: "POST",
      body: JSON.stringify({
        run: this.configuration.run,
        doc: this.observation.doc,
        seq: this.observation.ackedThrough + 1,
        ...body,
      }),
    });
    if (!response.ok) throw new Error(`Fake reporter rejected ${response.status}`);
    this.observation.ackedThrough++;
  }
  async handle(): Promise<string> {
    if (this.uncertain) throw new Error("driver-lost");
    return "root";
  }
  async handles(): Promise<string[]> {
    if (this.uncertain) throw new Error("driver-lost");
    return this.closed ? [] : ["root"];
  }
  async url(): Promise<string> {
    return this.currentURL;
  }
  async script(source: string): Promise<unknown> {
    if (this.uncertain) throw new Error("driver-lost");
    // The fixture's fake document can be changed independently of report identity.
    if (source === "return window.__pageRunner || null")
      return { ...this.observation, doc: this.currentDoc };
    return new Function("window", source)({ __pageRunner: this.observation });
  }
  stop(): Promise<DriverCleanup> {
    this.stopCalls++;
    clearInterval(this.retirement);
    if (this.mode === "hang-delete") return new Promise(() => {});
    return Promise.resolve({
      session: {
        status: this.mode === "cleanup-fails" ? "unconfirmed" : "confirmed",
        detail: "Fake exact session deletion",
      },
      launcher: { status: "confirmed", detail: "Direct launcher exited" },
      serviceDisposition:
        "Pre-existing launchd HTTPService remains live, never signalled or claimed cleaned",
    });
  }
}
