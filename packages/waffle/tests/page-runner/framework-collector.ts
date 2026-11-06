import { randomUUID } from "node:crypto";
import { ObservationClosed } from "./collector.js";
import { record, resultByteLimit } from "./protocol.js";
import { reportSequence } from "./report-stream.js";
import { jsonValue } from "./framework-validation.js";
import type {
  ExpectedCase,
  FrameworkEvent,
  FrameworkResult,
  FrameworkTask,
  FrameworkUpdate,
} from "./framework-types.js";

export type DocumentKind = "orchestrator" | "tester";
export type FrameworkDocument = {
  kind: DocumentKind;
  token: string;
  url: string;
  doc: string | null;
  messages: string[];
  heartbeatAt: number;
  admitted: boolean;
  retiring: boolean;
  ready: boolean;
  cutoff: number | null;
  ackedThrough: number | null;
  pending: number | null;
};
function task(value: unknown): value is FrameworkTask {
  return (
    record(value) &&
    typeof value.id === "string" &&
    !!value.id &&
    (value.parentId === null || typeof value.parentId === "string") &&
    ["test", "suite", "file"].includes(String(value.type)) &&
    typeof value.file === "string" &&
    typeof value.fullName === "string" &&
    typeof value.mode === "string" &&
    typeof value.timeoutMs === "number" &&
    Number.isFinite(value.timeoutMs) &&
    typeof value.retries === "number" &&
    Number.isSafeInteger(value.retries)
  );
}
function update(value: unknown): value is FrameworkUpdate {
  return (
    record(value) &&
    typeof value.id === "string" &&
    ["run", "pass", "fail", "skip", "todo"].includes(String(value.state)) &&
    Array.isArray(value.errors) &&
    value.errors.every(jsonValue) &&
    jsonValue(value.hooks) &&
    typeof value.retryCount === "number" &&
    Number.isSafeInteger(value.retryCount)
  );
}
function frameworkEvent(value: unknown): value is FrameworkEvent {
  if (!record(value)) return false;
  if (value.kind === "collected") return Array.isArray(value.tasks) && value.tasks.every(task);
  if (value.kind === "task-started") return typeof value.id === "string";
  if (value.kind === "task-update" || value.kind === "case-settled")
    return Array.isArray(value.updates) && value.updates.every(update);
  if (value.kind === "error") return jsonValue(value.error) && typeof value.source === "string";
  return ["execution-flushed", "tester-cleanup-settled", "cleanup-response-received"].includes(
    String(value.kind),
  );
}
export class FrameworkCollector {
  readonly run = randomUUID();
  readonly documents: FrameworkDocument[] = [];
  readonly failures: FrameworkResult["failures"] = [];
  readonly events: FrameworkEvent[] = [];
  readonly cases: FrameworkResult["cases"];
  collection: readonly FrameworkTask[] = [];
  private readonly startedTasks = new Set<string>();
  executionFlushed = false;
  cleanupSettled = false;
  cleanupResponse = false;
  viewportConsumed = false;
  constructor(readonly expected: readonly ExpectedCase[]) {
    this.cases = expected.map((item) => ({
      expected: item,
      actualId: null,
      started: false,
      outcome: null,
    }));
  }
  fail(category: string, detail: string): void {
    this.failures.push({ category, detail });
  }
  expect(kind: DocumentKind, url: string): FrameworkDocument {
    if (this.documents.some((document) => document.kind === kind))
      throw new Error(`Duplicate ${kind} document emission`);
    const document: FrameworkDocument = {
      kind,
      token: randomUUID(),
      url,
      doc: null,
      messages: [],
      heartbeatAt: performance.now(),
      admitted: false,
      retiring: false,
      ready: false,
      cutoff: null,
      ackedThrough: null,
      pending: null,
    };
    this.documents.push(document);
    return document;
  }
  document(kind: DocumentKind): FrameworkDocument | undefined {
    return this.documents.find((document) => document.kind === kind);
  }
  private bound(value: unknown): { document: FrameworkDocument; body: Record<string, unknown> } {
    if (!record(value) || value.run !== this.run || typeof value.doc !== "string")
      throw new Error("Unbound framework report");
    const document = this.documents.find(
      (item) => item.doc === value.doc || (item.doc === null && item.token === value.token),
    );
    if (!document || value.token !== document.token)
      throw new Error("Wrong framework document token");
    if (document.cutoff !== null) throw new ObservationClosed("Framework document retired");
    return { document, body: value };
  }
  receive(value: unknown): { ackedThrough: number } {
    const { document, body } = this.bound(value);
    const encoded = JSON.stringify(value);
    if (new TextEncoder().encode(encoded).byteLength > resultByteLimit)
      throw new Error("Framework report exceeds 48 KiB");
    if (typeof body.seq !== "number") throw new Error("Missing report sequence");
    if (reportSequence(document, body.seq, encoded) === "retry") return { ackedThrough: body.seq };
    this.apply(document, body);
    document.messages.push(encoded);
    return { ackedThrough: body.seq };
  }
  private apply(document: FrameworkDocument, body: Record<string, unknown>): void {
    if (body.kind === "hello") {
      if (
        document.doc !== null ||
        body.role !== document.kind ||
        body.url !== document.url ||
        typeof body.doc !== "string"
      )
        throw new Error("Unexpected framework hello");
      document.doc = body.doc;
      document.heartbeatAt = performance.now();
      return;
    }
    if (!document.doc) throw new Error("Framework report before hello");
    if (body.kind === "retire-ready") {
      if (!document.retiring || document.ready) throw new Error("Unexpected retirement readiness");
      document.ready = true;
      return;
    }
    if (!frameworkEvent(body.event) || body.kind !== "event")
      throw new Error("Malformed framework observation");
    if (!document.admitted && body.event.kind !== "error")
      throw new Error("Framework event before paired admission");
    if (
      body.event.kind !== "error" &&
      document.kind !==
        (body.event.kind === "cleanup-response-received" ? "orchestrator" : "tester")
    )
      throw new Error("Framework event from wrong document");
    this.event(body.event);
  }
  private event(event: FrameworkEvent): void {
    if (event.kind === "collected") this.collect(event.tasks);
    if (event.kind === "task-started") {
      if (!this.collection.some((task) => task.id === event.id) || this.startedTasks.has(event.id))
        throw new Error("Unknown or repeated actual task start");
      this.startedTasks.add(event.id);
      const item = this.cases.find((item) => item.actualId === event.id);
      if (item) item.started = true;
    }
    if (event.kind === "task-update" || event.kind === "case-settled") this.updates(event);
    if (event.kind === "error") this.fail("page-error", JSON.stringify(event));
    if (event.kind === "execution-flushed") {
      if (!this.collection.length || this.executionFlushed)
        throw new Error("Unexpected execution flush");
      this.executionFlushed = true;
    }
    if (event.kind === "tester-cleanup-settled") {
      if (!this.executionFlushed || this.cleanupSettled)
        throw new Error("Tester cleanup before execution flush");
      this.cleanupSettled = true;
    }
    if (event.kind === "cleanup-response-received") {
      if (this.cleanupResponse) throw new Error("Repeated matched cleanup response");
      this.cleanupResponse = true;
    }
    this.events.push(event);
  }
  private collect(tasks: readonly FrameworkTask[]): void {
    if (this.collection.length || !this.viewportConsumed)
      throw new Error("Collection without automatic viewport admission, or repeated inventory");
    const ids = new Set(tasks.map((item) => item.id));
    if (ids.size !== tasks.length) throw new Error("Duplicate actual task ID");
    const tests = tasks.filter((item) => item.type === "test");
    if (tests.length !== this.expected.length)
      throw new Error("Independent inventory count mismatch");
    const matches = this.expected.map((expected) =>
      tests.filter(
        (actual) => actual.file === expected.file && actual.fullName === expected.fullName,
      ),
    );
    if (matches.some((items) => items.length !== 1))
      throw new Error("Independent inventory identity mismatch");
    if (tests.some((item) => item.mode !== "run" || item.timeoutMs !== 15000 || item.retries !== 0))
      throw new Error("Original case options changed");
    if (tasks.some((item) => item.parentId !== null && !ids.has(item.parentId)))
      throw new Error("Unknown actual task parent");
    this.collection = tasks;
    for (const item of this.cases)
      item.actualId =
        tests.find(
          (actual) =>
            actual.file === item.expected.file && actual.fullName === item.expected.fullName,
        )?.id ?? null;
  }
  private updates(event: Extract<FrameworkEvent, { kind: "task-update" | "case-settled" }>): void {
    for (const value of event.updates) {
      if (!this.collection.some((item) => item.id === value.id))
        throw new Error("Update for unknown actual task");
      if (event.kind !== "case-settled") continue;
      const item = this.cases.find((item) => item.actualId === value.id);
      if (!item || item.outcome !== null || value.state === "run")
        throw new Error("Invalid provisional case settlement");
      item.outcome = value;
    }
  }
  heartbeat(value: unknown): void {
    if (!record(value) || value.run !== this.run || value.kind !== "heartbeat")
      throw new Error("Unbound heartbeat");
    const document = this.documents.find((item) => item.doc !== null && item.doc === value.doc);
    if (!document) throw new Error("Unknown heartbeat document");
    if (document.cutoff === null) document.heartbeatAt = performance.now();
  }
  retirement(url: URL): boolean {
    const document = this.documents.find((item) => item.doc === url.searchParams.get("doc"));
    if (url.searchParams.get("run") !== this.run || !document || document.cutoff !== null)
      throw new Error("Unbound retirement poll");
    return document.retiring;
  }
}
