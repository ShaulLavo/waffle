import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { record } from "../fs/publication-attachment";
import { BrowserRunnerLifecycle, browserBundle } from "./browser-runner-lifecycle";
import { runStep } from "./persistent-lifecycle-r2-browser-runner";
import type * as PageModule from "./fixtures/recovery-r42-page";

function call(page: Page, operation: string, body?: unknown): Promise<unknown> {
  return page.evaluate(
    async ({ operation, body }) => {
      const path = "/recovery-r42-page.js";
      const module: typeof PageModule = await import(path);
      return module.control(operation, body);
    },
    { operation, body },
  );
}
function owner(page: Page, operation: string, body?: unknown): Promise<unknown> {
  return call(page, "owner", { operation, body });
}
function host(page: Page, operation: string, args: unknown[] = [], bytes?: number[]) {
  return call(page, "host", { operation, args, bytes });
}
async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`missing native observation ${label}`);
    await Bun.sleep(10);
  }
}
async function read(page: Page): Promise<unknown> {
  const root = await host(page, "preopen", ["/"]);
  const file = record(await host(page, "resolve", [root, "saved"]));
  return host(page, "read", [file.node, 64, 0]);
}
async function nativeSaved(page: Page, database: string): Promise<unknown> {
  const saved = record(await call(page, "nativeRecords", database));
  const index = record(saved.index);
  assert(Array.isArray(index.nodes) && Array.isArray(saved.payloads));
  const file = index.nodes.map(record).find((node) => node.kind === "file");
  assert(file);
  const payload = saved.payloads.map(record).find((item) => item.key === file.data);
  assert(payload);
  assert.deepEqual(payload.bytes, [10, 20, 30, 90]);
  assert.equal(file.size, 4);
  assert.equal(saved.active, index.generation);
  return saved;
}
export function assertSingleAppend(bytes: unknown, changes: unknown, receipt: unknown): void {
  assert.deepEqual(bytes, [10, 20, 30, 90], "lost reply must not append twice");
  const page = record(changes);
  assert.equal(page.kind, "changes");
  assert(Array.isArray(page.publications));
  assert.equal(page.publications.length, 1, "exact replay must not add publication groups");
  const publication = record(page.publications[0]);
  assert.deepEqual(publication.receipt, receipt);
  assert(Array.isArray(publication.changes));
  const writes = publication.changes.map(record).filter((effect) => effect.kind === "bytes");
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.offset, 3);
  assert.equal(writes[0]?.size, 4);
}
function settlementReplies(probe: unknown, request: Record<string, unknown>): unknown[] {
  const replies = record(probe).replies;
  assert(Array.isArray(replies));
  return replies
    .map(record)
    .filter((reply) => reply.id === request.id && reply.client === request.client);
}
interface State {
  context: BrowserContext;
  pages: Page[];
  workerClosed: boolean[];
  database: string;
  origin: string;
}
async function open(state: State): Promise<Page> {
  const page = await state.context.newPage();
  state.pages.push(page);
  page.on("worker", (worker) => {
    const index = state.workerClosed.push(false) - 1;
    worker.once("close", () => {
      state.workerClosed[index] = true;
    });
  });
  await page.goto(state.origin);
  assert.equal(await page.opener(), null);
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  return page;
}
async function contain(state: State): Promise<unknown> {
  const audit = await state.context.newPage();
  await audit.goto(state.origin);
  await Promise.all(state.pages.map((page) => page.close()));
  await until(async () => state.workerClosed.every(Boolean), "owned worker close events");
  await until(async () => {
    const locks = record(await call(audit, "locks"));
    return (
      Array.isArray(locks.held) &&
      locks.held.length === 0 &&
      Array.isArray(locks.pending) &&
      locks.pending.length === 0
    );
  }, "all native guards released");
  return {
    locks: await call(audit, "locks"),
    database: await call(audit, "delete", state.database),
  };
}
async function incorrectFreshAppend(page: Page): Promise<void> {
  await call(page, "r42-append");
  await until(
    async () => record(record(await call(page, "r42-probe")).append).kind !== "pending",
    "incorrect fresh append completed",
  );
  assert.equal(record(record(await call(page, "r42-probe")).append).kind, "fulfilled");
}
async function replaySchedule(
  state: State,
  steps: Parameters<typeof runStep>[0],
  negative: boolean,
) {
  const a = await open(state),
    b = await open(state),
    c = await open(state);
  let ready: Record<string, unknown> = {},
    before: unknown,
    receipt: unknown,
    request: Record<string, unknown> = {};
  await runStep(steps, 0, async () => {
    ready = record(await call(a, "start", { name: state.database }));
    await call(b, "attach", ready.descriptor);
    await call(c, "attach", ready.descriptor);
    await host(b, "writeFile", ["/saved"], [10, 20, 30]);
    await host(b, "flush");
    assert.deepEqual(await read(c), [10, 20, 30]);
    before = await owner(a, "cut");
    return { ready, before, independentPages: state.pages.length };
  });
  await runStep(steps, 1, async () => {
    await owner(a, "r42-arm");
    await call(b, "r42-append");
    await until(
      async () => record(await owner(a, "r42-probe")).held !== null,
      "committed reply held",
    );
    const probe = record(await call(b, "r42-probe"));
    assert.equal(record(probe.append).kind, "pending");
    request = record(probe.captured);
    assert.equal(request.operation, "settle");
    assert.equal(record(record(request.body).outcome).kind, "committed");
    const changes = record(await owner(a, "changes", before));
    assert(Array.isArray(changes.publications));
    receipt = record(changes.publications[0]).receipt;
    assertSingleAppend(await read(c), changes, receipt);
    assert.equal(state.workerClosed[0], false);
    return { held: await owner(a, "r42-probe"), request, receipt, changes };
  });
  await runStep(steps, 2, async () => {
    assert.deepEqual(await call(b, "r42-replay"), request);
    await until(
      async () => record(record(await call(b, "r42-probe")).append).kind !== "pending",
      "first exact replay reply",
    );
    const result = record(record(await call(b, "r42-probe")).append);
    assert.equal(result.kind, "fulfilled");
    const tail = record(result.value);
    assert.deepEqual(tail.ack, { written: 1, offset: 4 });
    assert.deepEqual(tail.settlement, { kind: "committed", receipt });
    assert.deepEqual(await call(b, "r42-replay"), request);
    await until(
      async () => settlementReplies(await call(b, "r42-probe"), request).length === 2,
      "second exact replay reply",
    );
    const held = record(await owner(a, "r42-probe"));
    const first = record(held.held);
    for (const reply of settlementReplies(await call(b, "r42-probe"), request))
      assert.deepEqual(reply, first);
    assert.deepEqual(await owner(a, "r42-release"), { released: true });
    await until(
      async () => settlementReplies(await call(b, "r42-probe"), request).length === 3,
      "delayed original reply",
    );
    for (const reply of settlementReplies(await call(b, "r42-probe"), request))
      assert.deepEqual(reply, first);
    assert.deepEqual(await owner(a, "cut"), record(receipt).cut);
    return { result, replies: settlementReplies(await call(b, "r42-probe"), request) };
  });
  await runStep(steps, 3, async () => {
    if (negative) await incorrectFreshAppend(b);
    const bytes = await read(c),
      changes = await owner(a, "changes", before);
    assertSingleAppend(bytes, changes, receipt);
    assert.deepEqual(await owner(a, "receipt", record(receipt).id), { kind: "committed", receipt });
    await host(b, "flush");
    return { bytes, changes, saved: await nativeSaved(a, state.database) };
  });
  await runStep(steps, 4, async () => {
    await call(b, "stopPeer");
    await call(c, "stopPeer");
    assert.deepEqual(await owner(a, "stop"), { memoized: true, stopped: true });
    assert.deepEqual(await call(a, "locks"), { held: [], pending: [] });
    assert.equal(state.workerClosed[0], false);
    const probe = record(await owner(a, "probe"));
    assert(Array.isArray(probe.events));
    assert(probe.events.includes("native-database-close-called"));
    return { gracefulStop: true, ownerStillAlive: true, locks: await call(a, "locks"), probe };
  });
  await runStep(steps, 5, async () => {
    const reopened = record(
      await call(c, "start", { name: state.database, original: ready.identity }),
    );
    assert.notEqual(record(reopened.identity).history, record(ready.identity).history);
    assert.notEqual(record(reopened.identity).instance, record(ready.identity).instance);
    assert.deepEqual(reopened.notice, {
      kind: "v1-new-history",
      durablePublicationCut: "untracked",
      oldCapabilities: "not-restored",
      oldMutationOutcomes: "not-restored",
      acknowledgedTail: "may-be-lost",
    });
    assert.deepEqual(await owner(c, "receipt", record(receipt).id), { kind: "unknown" });
    assert.equal(record(await owner(c, "changes", before)).kind, "gap");
    assert.deepEqual(await call(a, "staleDescriptor", ready.descriptor), {
      kind: "rejected",
      errno: 11,
    });
    await call(b, "attach", reopened.descriptor);
    assert.deepEqual(await read(b), [10, 20, 30, 90]);
    const saved = await nativeSaved(a, state.database);
    await call(b, "stopPeer");
    assert.deepEqual(await owner(c, "stop"), { memoized: true, stopped: true });
    assert.deepEqual(await call(a, "locks"), { held: [], pending: [] });
    return {
      reopened,
      saved,
      oldReceipt: { kind: "unknown" },
      oldCursor: "gap",
      locks: await call(a, "locks"),
    };
  });
}
async function run(): Promise<void> {
  const runner = new BrowserRunnerLifecycle(150000);
  const steps: Parameters<typeof runStep>[0] = [
    "native multi-page baseline",
    "committed settlement reply lost without death",
    "exact identity replay and delayed original reply",
    "one mutation and completed native flush",
    "graceful owner close while worker lives",
    "explicit reset preserves bytes without old outcomes",
  ].map((name) => ({ name, kind: "unrun" }));
  const evidence: Record<string, unknown> = {
    base: "b80e8dfcef0e27392121190fca8023bacca46e53",
    negativeControl: process.argv.includes("--negative-control"),
  };
  let state: State | undefined;
  try {
    await runner.init();
    evidence.scratch = runner.scratch;
    const origin = runner.serve(
      {
        "/": "<!doctype html><title>Recovery r42</title>",
        "/recovery-r42-page.js": await browserBundle(
          resolve(import.meta.dir, "fixtures/recovery-r42-page.ts"),
        ),
        "/persistent-lifecycle-r2-owner.js": await browserBundle(
          resolve(import.meta.dir, "fixtures/recovery-r42-owner.ts"),
        ),
      },
      0,
    );
    const browser = await runner.launch("chromium");
    evidence.browser = browser.version();
    state = {
      context: await browser.newContext(),
      pages: [],
      workerClosed: [],
      database: `recovery-r42-${crypto.randomUUID()}`,
      origin,
    };
    evidence.database = state.database;
    await replaySchedule(state, steps, evidence.negativeControl === true);
  } catch (error) {
    evidence.failure = error instanceof Error ? error.stack : String(error);
    process.exitCode = 1;
  } finally {
    try {
      if (state) evidence.containment = await contain(state);
    } catch (error) {
      evidence.containmentFailure = String(error);
      process.exitCode = 1;
    }
    try {
      await runner.close();
      evidence.outerCleanup = "browser, server, profiles and scratch retired";
    } catch (error) {
      evidence.outerCleanupFailure = String(error);
      process.exitCode = 1;
    }
    const report = { ...evidence, steps };
    const json = JSON.stringify(
      report,
      (_key, value: unknown) =>
        typeof value === "bigint" ? { kind: "bigint", decimal: String(value) } : value,
      2,
    );
    console.log(json);
    if (process.env.RECOVERY_R42_REPORT)
      await Bun.write(process.env.RECOVERY_R42_REPORT, json + "\n");
  }
}
if (import.meta.main) await run();
