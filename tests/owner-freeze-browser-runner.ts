import { resolve } from "node:path";
import type { Browser, BrowserContext, CDPSession, Page, Worker } from "playwright";
import { BrowserRunnerLifecycle, browserBundle } from "./browser-runner-lifecycle";
import { record, text } from "../fs/publication-attachment";
import { publicationCut, type PublicationCut } from "../fs/publication";

const lifecycle = new BrowserRunnerLifecycle(150_000);
const negative = process.argv.includes("--negative-control");
const reportPath = process.env.OWNER_FREEZE_REPORT;
const evidence: Record<string, unknown> = {
  base: "e0ef92157dcc8ac658be30a372dffa0534c63fa6",
  negativeControl: negative,
  mechanism: "CDP Debugger.pause on the actual persistent authority dedicated worker",
};
const names = [
  "four independent native pages and persistent owner",
  "seed and real WASI bootstrap",
  "native worker paused, independent execution frozen",
  "pending guest append and host rename",
  "original owner resumes with one unchanged ordered history",
  "second native freeze",
  "transport deadline is not death or no-effect",
  "original owner resumes and reconciles timed-out work",
];
type Step =
  | { name: string; kind: "unrun" }
  | { name: string; kind: "completed"; value: unknown }
  | { name: string; kind: "failed"; failure: string };
const steps: Step[] = names.map((name) => ({ name, kind: "unrun" }));
function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
async function bounded<T>(promise: Promise<T>, label: string, ms = 12000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`deadline: ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function step(index: number, action: () => Promise<unknown>): Promise<void> {
  const name = names[index]!;
  try {
    const value = await bounded(action(), name);
    steps[index] = { name, kind: "completed", value: value ?? null };
    console.log(`PASS ${name}`);
  } catch (error) {
    steps[index] = { name, kind: "failed", failure: String(error) };
    throw error;
  }
}
function control(page: Page, operation: string, body?: unknown): Promise<unknown> {
  return page.evaluate(
    async ({ operation, body }) => {
      const path = "/owner-freeze.js";
      const module: typeof import("./owner-freeze-browser") = await import(path);
      return module.control(operation, body);
    },
    { operation, body },
  );
}
function host(page: Page, operation: string, args: unknown[] = [], bytes?: number[]) {
  return control(page, "host", { operation, args, bytes });
}
function owner(page: Page, operation: string, body?: unknown) {
  return control(page, "owner", { operation, body });
}
async function waitUntil(action: () => Promise<boolean>, label: string): Promise<void> {
  const end = Date.now() + 8000;
  while (!(await action())) {
    if (Date.now() > end) throw new Error(`observation deadline: ${label}`);
    await Bun.sleep(20);
  }
}

class NativePause {
  private sequence = 0;
  private pending = new Map<number, ReturnType<typeof Promise.withResolvers<unknown>>>();
  paused: unknown[] = [];
  resumed = 0;
  active = false;
  private constructor(
    private root: CDPSession,
    readonly session: string,
    readonly target: string,
  ) {
    root.on("Target.receivedMessageFromTarget", ({ sessionId, message }) => {
      if (sessionId !== this.session) return;
      const data = record(JSON.parse(message));
      if (data.method === "Debugger.paused") {
        this.active = true;
        this.paused.push(data.params);
      }
      if (data.method === "Debugger.resumed") {
        this.active = false;
        this.resumed++;
      }
      if (typeof data.id !== "number") return;
      const answer = this.pending.get(data.id);
      this.pending.delete(data.id);
      if (data.error) answer?.reject(new Error(JSON.stringify(data.error)));
      else answer?.resolve(data.result);
    });
  }
  static async attach(browser: Browser, url: string): Promise<NativePause> {
    const root = await browser.newBrowserCDPSession();
    const targets = await root.send("Target.getTargets");
    const found = targets.targetInfos.filter(
      (entry) => entry.type === "worker" && entry.url === url,
    );
    equal(found.length, 1);
    const target = found[0]!.targetId;
    const attached = await root.send("Target.attachToTarget", { targetId: target, flatten: false });
    const result = new NativePause(root, attached.sessionId, target);
    await result.send("Debugger.enable");
    return result;
  }
  async send(method: string): Promise<unknown> {
    const id = ++this.sequence,
      answer = Promise.withResolvers<unknown>();
    this.pending.set(id, answer);
    try {
      await this.root.send("Target.sendMessageToTarget", {
        sessionId: this.session,
        message: JSON.stringify({ id, method, params: {} }),
      });
      return await bounded(answer.promise, method, 5000);
    } finally {
      this.pending.delete(id);
    }
  }
  async pause(): Promise<void> {
    const before = this.paused.length;
    if (!negative) await this.send("Debugger.pause");
    if (negative) {
      await Bun.sleep(100);
      equal(this.active, true);
    }
    await waitUntil(async () => this.paused.length === before + 1, "native Debugger.paused event");
  }
  async resume(): Promise<void> {
    if (!this.active) return;
    const before = this.resumed;
    await this.send("Debugger.resume");
    await waitUntil(async () => this.resumed > before, "native Debugger.resumed event");
  }
  async close(): Promise<void> {
    await this.root.detach();
  }
}
async function frozen(a: Page, d: Page, debug: NativePause): Promise<unknown> {
  const before = await control(a, "pulse");
  const clock = await d.evaluate(() => performance.now());
  await Bun.sleep(350);
  const after = await control(a, "pulse");
  equal(debug.active, true);
  equal(after, before);
  const elapsed = (await d.evaluate(() => performance.now())) - clock;
  if (elapsed < 300) throw new Error("independent page clock did not advance");
  return { before, after, independentPageElapsed: elapsed, nativePause: debug.paused.at(-1) };
}
async function requests(page: Page): Promise<Record<string, unknown>[]> {
  const value = await control(page, "messages");
  if (!Array.isArray(value)) throw new Error("wire observations missing");
  return value
    .map(record)
    .filter((message) => message.kind === "request" && message.operation === "workspace");
}
async function begin(
  a: Page,
  b: Page,
  c: Page,
  d: Page,
  phase: "short" | "deadline",
  id?: unknown,
) {
  await control(a, "begin", { key: `${phase}-probe`, kind: "probe" });
  const before = (await requests(d)).length;
  await control(b, "begin", {
    key: `${phase}-guest`,
    kind: "guest",
    byte: phase === "short" ? 41 : 42,
  });
  await waitUntil(
    async () => (await requests(d)).length === before + 1,
    "actual guest request sent",
  );
  const request =
    phase === "short"
      ? { operation: "move", args: ["/dir/a", "/dir/target"] }
      : {
          operation: "workspaceMutation",
          args: [id, "writeFile", ["/dir/target", true]],
          bytes: [43],
        };
  await control(c, "begin", { key: `${phase}-host`, kind: "host", request });
  await waitUntil(
    async () => (await requests(d)).length === before + 2,
    "actual host request sent",
  );
  equal(record(record(await control(b, "status"))[`${phase}-guest`]).kind, "pending");
  equal(record(record(await control(c, "status"))[`${phase}-host`]).kind, "pending");
  return (await requests(d)).slice(before);
}
async function noReply(page: Page, sent: Record<string, unknown>[]): Promise<void> {
  const messages = await control(page, "messages");
  if (!Array.isArray(messages)) throw new Error("missing independent wire observer");
  const replies = messages.map(record).filter((message) => message.kind === "reply");
  equal(
    replies.filter((reply) => sent.some((request) => request.id === reply.id)),
    [],
  );
}
function shortEffects(publications: Record<string, unknown>[]): void {
  equal(publications.length, 2);
  const append = record(publications[0]),
    rename = record(publications[1]);
  if (!Array.isArray(append.changes) || !Array.isArray(rename.changes))
    throw new Error("complete publication effects missing");
  equal(
    append.changes.map((value) => record(value).kind),
    ["bytes", "metadata"],
  );
  const bytes = record(append.changes[0]);
  equal(bytes.offset, 3);
  equal(bytes.bytes, { 0: 41 });
  equal(bytes.size, 4);
  equal(record(append.changes[1]).file, bytes.file);
  equal(
    rename.changes.map((value) => record(value).kind),
    ["entry", "entry", "metadata"],
  );
  const removed = record(rename.changes[0]),
    added = record(rename.changes[1]);
  equal(removed.name, "a");
  equal(removed.before, bytes.file);
  equal(removed.after, null);
  equal(added.name, "target");
  equal(added.before, null);
  equal(added.after, bytes.file);
  equal(removed.parent, added.parent);
  equal(record(rename.changes[2]).file, added.parent);
}
async function contents(page: Page, root: unknown): Promise<number[]> {
  const entry = record(await host(page, "resolve", [root, "dir/target"]));
  const value = await host(page, "read", [entry.node, 64, 0]);
  if (!Array.isArray(value) || !value.every((byte: unknown) => typeof byte === "number"))
    throw new Error("invalid file bytes");
  return value;
}
function groups(value: unknown, before: PublicationCut): Record<string, unknown>[] {
  const changes = record(value);
  equal(changes.kind, "changes");
  if (!Array.isArray(changes.publications)) throw new Error("missing publications");
  const result = changes.publications.map(record);
  for (const [index, group] of result.entries()) {
    const receipt = record(group.receipt);
    equal(receipt.cut, { history: before.history, generation: before.generation + index + 1 });
    equal(receipt.durability, { kind: "untracked" });
  }
  equal(changes.next, { history: before.history, generation: before.generation + result.length });
  return result;
}
async function locks(page: Page, workspace: string, name: string) {
  return page.evaluate(
    async ({ workspace, name }) => {
      const observed = await navigator.locks.query();
      const relevant = (lock: LockInfo) =>
        lock.name?.includes(workspace) || lock.name?.includes(name);
      return { held: observed.held?.filter(relevant), pending: observed.pending?.filter(relevant) };
    },
    { workspace, name },
  );
}
async function auditRetirement(observer: Page, workspace: unknown, name: string): Promise<unknown> {
  const context = observer.context(),
    origin = new URL(observer.url()).origin;
  await observer.close();
  const audit = await context.newPage();
  try {
    await audit.goto(origin);
    const finalLocks = typeof workspace === "string" ? await locks(audit, workspace, name) : null;
    if (finalLocks) {
      equal(finalLocks.held, []);
      equal(finalLocks.pending, []);
    }
    await control(audit, "delete", name);
    return { locks: finalLocks, database: "deleted after all original pages and workers closed" };
  } finally {
    await audit.close();
  }
}
async function teardown(
  pages: Page[],
  debug: NativePause | undefined,
  deaths: Map<Worker, boolean>,
  name: string,
) {
  const result: Record<string, unknown> = {};
  if (pages[3]) result.wire = await control(pages[3], "messages");
  if (debug) result.resume = await debug.resume().then(() => "resumed-or-not-paused", String);
  for (const [index, page] of pages.entries()) {
    result[`page${index}`] = await bounded(control(page, "join"), "join all original operations")
      .then(
        async (joined) => ({
          joined,
          cleanup: await bounded(control(page, "cleanup"), "peer cleanup"),
        }),
        (error: unknown) => ({
          unresolved: String(error),
          retirement: "native page closure below",
        }),
      )
      .catch(String);
  }
  if (pages[0])
    result.ownerStop = await bounded(owner(pages[0], "stop"), "owner stop").then(
      (value) => ({ kind: "stopped", value }),
      (error: unknown) => ({ kind: "unresolved", failure: String(error) }),
    );
  if (debug) {
    result.debug = { target: debug.target, paused: debug.paused.length, resumed: debug.resumed };
    await debug.close();
  }
  const observer = pages.at(-1);
  for (const page of pages.slice(0, -1)) await page.close();
  if (observer) {
    await waitUntil(
      async () => Array.from(deaths.values()).every(Boolean),
      "all native worker close events",
    );
    result.nativeWorkers = Array.from(deaths, ([worker, closed]) => ({
      url: worker.url(),
      closed,
    }));
    const ready = record(evidence.ready ?? {}),
      descriptor = record(ready.descriptor ?? {});
    if (typeof descriptor.workspace === "string")
      result.locksBeforeFinalPageClose = await locks(observer, descriptor.workspace, name);
    result.finalAudit = await auditRetirement(observer, descriptor.workspace, name);
  }
  return result;
}
interface RunState {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly pages: Page[];
  readonly deaths: Map<Worker, boolean>;
  readonly name: string;
  authority?: Worker;
  debug?: NativePause;
}
function observeWorker(state: RunState, index: number, worker: Worker): void {
  state.deaths.set(worker, false);
  worker.once("close", () => state.deaths.set(worker, true));
  if (index === 0 && worker.url().endsWith("/owner-freeze-owner.js")) state.authority = worker;
}
async function openPages(state: RunState, origin: string): Promise<void> {
  for (let index = 0; index < 4; index++) {
    const page = await state.context.newPage();
    state.pages.push(page);
    page.on("worker", (worker) => observeWorker(state, index, worker));
    await page.goto(origin);
    equal(await page.opener(), null);
    equal(await page.evaluate(() => crossOriginIsolated), true);
  }
}
async function exercise(state: RunState): Promise<void> {
  const { pages, name } = state;
  const a = pages[0]!,
    b = pages[1]!,
    c = pages[2]!,
    d = pages[3]!;
  let root: unknown,
    ready: Record<string, unknown> = {},
    before: PublicationCut;
  await step(0, async () => {
    ready = record(await control(a, "start", name));
    evidence.ready = ready;
    for (const page of pages) await control(page, "peer", ready.descriptor);
    root = await host(d, "preopen", ["/"]);
    await control(d, "wire", ready.descriptor);
    if (!state.authority) throw new Error("native actual owner worker missing");
    state.debug = await NativePause.attach(state.browser, state.authority.url());
    return { pages: 4, identity: ready.identity, target: state.debug.target };
  });
  await step(1, async () => {
    await host(a, "mkdirp", ["/dir"]);
    await host(a, "writeFile", ["/dir/a"], [10, 20, 30]);
    await control(b, "guest");
    before = publicationCut(await owner(a, "cut"));
    return before;
  });
  await step(2, async () => {
    await state.debug!.pause();
    return frozen(a, d, state.debug!);
  });
  await step(3, async () => {
    const sent = await begin(a, b, c, d, "short");
    const observation = await frozen(a, d, state.debug!);
    const candidate = await control(d, "candidate", name);
    equal(record(candidate).kind, "rejected");
    await noReply(d, sent);
    equal(record(record(await control(b, "status"))["short-guest"]).kind, "pending");
    equal(record(record(await control(c, "status"))["short-host"]).kind, "pending");
    equal(record(record(await control(a, "status"))["short-probe"]).kind, "pending");
    return {
      sent,
      state: observation,
      candidate,
      locks: await locks(d, text(record(ready.descriptor).workspace), name),
    };
  });
  await step(4, async () => {
    await state.debug!.resume();
    const joined = await Promise.all([a, b, c].map((page) => control(page, "join")));
    equal(record(record(joined[1])["short-guest"]).value, { result: 0, count: 1 });
    equal(record(record(joined[2])["short-host"]).kind, "fulfilled");
    equal(await contents(d, root), [10, 20, 30, 41]);
    equal(record(await host(d, "resolve", [root, "dir/a"])).node, undefined);
    const changes = await owner(a, "changes", before!);
    const publications = groups(changes, before!);
    shortEffects(publications);
    if (!state.authority || state.deaths.get(state.authority))
      throw new Error("owner died instead of resumed");
    const pulse = await control(a, "pulse");
    await waitUntil(
      async () => (await control(a, "pulse")) !== pulse,
      "original execution counter resumed",
    );
    return {
      joined,
      changes,
      identity: ready.identity,
      pulse,
      resumedPulse: await control(a, "pulse"),
    };
  });
  const id = await host(c, "workspaceNext");
  before = publicationCut(await owner(a, "cut"));
  await step(5, async () => {
    await state.debug!.pause();
    return frozen(a, d, state.debug!);
  });
  await step(6, async () => {
    const sent = await begin(a, b, c, d, "deadline", id);
    await waitUntil(
      async () => record(record(await control(c, "status"))["deadline-host"]).kind !== "pending",
      "bounded host observation",
    );
    const guest = record(await control(b, "join")),
      hostResult = record(await control(c, "join"));
    const rejected = record(hostResult["deadline-host"]);
    equal(rejected.kind, "rejected");
    equal(rejected.errno, 6);
    equal(record(guest["deadline-guest"]).value, { result: 6, count: 0xdeadbeef });
    equal(record(record(await control(a, "status"))["deadline-probe"]).kind, "pending");
    const observation = await frozen(a, d, state.debug!);
    const candidate = await control(d, "candidate", name);
    equal(record(candidate).kind, "rejected");
    await noReply(d, sent);
    if (typeof rejected.elapsed !== "number" || rejected.elapsed < 2900 || rejected.elapsed > 4500)
      throw new Error("host timeout outside bounded observation window");
    if (!state.authority || state.deaths.get(state.authority))
      throw new Error("timeout mistaken for owner death");
    return {
      sent,
      guest,
      host: hostResult,
      state: observation,
      candidate,
      outcomeAtDeadline: "unknown, not a no-effect receipt",
      id,
    };
  });
  await step(7, async () => {
    await state.debug!.resume();
    await control(a, "join");
    const changes = await owner(a, "changes", before!);
    const publications = groups(changes, before!);
    const bytes = await contents(d, root);
    const receipt = await host(c, "workspaceReceipt", [id]);
    evidence.deadlineReconciliation = { changes, bytes, receipt };
    equal(bytes, [10, 20, 30, 41]);
    equal(publications.length, 0);
    equal(receipt, { kind: "retired" });
    if (!state.authority || state.deaths.get(state.authority))
      throw new Error("owner did not resume");
    await host(d, "flush");
    return evidence.deadlineReconciliation;
  });
}
async function scenario(browser: Browser, origin: string): Promise<void> {
  const context = await browser.newContext();
  const state: RunState = {
    browser,
    context,
    pages: [],
    deaths: new Map(),
    name: `owner-freeze-${crypto.randomUUID()}`,
  };
  evidence.database = state.name;
  try {
    await openPages(state, origin);
    await exercise(state);
  } finally {
    try {
      evidence.teardown = await teardown(state.pages, state.debug, state.deaths, state.name);
    } finally {
      await context.close();
    }
  }
}
try {
  await lifecycle.init();
  evidence.scratch = lifecycle.scratch;
  const port = Number(process.env.OWNER_FREEZE_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("set explicit free OWNER_FREEZE_PORT");
  const origin = lifecycle.serve(
    {
      "/": "<!doctype html><title>Native owner freeze proof</title>",
      "/owner-freeze.js": await browserBundle(resolve(import.meta.dir, "owner-freeze-browser.ts")),
      "/owner-freeze-owner.js": await browserBundle(
        resolve(import.meta.dir, "fixtures/owner-freeze-owner.ts"),
      ),
      "/owner-freeze-guest.js": await browserBundle(
        resolve(import.meta.dir, "fixtures/owner-freeze-guest.ts"),
      ),
    },
    port,
  );
  evidence.origin = origin;
  const browser = await lifecycle.launch("chromium");
  evidence.browser = browser.version();
  await scenario(browser, origin);
} finally {
  try {
    await lifecycle.close();
    evidence.outerCleanup = "browser, server, profile and scratch retired";
  } finally {
    const report = { ...evidence, steps };
    console.log(JSON.stringify(report));
    if (reportPath) await Bun.write(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
}
