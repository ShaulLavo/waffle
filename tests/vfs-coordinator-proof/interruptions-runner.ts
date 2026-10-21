import type { Browser, Page } from "playwright";
import { BrowserRunnerLifecycle, browserBundle } from "../browser-runner-lifecycle.js";
import type { Arm, Reply } from "./protocol.js";
import type {} from "./interruptions-page.js";
const lifecycle = new BrowserRunnerLifecycle(180000);
const outcomes: unknown[] = [];
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function ok(reply: Reply): Extract<Reply, { kind: "ok" }> {
  assert(reply.kind === "ok", JSON.stringify(reply));
  return reply;
}
async function settled(page: Page, milliseconds = 800): Promise<boolean> {
  return page
    .waitForFunction(() => interruptions.result() !== undefined, undefined, {
      timeout: milliseconds,
    })
    .then(
      () => true,
      () => false,
    );
}
async function bootstrapHeld(page: Page, workspace: string): Promise<void> {
  await page.waitForFunction(
    async (workspace) => {
      const locks = await navigator.locks.query();
      return locks.held?.some((lock) => lock.name === `e5-bootstrap:${workspace}`);
    },
    workspace,
    { timeout: 1500 },
  );
}
async function queued(page: Page, workspace: string): Promise<void> {
  await page.waitForFunction(
    async (workspace) => {
      const locks = await navigator.locks.query();
      return locks.pending?.some((lock) => lock.name === `e5-bootstrap:${workspace}`);
    },
    workspace,
    { timeout: 1500 },
  );
}
async function connect(page: Page, workspace: string, arm: Arm = "volatile-fast"): Promise<void> {
  ok(
    await page.evaluate(({ workspace, arm }) => interruptions.client.connect(workspace, arm), {
      workspace,
      arm,
    }),
  );
}
async function successor(page: Page): Promise<string> {
  await connect(page, `e5-successor-${crypto.randomUUID()}`);
  ok(
    await page.evaluate(() =>
      interruptions.client.execute({ kind: "write", path: "/data", text: "accepted" }),
    ),
  );
  await page.evaluate(() => interruptions.retainWorker());
  return page.evaluate(() => interruptions.snapshot());
}
async function stable(page: Page, before: string): Promise<void> {
  assert(
    await page.evaluate(() => interruptions.sameWorker()),
    "Late completion replaced successor worker",
  );
  assert(
    (await page.evaluate(() => interruptions.snapshot())) === before,
    "Late completion changed complete accepted authority/cursor/tree/receipts",
  );
}
async function queuedSupersession(page: Page, workspace: string): Promise<unknown> {
  await page.evaluate((workspace) => interruptions.holdBootstrap(workspace), workspace);
  await page.evaluate((workspace) => interruptions.startConnect(workspace), workspace);
  await queued(page, workspace);
  const before = await successor(page);
  await page.evaluate(() => interruptions.release());
  await page.evaluate(() => interruptions.joined());
  const after = await page.evaluate(() => ({
    result: interruptions.result(),
    resources: interruptions.resources(),
    sameWorker: interruptions.sameWorker(),
  }));
  console.log(JSON.stringify({ schedule: "F1 queued", before, after }));
  await stable(page, before);
  assert(after.result?.kind === "error", "Superseded connect succeeded");
  return after;
}
async function detachBeforeGrant(page: Page, workspace: string): Promise<unknown> {
  await page.evaluate((workspace) => interruptions.holdBootstrap(workspace), workspace);
  await page.evaluate((workspace) => interruptions.startConnect(workspace), workspace);
  await queued(page, workspace);
  await page.evaluate(() => interruptions.client.detach());
  const bounded = await settled(page);
  const pending = await page.evaluate(() => navigator.locks.query());
  await page.evaluate(() => interruptions.release());
  await page.evaluate(() => interruptions.joined());
  const resources = await page.evaluate(() => interruptions.resources());
  console.log(JSON.stringify({ schedule: "F2 pre-grant", bounded, pending, resources }));
  assert(bounded, "Cancelled pre-grant connect did not settle");
  assert(
    !pending.pending?.some((lock) => lock.name === `e5-bootstrap:${workspace}`),
    "Cancelled acquisition remains queued",
  );
  assert(!resources.worker && resources.databases === 0, "Detached connect resurrected resources");
  return { bounded, resources };
}
async function registryDetach(page: Page, workspace: string): Promise<unknown> {
  await page.evaluate((workspace) => interruptions.holdRegistry(workspace), workspace);
  await page.evaluate((workspace) => interruptions.startConnect(workspace), workspace);
  await bootstrapHeld(page, workspace);
  await page.waitForFunction(() => interruptions.resources().databases === 2, undefined, {
    timeout: 1500,
  });
  await page.evaluate(() => interruptions.client.detach());
  await page.evaluate(() => interruptions.release());
  await page.evaluate(() => interruptions.joined());
  const resources = await page.evaluate(() => interruptions.resources());
  console.log(
    JSON.stringify({
      schedule: "F1 registry",
      result: await page.evaluate(() => interruptions.result()),
      resources,
    }),
  );
  assert(
    !resources.worker && resources.databases === 0,
    "Registry completion resurrected detached client",
  );
  return resources;
}
async function postGrantBound(page: Page, workspace: string): Promise<unknown> {
  await connect(page, workspace);
  await page.evaluate((workspace) => interruptions.holdRegistry(workspace), workspace);
  await page.evaluate(() => interruptions.startRecover());
  await bootstrapHeld(page, workspace);
  await page.waitForTimeout(3150);
  await page.evaluate(() => interruptions.client.detach());
  const bounded = await settled(page);
  const locks = await page.evaluate(() => navigator.locks.query());
  const ownedBeforeRelease = await page.evaluate(() => interruptions.resources());
  const before = await successor(page);
  await page.evaluate(() => interruptions.release());
  await page.evaluate(() => interruptions.joined());
  await stable(page, before);
  console.log(
    JSON.stringify({
      schedule: "F2 post-grant",
      bounded,
      locks,
      ownedBeforeRelease,
      result: await page.evaluate(() => interruptions.result()),
    }),
  );
  assert(bounded, "Granted recovery exceeded its original 3000 ms bound");
  assert(
    !locks.held?.some((lock) => lock.name === `e5-bootstrap:${workspace}`),
    "Cancelled recovery retained bootstrap lock",
  );
  assert(ownedBeforeRelease.databases === 1, "Cancelled registry retained its database");
  return { bounded, locks, ownedBeforeRelease };
}
async function rejectingLock(page: Page, workspace: string): Promise<unknown> {
  await page.evaluate((workspace) => interruptions.startConnect(workspace), workspace);
  const bounded = await settled(page);
  const detail = await page.evaluate(() => interruptions.client.send({ kind: "inspect" }));
  console.log(JSON.stringify({ schedule: "F2 rejected lock", bounded, detail }));
  assert(bounded, "Lock-request rejection stranded initialization ready promise");
  const value = ok(detail).result;
  assert(
    value && typeof value === "object" && "pending" in value && value.pending === 0,
    "Rejected initialization remains queued",
  );
  assert("initialized" in value && value.initialized === false, "Rejected lock committed a claim");
  return { bounded, detail };
}
async function historyReplay(page: Page, workspace: string, arm: Arm): Promise<unknown> {
  await connect(page, workspace, arm);
  const baseline = ok(
    await page.evaluate(() =>
      interruptions.client.execute({ kind: "write", path: "/data", text: "base:" }),
    ),
  );
  ok(await page.evaluate(() => interruptions.client.execute({ kind: "checkpoint" })));
  const issued = await page.evaluate(() =>
    interruptions.client.request(
      { kind: "append", path: "/data", text: "once:" },
      { dropReply: true },
    ),
  );
  const lost = await page.evaluate((request) => interruptions.client.submit(request), issued);
  assert(
    lost.kind === "error" && lost.code === "OUTCOME_UNKNOWN",
    "Lost response did not stay unknown",
  );
  ok(await page.evaluate(() => interruptions.client.send({ kind: "replace-instance" })));
  await page.waitForFunction(() => interruptions.client.authority.kind === "replacement");
  ok(await page.evaluate(() => interruptions.client.recover()));
  const before = await page.evaluate(() => interruptions.snapshot());
  const replay = await page.evaluate(
    ({ request, arm }) =>
      interruptions.client.submit({
        ...request,
        epoch: interruptions.client.cursor.epoch,
        history: arm === "volatile-fast" ? interruptions.client.cursor.history : request.history,
        dropReply: false,
      }),
    { request: issued, arm },
  );
  const raw = await page.evaluate(
    (request) =>
      interruptions.client.send({
        kind: "request",
        request: { ...request, ...interruptions.client.cursor, dropReply: false },
      }),
    issued,
  );
  const changed = await page.evaluate(
    (request) =>
      interruptions.client.submit({
        ...request,
        epoch: interruptions.client.cursor.epoch,
        operation: { kind: "append", path: "/data", text: "different" },
        dropReply: false,
      }),
    issued,
  );
  console.log(
    JSON.stringify({
      schedule: "F3b refreshed history",
      arm,
      baseline,
      issued,
      lost,
      replay,
      raw,
      changed,
      before,
      after: await page.evaluate(() => interruptions.snapshot()),
    }),
  );
  assert(changed.kind === "error" && changed.code === "OP_ID_CONFLICT", "Changed payload accepted");
  if (arm === "volatile-fast") {
    assert(
      replay.kind === "error" && replay.code === "OUTCOME_UNKNOWN",
      "Refreshed-history mutation executed",
    );
    assert(
      raw.kind === "error" && raw.code === "OUTCOME_UNKNOWN",
      "Authority accepted a relabelled old identity",
    );
  }
  if (arm !== "volatile-fast")
    assert(replay.kind === "ok" && raw.kind === "ok", "Durable duplicate receipt unavailable");
  assert(
    (await page.evaluate(() => interruptions.snapshot())) === before,
    "Replay changed complete accepted state",
  );
  return { replay, raw, changed };
}
async function holderRefusal(page: Page, workspace: string): Promise<unknown> {
  await connect(page, workspace);
  const before = await page.evaluate(() => interruptions.snapshot());
  const contender = await page.context().newPage();
  await contender.goto(page.url());
  const refused = await contender.evaluate(
    (workspace) => interruptions.client.connect(workspace, "volatile-fast", true),
    workspace,
  );
  assert(refused.kind === "error" && refused.code === "UNAVAILABLE", "Living holder was replaced");
  assert(
    (await page.evaluate(() => interruptions.snapshot())) === before,
    "Refusal changed holder state",
  );
  return refused;
}
async function run(
  browser: Browser,
  origin: string,
  label: string,
  control: (page: Page, workspace: string) => Promise<unknown>,
): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(origin);
    const detail = await control(page, `e5-${label}-${crypto.randomUUID()}`);
    const outcome = { label, status: "GREEN", detail };
    outcomes.push(outcome);
    console.log(JSON.stringify(outcome));
  } catch (error) {
    const outcome = { label, status: "RED", error: String(error) };
    outcomes.push(outcome);
    console.log(JSON.stringify(outcome));
  } finally {
    await context.close();
  }
}
try {
  await lifecycle.init();
  const origin = lifecycle.serve({
    "/": '<!doctype html><script type="module" src="/page.js"></script>',
    "/page.js": await browserBundle("tests/vfs-coordinator-proof/interruptions-page.ts"),
    "/authority.js": await browserBundle("tests/vfs-coordinator-proof/interruptions-authority.ts"),
  });
  const browser = await lifecycle.launch("chromium");
  console.log(JSON.stringify({ engine: "chromium", version: browser.version() }));
  await run(browser, origin, "F1-queued", queuedSupersession);
  await run(browser, origin, "F1-registry-detach", registryDetach);
  await run(browser, origin, "F2-pre-grant", detachBeforeGrant);
  await run(browser, origin, "F2-post-grant", postGrantBound);
  await run(browser, origin, "reject-volatile-F2", rejectingLock);
  for (const arm of ["volatile-fast", "fenced-safe", "fenced-fast"] as const)
    await run(browser, origin, `F3b-${arm}`, (page, workspace) =>
      historyReplay(page, workspace, arm),
    );
  await run(browser, origin, "live-holder-refusal", holderRefusal);
  console.log(JSON.stringify({ kind: "INTERRUPTION_RESULT", outcomes }));
  if (
    outcomes.some(
      (value) => value && typeof value === "object" && "status" in value && value.status === "RED",
    )
  )
    process.exitCode = 1;
} finally {
  await lifecycle.close();
}
