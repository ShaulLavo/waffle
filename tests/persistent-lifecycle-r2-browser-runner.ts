import { resolve } from "node:path";
import type { BrowserContext, Page, Worker } from "playwright";
import { BrowserRunnerLifecycle, browserBundle } from "./browser-runner-lifecycle";
import type * as PageModule from "./persistent-lifecycle-r2-page";
import type {} from "./fixtures/persistent-lifecycle-r2-owner";

type Step =
  | { name: string; kind: "unrun" }
  | { name: string; kind: "completed"; value: unknown }
  | { name: string; kind: "failed"; failure: string };
export async function runStep(
  steps: Step[],
  index: number,
  action: () => Promise<unknown>,
): Promise<void> {
  const current = steps[index];
  if (!current || current.kind !== "unrun") throw new Error(`invalid lifecycle step ${index}`);
  const timer = Promise.withResolvers<never>();
  const timeout = setTimeout(() => timer.reject(new Error(`step deadline ${current.name}`)), 12000);
  try {
    const value = await Promise.race([action(), timer.promise]);
    steps[index] = { name: current.name, kind: "completed", value: value ?? null };
    console.log(`PASS ${current.name}`);
  } catch (error) {
    steps[index] = { name: current.name, kind: "failed", failure: String(error) };
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`expected lifecycle record, got ${JSON.stringify(value)}`);
  return Object.fromEntries(Object.entries(value));
}
async function call(page: Page, operation: string, body?: unknown): Promise<unknown> {
  return page.evaluate(
    async ({ operation, body }) => {
      const path = "/persistent-lifecycle-r2-page.js";
      const module: typeof PageModule = await import(path);
      return module.control(operation, body);
    },
    { operation, body },
  );
}
function owner(page: Page, operation: string, body?: unknown): Promise<unknown> {
  return call(page, "owner", { operation, body });
}
function host(
  page: Page,
  operation: string,
  args: unknown[] = [],
  bytes?: number[],
): Promise<unknown> {
  return call(page, "host", { operation, args, bytes });
}
async function until(check: () => Promise<boolean>, name: string): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`missing lifecycle observation ${name}`);
    await Bun.sleep(10);
  }
}
async function status(page: Page, key: string): Promise<Record<string, unknown>> {
  return object(object(await call(page, "status"))[key]);
}
const roots = new WeakMap<Page, unknown>();
async function read(page: Page, expected: number[]): Promise<number> {
  if (!roots.has(page)) roots.set(page, await host(page, "preopen", ["/"]));
  const root = roots.get(page);
  const file = object(await host(page, "resolve", [root, "saved"]));
  equal(await host(page, "read", [file.node, 64, 0]), expected);
  equal(object(await host(page, "stat", [file.node])).size, expected.length);
  if (typeof file.node !== "number") throw new Error("missing file handle");
  return file.node;
}
async function locks(
  page: Page,
  workspace: string,
  name: string,
): Promise<Record<string, unknown>> {
  const result = object(await call(page, "locks"));
  if (!Array.isArray(result.held) || !Array.isArray(result.pending))
    throw new Error("native lock inspection unavailable");
  const held = result.held.map(object),
    pending = result.pending.map(object);
  return {
    storage: held.filter((lock) => lock.name === `bun-wasm:filesystem:indexeddb:${name}`).length,
    bootstrap: held.filter(
      (lock) => lock.name === `waffle:publication:continuity:bootstrap:${workspace}`,
    ).length,
    continuity: held.filter((lock) => lock.name === `waffle:publication:continuity:${workspace}`)
      .length,
    pending: pending.filter((lock) => String(lock.name).includes(name)).length,
  };
}
async function refused(page: Page, name: string): Promise<unknown> {
  try {
    const result = await call(page, "refusedStart", { name });
    equal(result, { kind: "rejected", errno: 6 });
    return result;
  } finally {
    await call(page, "terminate");
  }
}
interface State {
  context: BrowserContext;
  pages: Page[];
  workers: Map<Worker, boolean>;
  authority?: Worker;
  name: string;
  workspace: string;
  original?: Record<string, unknown>;
  tail?: Record<string, unknown>;
  oldCut?: unknown;
}
async function open(state: State, origin: string): Promise<void> {
  const page = await state.context.newPage();
  state.pages.push(page);
  page.on("worker", (worker) => {
    state.workers.set(worker, false);
    worker.once("close", () => state.workers.set(worker, true));
    if (state.pages[0] === page) state.authority = worker;
  });
  await page.goto(origin);
  equal(await page.opener(), null);
  equal(await page.evaluate(() => crossOriginIsolated), true);
}
async function nativeSaved(page: Page, name: string, bytes: number[]): Promise<unknown> {
  const saved = object(await call(page, "nativeRecords", name));
  const index = object(saved.index);
  if (!Array.isArray(index.nodes) || !Array.isArray(saved.payloads))
    throw new Error("native saved records missing");
  const file = index.nodes.map(object).find((node) => node.kind === "file");
  if (!file) throw new Error("saved file missing");
  const payload = saved.payloads.map(object).find((payload) => payload.key === file.data);
  equal(payload?.bytes, bytes);
  equal(file.size, bytes.length);
  equal(saved.active, index.generation);
  return saved;
}
async function lifecycle(state: State, steps: Step[], negative: boolean): Promise<void> {
  const [a, initialB, initialC, d] = state.pages;
  if (!a || !initialB || !initialC || !d) throw new Error("four independent pages required");
  let b: Page = initialB,
    c: Page = initialC;
  let ready: Record<string, unknown> = {},
    handle = 0,
    queuedHandle = 0;
  await runStep(steps, 1, async () => {
    ready = object(await call(a, "start", { name: state.name }));
    state.original = ready;
    state.workspace = String(object(ready.descriptor).workspace);
    await call(d, "wire", ready.descriptor);
    for (const page of [b, c]) await call(page, "attach", ready.descriptor);
    await host(b, "writeFile", ["/saved"], [10, 20, 30]);
    await host(b, "flush");
    handle = await read(c, [10, 20, 30]);
    return nativeSaved(d, state.name, [10, 20, 30]);
  });
  await runStep(steps, 2, async () => {
    await call(b, "stopPeer");
    equal(await locks(d, state.workspace, state.name), {
      storage: 1,
      bootstrap: 1,
      continuity: 2,
      pending: 0,
    });
    await call(c, "stopPeer");
    await b.close();
    await c.close();
    if (negative) await owner(a, "stop");
    equal(await locks(d, state.workspace, state.name), {
      storage: 1,
      bootstrap: 1,
      continuity: 1,
      pending: 0,
    });
    equal(state.workers.get(state.authority!), false);
    await owner(a, "probe");
    return { lastBorrowerClosed: true, replacement: await refused(d, state.name) };
  });
  await runStep(steps, 3, async () => {
    for (let index = 0; index < 2; index++) await open(state, new URL(a.url()).origin);
    b = state.pages[state.pages.length - 2]!;
    c = state.pages[state.pages.length - 1]!;
    for (const page of [b, c]) await call(page, "attach", ready.descriptor);
    handle = await read(b, [10, 20, 30]);
    await read(c, [10, 20, 30]);
    state.oldCut = await owner(a, "cut");
    return { identity: ready.identity, cut: state.oldCut };
  });
  await runStep(steps, 4, async () => {
    await owner(a, "holdReply");
    await call(b, "begin", { key: "late-prepare", kind: "prepare", handle });
    await until(
      async () =>
        object(await owner(a, "probe")).events instanceof Array &&
        JSON.stringify(await owner(a, "probe")).includes("grant-reply-held"),
      "native grant reply held",
    );
    await call(b, "begin", { key: "late-stop", kind: "stopPeer" });
    await until(
      async () => (await status(b, "late-prepare")).kind !== "pending",
      "original prepare deadline",
    );
    equal((await status(b, "late-prepare")).errno, 6);
    equal((await status(b, "late-stop")).kind, "pending");
    equal(await locks(d, state.workspace, state.name), {
      storage: 1,
      bootstrap: 1,
      continuity: 3,
      pending: 0,
    });
    return {
      prepare: await status(b, "late-prepare"),
      stop: await status(b, "late-stop"),
      replacement: await refused(d, state.name),
    };
  });
  await runStep(steps, 5, async () => {
    await owner(a, "releaseReply");
    equal(object(await call(b, "join", "late-stop")).kind, "fulfilled");
    equal(await locks(d, state.workspace, state.name), {
      storage: 1,
      bootstrap: 1,
      continuity: 2,
      pending: 0,
    });
    equal(await owner(a, "cut"), state.oldCut);
    await read(c, [10, 20, 30]);
    await call(b, "attach", ready.descriptor);
    roots.delete(b);
    handle = await read(b, [10, 20, 30]);
    const lateGrantUnavailable = await call(b, "tryAppend", handle);
    equal(lateGrantUnavailable, -6);
    return { lateGrantUnavailable, cut: await owner(a, "cut") };
  });
  await runStep(steps, 6, async () => {
    await owner(a, "holdCheckpoint");
    state.tail = object(await call(b, "acknowledgedTail"));
    equal(state.tail.ack, { written: 1, offset: 4 });
    const receipt = object(await owner(a, "receipt", state.tail.id));
    equal(receipt.kind, "committed");
    equal(object(receipt.receipt).durability, { kind: "untracked" });
    queuedHandle = await read(c, [10, 20, 30, 90]);
    await call(b, "begin", {
      kind: "host",
      key: "held-flush",
      body: { operation: "flush", args: [] },
    });
    await until(
      async () => object(await owner(a, "probe")).checkpointEntered === true,
      "checkpoint before native persist",
    );
    return {
      tail: state.tail,
      receipt,
      saved: await nativeSaved(d, state.name, [10, 20, 30]),
      probe: await owner(a, "probe"),
    };
  });
  await runStep(steps, 7, async () => {
    const before = await call(d, "messages");
    if (!Array.isArray(before)) throw new Error("wire observer absent");
    const sent = before.filter((message) => object(message).operation === "prepare").length;
    await call(c, "begin", { kind: "prepare", key: "queued-prepare", handle: queuedHandle });
    await until(async () => {
      const messages = await call(d, "messages");
      return (
        Array.isArray(messages) &&
        messages.filter((message) => object(message).operation === "prepare").length === sent + 1
      );
    }, "queued prepare request sent");
    await call(c, "begin", { kind: "stopPeer", key: "queued-stop" });
    await call(a, "begin", { kind: "ownerStop", key: "held-owner-stop" });
    await until(
      async () =>
        (await status(a, "held-owner-stop")).kind !== "pending" ||
        (await status(b, "held-flush")).kind !== "pending",
      "stop cancels admitted caller or refuses live sessions",
    );
    equal((await status(c, "queued-stop")).kind, "pending");
    const probe = object(await owner(a, "probe"));
    equal(probe.checkpointEntered, true);
    if (JSON.stringify(probe).includes("native-database-close-called"))
      throw new Error("owner closed native storage with held work");
    equal(await locks(d, state.workspace, state.name), {
      storage: 1,
      bootstrap: 1,
      continuity: 3,
      pending: 0,
    });
    return {
      ownerStop: await status(a, "held-owner-stop"),
      flush: await status(b, "held-flush"),
      borrowerStop: await status(c, "queued-stop"),
      probe,
    };
  });
  await runStep(steps, 8, async () => {
    const original = state.authority;
    if (!original) throw new Error("native authority worker absent");
    await call(a, "terminate");
    await until(async () => state.workers.get(original) === true, "native worker close event");
    await until(
      async () => (await locks(d, state.workspace, state.name)).storage === 0,
      "native owner locks gone",
    );
    equal(await locks(d, state.workspace, state.name), {
      storage: 0,
      bootstrap: 0,
      continuity: 2,
      pending: 0,
    });
    return {
      death: "Worker.terminate plus native close event",
      replacement: await refused(d, state.name),
      locks: await locks(d, state.workspace, state.name),
    };
  });
  await runStep(steps, 9, async () => {
    await b.close();
    await c.close();
    await until(
      async () => (await locks(d, state.workspace, state.name)).continuity === 0,
      "borrower realms gone",
    );
    equal(await locks(d, state.workspace, state.name), {
      storage: 0,
      bootstrap: 0,
      continuity: 0,
      pending: 0,
    });
    return {
      borrowers: "native page close, not successful protocol cleanup",
      locks: await locks(d, state.workspace, state.name),
    };
  });
  await runStep(steps, 10, async () => {
    const reopened = object(await call(a, "start", { name: state.name, original: ready.identity }));
    const identity = object(reopened.identity),
      previous = object(ready.identity);
    if (identity.instance === previous.instance || identity.history === previous.history)
      throw new Error("old authority identity restored");
    equal(reopened.notice, {
      kind: "v1-new-history",
      durablePublicationCut: "untracked",
      oldCapabilities: "not-restored",
      oldMutationOutcomes: "not-restored",
      acknowledgedTail: "may-be-lost",
    });
    equal(object(await owner(a, "changes", state.oldCut)).kind, "gap");
    equal(await owner(a, "receipt", state.tail!.id), { kind: "unknown" });
    equal(await call(d, "staleDescriptor", ready.descriptor), { kind: "rejected", errno: 11 });
    equal(
      await call(d, "staleOutcome", {
        descriptor: reopened.descriptor,
        token: state.tail!.token,
        outcome: state.tail!.outcome,
      }),
      [
        { kind: "rejected", errno: 11 },
        { kind: "rejected", errno: 11 },
      ],
    );
    await call(d, "attach", reopened.descriptor);
    await read(d, [10, 20, 30]);
    return {
      notice: reopened.notice,
      oldReceipt: await owner(a, "receipt", state.tail!.id),
      identity,
    };
  });
  await runStep(steps, 11, async () => {
    await host(d, "writeFile", ["/saved", true], [44]);
    await read(d, [10, 20, 30, 44]);
    await host(d, "flush");
    const saved = await nativeSaved(d, state.name, [10, 20, 30, 44]);
    await call(d, "stopPeer");
    equal(await owner(a, "stop"), { memoized: true, stopped: true });
    await call(a, "terminate");
    await until(
      async () => Array.from(state.workers.values()).every(Boolean),
      "all native workers closed",
    );
    equal(await locks(d, state.workspace, state.name), {
      storage: 0,
      bootstrap: 0,
      continuity: 0,
      pending: 0,
    });
    return { saved, deleted: await call(d, "delete", state.name) };
  });
}
async function run(): Promise<void> {
  const runner = new BrowserRunnerLifecycle(165000);
  const schedule = [
    "isolated native pages",
    "native owner and saved baseline",
    "last borrower close retains explicit owner",
    "reconnect original history",
    "late grant timeout retains cleanup guard",
    "late reply cancels grant and joins original cleanup",
    "volatile ACK and held native checkpoint",
    "owner stop retains held work and guards",
    "definitive worker death retains borrower guards",
    "actual borrower realm death retires remaining guards",
    "explicit saved-state reopen rejects old capabilities and outcomes",
    "new reads writes flush and native cleanup",
  ];
  const steps: Step[] = schedule.map((name) => ({ name, kind: "unrun" }));
  const evidence: Record<string, unknown> = {
    base: "9d09f636",
    negativeControl: process.argv.includes("--negative-control"),
  };
  let state: State | undefined;
  try {
    await runner.init();
    evidence.scratch = runner.scratch;
    const port = Number(process.env.PERSISTENT_LIFECYCLE_PORT);
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error("set explicit free PERSISTENT_LIFECYCLE_PORT");
    const origin = runner.serve(
      {
        "/": "<!doctype html><title>Persistent lifecycle</title>",
        "/persistent-lifecycle-r2-page.js": await browserBundle(
          resolve(import.meta.dir, "persistent-lifecycle-r2-page.ts"),
        ),
        "/persistent-lifecycle-r2-owner.js": await browserBundle(
          resolve(import.meta.dir, "fixtures/persistent-lifecycle-r2-owner.ts"),
        ),
      },
      port,
    );
    evidence.origin = origin;
    const browser = await runner.launch("chromium");
    evidence.browser = browser.version();
    state = {
      context: await browser.newContext(),
      pages: [],
      workers: new Map(),
      name: `persistent-lifecycle-${crypto.randomUUID()}`,
      workspace: "",
    };
    evidence.database = state.name;
    const active = state;
    await runStep(steps, 0, async () => {
      for (let index = 0; index < 4; index++) await open(active, origin);
      return { independentPages: active.pages.length };
    });
    await lifecycle(active, steps, evidence.negativeControl === true);
  } catch (error) {
    evidence.failure = error instanceof Error ? error.stack : String(error);
    process.exitCode = 1;
  } finally {
    try {
      if (state) {
        const audit = await state.context.newPage();
        await audit.goto(String(evidence.origin));
        await Promise.all(state.pages.map((page) => page.close()));
        await until(
          async () => Array.from(state!.workers.values()).every(Boolean),
          "native containment worker close events",
        );
        const auditResult = await call(audit, "locks");
        equal(auditResult, { held: [], pending: [] });
        evidence.containment = {
          locks: auditResult,
          deleted: await call(audit, "delete", state.name),
          protocolCleanupAfterLoss: "not claimed",
        };
      }
    } catch (error) {
      evidence.containmentFailure = String(error);
      process.exitCode = 1;
    }
    try {
      await runner.close();
      evidence.outerCleanup = "browser, server, profile and scratch retired";
    } catch (error) {
      evidence.outerCleanupFailure = String(error);
      process.exitCode = 1;
    }
    const report = { ...evidence, steps };
    console.log(JSON.stringify(report));
    if (process.env.PERSISTENT_LIFECYCLE_REPORT)
      await Bun.write(
        process.env.PERSISTENT_LIFECYCLE_REPORT,
        JSON.stringify(report, null, 2) + "\n",
      );
  }
}
if (import.meta.main) await run();
