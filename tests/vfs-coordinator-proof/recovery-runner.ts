import type { Browser, BrowserContext, Page } from "playwright";
import type { Arm, Operation, Reply, Request, WorkerMessage } from "./protocol.js";
import type {} from "./page.js";

type Emit = (value: {
  engine: string;
  arm: Arm;
  label: string;
  status: string;
  detail?: unknown;
  error?: string;
}) => void;
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function ok(reply: Reply): Extract<Reply, { kind: "ok" }> {
  if (reply.kind === "error") throw new Error(JSON.stringify(reply));
  return reply;
}
function error(reply: Reply, code: string): void {
  assert(
    reply.kind === "error" && reply.code === code,
    `Expected ${code}, got ${JSON.stringify(reply)}`,
  );
}
async function execute(page: Page, operation: Operation, options: Partial<Request> = {}) {
  return page.evaluate(({ operation, options }) => proof.client.execute(operation, options), {
    operation,
    options,
  });
}
async function text(page: Page): Promise<string> {
  const result = ok(await execute(page, { kind: "read", path: "/data" })).result;
  assert(
    result && typeof result === "object" && "text" in result && typeof result.text === "string",
    "Missing file",
  );
  return result.text;
}
async function pagesFor(context: BrowserContext, origin: string, workspace: string, arm: Arm) {
  const pages: Page[] = [];
  for (let index = 0; index < 4; index++) {
    const page = await context.newPage();
    pages.push(page);
    await page.goto(origin);
    ok(
      await page.evaluate(({ workspace, arm }) => proof.client.connect(workspace, arm), {
        workspace,
        arm,
      }),
    );
  }
  return pages;
}
async function recoverAll(pages: Page[]) {
  const replies: Reply[] = [];
  for (const page of pages) replies.push(await page.evaluate(() => proof.client.recover()));
  for (const reply of replies) ok(reply);
  const authorities = await Promise.all(
    pages.map((page) => page.evaluate(() => proof.client.authority)),
  );
  assert(
    new Set(authorities.map((value) => JSON.stringify(value))).size === 1,
    "Survivors accepted different authorities",
  );
  return replies;
}
async function replacementSeen(pages: Page[]): Promise<void> {
  for (const page of pages)
    await page.waitForFunction(() => proof.client.authority.kind === "replacement", undefined, {
      timeout: 2500,
    });
}
async function parked(page: Page, gate: string): Promise<void> {
  await page.waitForFunction(
    async (gate) => {
      const reply = await proof.client.send({ kind: "inspect" });
      return reply.kind === "ok" && JSON.stringify(reply.result).includes(`"gate":"${gate}"`);
    },
    gate,
    { timeout: 2500 },
  );
}
async function firstClose(browser: Browser, engine: string, arm: Arm, origin: string, emit: Emit) {
  const context = await browser.newContext();
  const workspace = `waffle-incarnation-close-${crypto.randomUUID()}`;
  try {
    const pages = await pagesFor(context, origin, workspace, arm);
    const [first, second] = pages;
    assert(first && second, "Four pages required");
    ok(await execute(first, { kind: "write", path: "/data", text: "checkpoint:" }));
    const writes = await Promise.all(
      pages.map((page, index) =>
        execute(page, { kind: "append", path: "/data", text: `${index},` }),
      ),
    );
    for (const reply of writes) ok(reply);
    assert(
      new Set(writes.map((reply) => ok(reply).cursor.watermark)).size === 4,
      "Duplicate publication order",
    );
    const checkpoint = ok(await execute(second, { kind: "checkpoint" }));
    const saved = await text(second);
    ok(await execute(first, { kind: "append", path: "/data", text: "tail" }, { dropNudge: true }));
    for (const page of pages)
      assert((await text(page)) === saved + "tail", "Four-tab pre-close disagreement");
    const before = await second.evaluate(() => proof.client.authority);
    await first.close();
    const after = await execute(second, { kind: "read", path: "/data" });
    const next = await execute(second, { kind: "read", path: "/data" });
    console.log(
      JSON.stringify({
        engine,
        arm,
        phase: "real-creator-close-before-recovery",
        before,
        after,
        next,
      }),
    );
    const survivors = pages.slice(1);
    const recovered = await recoverAll(survivors);
    const current = await second.evaluate(() => proof.client.authority);
    assert(before.kind === "current" && current.kind === "current", "Missing accepted authority");
    const replaced = before.accepted.instance !== current.accepted.instance;
    const expected = arm === "volatile-fast" && replaced ? saved : saved + "tail";
    for (const page of survivors)
      assert((await text(page)) === expected, "Recovered creator-close tree mismatch");
    if (replaced && arm === "volatile-fast")
      assert(
        current.accepted.cursor.history !== before.accepted.cursor.history,
        "Missing volatile history gap",
      );
    assert(
      current.accepted.cursor.durableWatermark >= checkpoint.cursor.watermark,
      "Lost strict checkpoint",
    );
    emit({
      engine,
      arm,
      label:
        "real first creator close, explicit retained-port recovery and two current reads per survivor",
      status: "VERIFIED",
      detail: { before, after, next, recovered, replaced, expected },
    });
    if (!replaced)
      emit({
        engine,
        arm,
        label: "browser-triggered module replacement on creator close",
        status: "NOT VERIFIED",
        detail:
          "No replacement instance observed in this schedule; deterministic replacement is separate",
      });
  } finally {
    await context.close();
  }
}
function rawInPage(mutation: boolean): Promise<Reply> {
  const client = proof.client;
  const worker = client.worker;
  if (!worker) throw new Error("Missing retained worker");
  const id = mutation ? -1002 : -1001;
  const request = client.request(
    mutation
      ? { kind: "append", path: "/data", text: "uninitialized-must-not-apply:" }
      : { kind: "read", path: "/data" },
  );
  return new Promise<Reply>((resolve, reject) => {
    const finish = (event: MessageEvent<WorkerMessage>) => {
      const value = event.data;
      if (!("id" in value) || value.id !== id || !value.result) return;
      clearTimeout(timer);
      worker.port.removeEventListener("message", finish);
      resolve(value.result);
    };
    const timer = setTimeout(() => {
      worker.port.removeEventListener("message", finish);
      reject(new Error("Raw uninitialized request deadline"));
    }, 3000);
    worker.port.addEventListener("message", finish);
    worker.port.postMessage({ id, command: { kind: "request", request } });
  });
}
async function rawUninitialized(page: Page, mutation: boolean): Promise<Reply> {
  return page.evaluate(rawInPage, mutation);
}
async function replay(page: Page, request: Request, textOverride?: string): Promise<Reply> {
  return page.evaluate(
    ({ request, textOverride }) => {
      const operation =
        textOverride === undefined
          ? request.operation
          : { kind: "append" as const, path: "/data", text: textOverride };
      return proof.client.submit({
        ...request,
        operation,
        epoch: proof.client.cursor.epoch,
        dropReply: false,
        replyGate: undefined,
        gate: undefined,
      });
    },
    { request, textOverride },
  );
}
async function dropped(page: Page) {
  const request = await page.evaluate(() =>
    proof.client.request(
      { kind: "append", path: "/data", text: "once:" },
      { dropReply: true, dropNudge: true },
    ),
  );
  const before = await page.evaluate(() => proof.client.nudges);
  const result = await page.evaluate((request) => proof.client.submit(request), request);
  error(result, "OUTCOME_UNKNOWN");
  assert(
    (await page.evaluate(() => proof.client.nudges)) === before,
    "Dropped final notification delivered",
  );
  const receipt = ok(
    await execute(page, { kind: "status", key: `${request.client}:${request.sequence}` }),
  );
  assert(receipt.result !== null, "Dropped response lacked live receipt");
  return { request, result, receipt };
}
async function lockRefusal(context: BrowserContext, origin: string, workspace: string, page: Page) {
  const contender = await context.newPage();
  await contender.goto(origin);
  const before = await page.evaluate(() => proof.client.cursor);
  const result = await contender.evaluate(
    (workspace) => proof.client.connect(workspace, "volatile-fast", true),
    workspace,
  );
  error(result, "UNAVAILABLE");
  assert(
    (await execute(page, { kind: "read", path: "/data" })).kind === "ok",
    "Live holder stopped",
  );
  const after = await page.evaluate(() => proof.client.cursor);
  assert(before.epoch === after.epoch, "Held lock authority replaced");
  await contender.close();
  return { result, before, after, actualFreeze: false };
}
async function explicitReplacement(
  browser: Browser,
  engine: string,
  arm: Arm,
  origin: string,
  emit: Emit,
) {
  const context = await browser.newContext();
  const workspace = `waffle-incarnation-explicit-${crypto.randomUUID()}`;
  try {
    const pages = await pagesFor(context, origin, workspace, arm);
    const [first, second, third, fourth] = pages;
    assert(first && second && third && fourth, "Four pages required");
    const baselineRequest = await first.evaluate(() =>
      proof.client.request({ kind: "write", path: "/data", text: "base:" }),
    );
    const baseline = ok(
      await first.evaluate((request) => proof.client.submit(request), baselineRequest),
    );
    ok(await execute(first, { kind: "checkpoint" }));
    ok(await execute(first, { kind: "append", path: "/data", text: "ack:" }));
    const lost = await dropped(first);
    const lock =
      arm === "volatile-fast" ? await lockRefusal(context, origin, workspace, first) : undefined;
    const gate = "old-committed-response";
    const lateRequest = await second.evaluate(
      (gate) =>
        proof.client.request({ kind: "append", path: "/data", text: "late:" }, { replyGate: gate }),
      gate,
    );
    const pending = second.evaluate((request) => proof.client.submit(request), lateRequest);
    await parked(third, gate);
    const old = await first.evaluate(() => proof.client.authority);
    ok(await fourth.evaluate(() => proof.client.send({ kind: "replace-instance" })));
    await replacementSeen(pages);
    const unresolved = await pending;
    error(unresolved, "OUTCOME_UNKNOWN");
    const uninitialized = await execute(third, { kind: "read", path: "/data" });
    error(uninitialized, "UNAVAILABLE");
    const rawUninitialized = await third.evaluate(() => proof.client.send({ kind: "inspect" }));
    assert(
      ok(rawUninitialized).result &&
        JSON.stringify(ok(rawUninitialized).result).includes('"initialized":false'),
      "Replacement did not start uninitialized",
    );
    const rawRead = await rawUninitialized(third, false);
    const rawMutation = await rawUninitialized(third, true);
    error(rawRead, "UNAVAILABLE");
    error(rawMutation, "UNAVAILABLE");
    const recoveries = await recoverAll(pages);
    const cut = await first.evaluate(() => proof.client.cursor);
    const expected = arm === "volatile-fast" ? "base:" : "base:ack:once:late:";
    for (const page of pages) assert((await text(page)) === expected, "Replacement tree mismatch");
    const durableDuplicate = ok(await replay(first, baselineRequest));
    assert(
      JSON.stringify(durableDuplicate.result) === JSON.stringify(baseline.result),
      "Checkpoint receipt changed",
    );
    const duplicate = await replay(first, lost.request);
    const changed = await replay(first, lost.request, "different:");
    error(changed, "OP_ID_CONFLICT");
    if (arm === "volatile-fast") error(duplicate, "OUTCOME_UNKNOWN");
    if (arm !== "volatile-fast")
      assert(
        JSON.stringify(ok(duplicate).result) === JSON.stringify(lost.receipt.result),
        "Durable receipt changed",
      );
    const crossClient = await replay(third, lost.request, "different:");
    if (arm !== "volatile-fast") error(crossClient, "OP_ID_CONFLICT");
    if (arm === "volatile-fast") error(crossClient, "OUTCOME_UNKNOWN");
    await oldQueueRelease(second, third, gate, cut.epoch);
    for (const page of pages) assert((await text(page)) === expected, "Late response changed tree");
    const lateDuplicate = await replay(second, lateRequest);
    if (arm === "volatile-fast") error(lateDuplicate, "OUTCOME_UNKNOWN");
    if (arm !== "volatile-fast") ok(lateDuplicate);
    const changes = ok(
      await execute(third, { kind: "changes", history: lost.request.history, after: 0 }),
    );
    if (arm === "volatile-fast")
      assert(
        JSON.stringify(changes.result).includes('"kind":"gap"'),
        "Volatile recovery omitted history gap",
      );
    emit({
      engine,
      arm,
      label:
        "deterministic retained-port replacement, no replay, durable receipts or explicit volatile loss, stale response rejected",
      status: "VERIFIED",
      detail: {
        old,
        recoveries,
        lost,
        unresolved,
        uninitialized,
        duplicate,
        changed,
        crossClient,
        lateDuplicate,
        durableDuplicate,
        rawRead,
        rawMutation,
        changes,
        expected,
        lock,
        actualFreeze: false,
      },
    });
    await gracefulDrain(pages, engine, arm, emit);
  } finally {
    await context.close();
  }
}
async function oldQueueRelease(
  old: Page,
  observer: Page,
  gate: string,
  epoch: number,
): Promise<void> {
  const before = await old.evaluate(() => proof.client.staleReplies);
  ok(await observer.evaluate((gate) => proof.client.send({ kind: "release", gate }), gate));
  await old.waitForFunction((before) => proof.client.staleReplies > before, before, {
    timeout: 2500,
  });
  const current = await old.evaluate(() => proof.client.cursor);
  assert(current.epoch === epoch, "Old queue response changed accepted epoch");
}
async function gracefulDrain(pages: Page[], engine: string, arm: Arm, emit: Emit) {
  const [first, second] = pages;
  assert(first && second, "Missing drain pages");
  const gate = "graceful-drain";
  const pending = execute(first, { kind: "append", path: "/data", text: "drained:" }, { gate });
  await parked(second, gate);
  const closing = second.evaluate(() => proof.client.send({ kind: "drain-instance" }));
  ok(await first.evaluate((gate) => proof.client.send({ kind: "release", gate }), gate));
  const mutation = ok(await pending);
  const drain = ok(await closing);
  assert(
    drain.cursor.durableWatermark === mutation.cursor.watermark,
    "Drain did not checkpoint queued mutation",
  );
  await replacementSeen(pages);
  const recovered = await recoverAll(pages);
  const values = await Promise.all(pages.map(text));
  assert(new Set(values).size === 1 && values[0]?.endsWith("drained:"), "Graceful drain tree lost");
  emit({
    engine,
    arm,
    label: "graceful queued drain and retained-port recovery",
    status: "VERIFIED",
    detail: { mutation, drain, recovered, values, logicalControl: true },
  });
}
async function externalDeath(
  browser: Browser,
  engine: string,
  arm: Arm,
  origin: string,
  emit: Emit,
  kill: (workspace: string) => Promise<unknown>,
) {
  const context = await browser.newContext();
  const workspace = `waffle-incarnation-death-${crypto.randomUUID()}`;
  try {
    const pages = await pagesFor(context, origin, workspace, arm);
    const [first, second] = pages;
    assert(first && second, "Missing death pages");
    ok(await execute(first, { kind: "write", path: "/data", text: "base:" }));
    ok(await execute(first, { kind: "checkpoint" }));
    ok(await execute(first, { kind: "append", path: "/data", text: "ack:" }));
    const lost = await dropped(first);
    const gate = "external-death-unadmitted";
    const pending = execute(
      second,
      { kind: "append", path: "/data", text: "must-not-apply:" },
      { gate },
    );
    await parked(first, gate);
    const killed = await kill(workspace);
    error(await pending, "OUTCOME_UNKNOWN");
    ok(
      await first.evaluate(({ workspace, arm }) => proof.client.connect(workspace, arm, true), {
        workspace,
        arm,
      }),
    );
    for (const page of pages.slice(1))
      ok(
        await page.evaluate(({ workspace, arm }) => proof.client.connect(workspace, arm), {
          workspace,
          arm,
        }),
      );
    const expected = arm === "volatile-fast" ? "base:" : "base:ack:once:";
    for (const page of pages)
      assert((await text(page)) === expected, "External death recovered wrong tree");
    const repeated = await replay(first, lost.request);
    if (arm === "volatile-fast") error(repeated, "OUTCOME_UNKNOWN");
    if (arm !== "volatile-fast")
      assert(
        JSON.stringify(ok(repeated).result) === JSON.stringify(lost.receipt.result),
        "External death changed durable receipt",
      );
    emit({
      engine,
      arm,
      label:
        "external Chromium worker target death with explicit new attachment, distinct from retained-port recovery",
      status: "VERIFIED",
      detail: { killed, repeated, expected, retainedPortRecovery: false, actualFreeze: false },
    });
  } finally {
    await context.close();
  }
}
export async function recoveryControls(
  browser: Browser,
  engine: string,
  origin: string,
  emit: Emit,
  kill: (workspace: string) => Promise<unknown>,
) {
  for (const arm of ["fenced-safe", "fenced-fast", "volatile-fast"] as const) {
    await runCase(
      () => firstClose(browser, engine, arm, origin, emit),
      engine,
      arm,
      "real creator-close recovery",
      emit,
    );
    await runCase(
      () => explicitReplacement(browser, engine, arm, origin, emit),
      engine,
      arm,
      "deterministic replacement recovery",
      emit,
    );
    if (engine === "chromium")
      await runCase(
        () => externalDeath(browser, engine, arm, origin, emit, kill),
        engine,
        arm,
        "external target death",
        emit,
      );
    if (engine !== "chromium")
      emit({
        engine,
        arm,
        label: "external target death",
        status: "NOT VERIFIED",
        detail: "No external worker-target termination control for this engine",
      });
  }
}
async function runCase(
  run: () => Promise<void>,
  engine: string,
  arm: Arm,
  label: string,
  emit: Emit,
) {
  try {
    await run();
  } catch (error) {
    emit({ engine, arm, label, status: "FAILED", error: String(error) });
  }
}
