import type { Browser, Page } from "playwright";
import { BrowserRunnerLifecycle, browserBundle, engines } from "../browser-runner-lifecycle.js";
import type { Arm, Operation, Reply, Request } from "./protocol.js";
import type {} from "./page.js";

const lifecycle = new BrowserRunnerLifecycle(480000);
const outcomes: unknown[] = [];
let activeEngine = "";
let origin = "";
function assert(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
}
function ok(reply: Reply): Extract<Reply, { kind: "ok" }> {
  if (reply.kind !== "ok") throw new Error(`${reply.code}: ${reply.message}`);
  return reply;
}
async function execute(page: Page, operation: Operation, options: Partial<Request> = {}) {
  return page.evaluate(({ operation, options }) => proof.client.execute(operation, options), {
    operation,
    options,
  });
}
async function connected(page: Page, workspace: string, arm: Arm, replace = false) {
  return page.evaluate(
    ({ workspace, arm, replace }) => proof.client.connect(workspace, arm, replace),
    { workspace, arm, replace },
  );
}
async function content(
  page: Page,
  path: string,
): Promise<{ id: number; version: number; text: string } | null> {
  const reply = ok(await execute(page, { kind: "read", path }));
  const value = reply.result;
  if (value === null) return null;
  assert(
    value &&
      typeof value === "object" &&
      "text" in value &&
      typeof value.text === "string" &&
      "id" in value &&
      typeof value.id === "number" &&
      "version" in value &&
      typeof value.version === "number",
    "Invalid read",
  );
  return { id: value.id, version: value.version, text: value.text };
}
function record(label: string, detail: unknown): void {
  const result = { engine: activeEngine, label, status: "VERIFIED", detail };
  outcomes.push(result);
  console.log(JSON.stringify(result));
}
async function firstControl(pages: Page[], arm: Arm) {
  const [first, second] = pages;
  assert(first && second, "Four pages required");
  ok(await execute(first, { kind: "write", path: "/shared", text: "" }));
  const replies = await Promise.all(
    pages.map((page, index) =>
      execute(page, { kind: "append", path: "/shared", text: `tab-${index}\n` }),
    ),
  );
  const cuts = replies.map((reply) => ok(reply).cursor);
  assert(new Set(cuts.map((cut) => cut.epoch)).size === 1, "Split authority epoch");
  assert(new Set(cuts.map((cut) => cut.watermark)).size === 4, "Lost commit order");
  const reads = await Promise.all(pages.map((page) => content(page, "/shared")));
  for (const value of reads)
    assert(
      value && value.text.trim().split("\n").sort().join(",") === "tab-0,tab-1,tab-2,tab-3",
      "Four-writer coherence",
    );
  assert(new Set(reads.map((value) => value?.id)).size === 1, "File identity diverged");
  record(`${arm}: four independently created writer/tool tabs`, { cuts, reads });
  await mixedWriterControl(pages, arm);
  await first.close();
  ok(await execute(second, { kind: "append", path: "/shared", text: "after-first-close\n" }));
  assert(
    (await content(second, "/shared"))?.text.endsWith("after-first-close\n"),
    "First-page close broke authority",
  );
  record(`${arm}: first attaching tab closed, other writers live`, { remaining: 3 });
}
function batch(value: unknown): { watermark: number; actor: string; key: string }[] {
  assert(
    value &&
      typeof value === "object" &&
      "kind" in value &&
      value.kind === "batch" &&
      "changes" in value &&
      Array.isArray(value.changes),
    "Missing change batch",
  );
  return value.changes.map((change: unknown) => {
    assert(
      change &&
        typeof change === "object" &&
        "watermark" in change &&
        typeof change.watermark === "number" &&
        "actor" in change &&
        typeof change.actor === "string" &&
        "key" in change &&
        typeof change.key === "string",
      "Invalid change",
    );
    return { watermark: change.watermark, actor: change.actor, key: change.key };
  });
}
async function mixedWriterControl(pages: Page[], arm: Arm) {
  const [guest, tool, host, other] = pages;
  assert(guest && tool && host && other, "Mixed writers need four pages");
  ok(await execute(host, { kind: "write", path: "/mixed", text: "seed:" }));
  const snapshot = ok(await execute(tool, { kind: "snapshot" }));
  const results = await Promise.all([
    guest.evaluate(() => proof.runGuest("/mixed", "guest")),
    execute(tool, { kind: "append", path: "/shared", text: "mixed-tool\n" }, { actor: "tool" }),
    execute(host, { kind: "append", path: "/shared", text: "mixed-host\n" }),
    execute(other, { kind: "append", path: "/shared", text: "mixed-other\n" }),
  ]);
  const result = results[0];
  assert(
    result && typeof result === "object" && "kind" in result && result.kind === "guest-complete",
    `Mixed guest failed: ${JSON.stringify(result)}`,
  );
  const pulled = ok(
    await execute(tool, {
      kind: "changes",
      history: snapshot.cursor.history,
      after: snapshot.cursor.watermark,
    }),
  );
  const changes = batch(pulled.result);
  assert(
    changes.length === 5 &&
      changes.every((change, index) => change.watermark === snapshot.cursor.watermark + index + 1),
    "Mixed stream order/gap",
  );
  assert(
    new Set(changes.map((change) => change.key)).size === 5,
    "Mixed stream duplicated identity",
  );
  assert(
    changes.filter((change) => change.actor === "guest").length === 2 &&
      changes.some((change) => change.actor === "tool") &&
      changes.some((change) => change.actor === "host"),
    "Mixed stream omitted actor",
  );
  const reads = await Promise.all(pages.map((page) => content(page, "/mixed.guest")));
  for (const value of reads) assert(value?.text === "seed:guest", "Mixed guest coherence");
  record(`${arm}: four-tab guest/host/tool snapshot-to-stream order`, {
    snapshot: snapshot.cursor,
    changes,
    results,
    reads,
  });
}
async function duplicateControl(page: Page, arm: Arm) {
  const request = await page.evaluate(() =>
    proof.client.request({ kind: "append", path: "/shared", text: "once\n" }),
  );
  const one = await page.evaluate((request) => proof.client.submit(request), request);
  const two = await page.evaluate((request) => proof.client.submit(request), request);
  assert(JSON.stringify(one) === JSON.stringify(two), "Duplicate receipt changed");
  const conflict = {
    ...request,
    operation: { kind: "append", path: "/shared", text: "different\n" },
  } satisfies Request;
  const mismatch = await page.evaluate((request) => proof.client.submit(request), conflict);
  assert(
    mismatch.kind === "error" && mismatch.code === "OP_ID_CONFLICT",
    "Mismatched duplicate accepted",
  );
  assert((await content(page, "/shared"))?.text.split("once\n").length === 2, "Append duplicated");
  record(`${arm}: repeated operation identity and payload mismatch`, { one, two, mismatch });
}
async function guestControl(page: Page, arm: Arm) {
  ok(await execute(page, { kind: "write", path: "/guest", text: "host:" }));
  const result = await page.evaluate(() => proof.runGuest("/guest", "wasm"));
  assert(
    result && typeof result === "object" && "kind" in result && result.kind === "guest-complete",
    `Guest did not complete: ${JSON.stringify(result)}`,
  );
  assert((await content(page, "/guest")) === null, "Guest rename left source");
  const file = await content(page, "/guest.guest");
  assert(file?.text === "host:wasm", "Guest append or rename missing");
  record(`${arm}: actual Wasm through production WASI append and rename`, { result, file });
}
async function streamControl(page: Page, arm: Arm) {
  const snapshot = ok(await execute(page, { kind: "snapshot" }));
  const before = await page.evaluate(() => proof.client.nudges);
  ok(
    await execute(
      page,
      { kind: "append", path: "/shared", text: "dropped-final-nudge\n" },
      { dropNudge: true, actor: "tool" },
    ),
  );
  const after = await page.evaluate(() => proof.client.nudges);
  const changes = ok(
    await execute(page, {
      kind: "changes",
      history: snapshot.cursor.history,
      after: snapshot.cursor.watermark,
    }),
  );
  assert(before === after, "Final notification was not dropped");
  const value = changes.result;
  assert(
    value &&
      typeof value === "object" &&
      "kind" in value &&
      value.kind === "batch" &&
      "changes" in value &&
      Array.isArray(value.changes) &&
      value.changes.length === 1,
    "Snapshot/stream missed final change",
  );
  const future = ok(
    await execute(page, {
      kind: "changes",
      history: changes.cursor.history,
      after: changes.cursor.watermark + 1,
    }),
  );
  assert(
    future.result &&
      typeof future.result === "object" &&
      "kind" in future.result &&
      future.result.kind === "gap",
    "Future cursor silently treated as caught up",
  );
  record(`${arm}: snapshot-to-stream handoff with dropped final nudge`, {
    snapshot: snapshot.cursor,
    changes,
    future,
  });
}
async function waitParked(page: Page, gate: string): Promise<void> {
  await page.waitForFunction(
    async (gate) => {
      const reply = await proof.client.send({ kind: "inspect" });
      return reply.kind === "ok" && JSON.stringify(reply.result).includes(`"gate":"${gate}"`);
    },
    gate,
    { timeout: 2500 },
  );
}
async function submit(page: Page, request: Request): Promise<Reply> {
  return page.evaluate((request) => proof.client.submit(request), request);
}
async function staleControl(old: Page, replacement: Page, workspace: string, arm: Arm) {
  const gate = "pending-append";
  const request = await old.evaluate(
    (gate) =>
      proof.client.request({ kind: "append", path: "/shared", text: "pending-old\n" }, { gate }),
    gate,
  );
  const pending = submit(old, request);
  await waitParked(old, gate);
  const replaced = await connected(replacement, workspace, arm, true);
  if (arm === "volatile-fast") {
    assert(replaced.kind === "error" && replaced.code === "UNAVAILABLE", "Stole volatile lock");
    await old.evaluate((gate) => proof.client.send({ kind: "release", gate }), gate);
    ok(await pending);
    const after = ok(await execute(old, { kind: "read", path: "/shared" }));
    assert(after.cursor.epoch === request.epoch, "Volatile authority changed despite held lock");
    record(`${arm}: parked lock holder refuses suspicion takeover, resumes same authority`, {
      replaced,
      after: after.cursor,
    });
    await expiredVolatile(old, replacement, workspace);
    return;
  }
  ok(replaced);
  ok(await execute(replacement, { kind: "append", path: "/shared", text: "successor\n" }));
  await old.evaluate((gate) => proof.client.send({ kind: "release", gate }), gate);
  const resumed = await pending;
  const staleRead = await execute(old, { kind: "read", path: "/shared" });
  const staleWrite = await execute(old, { kind: "append", path: "/shared", text: "stale-new\n" });
  for (const reply of [resumed, staleRead, staleWrite])
    assert(reply.kind === "error" && reply.code === "FENCED", "Stale authority read or ACK");
  const file = await content(replacement, "/shared");
  assert(
    file && !file.text.includes("pending-old") && !file.text.includes("stale-new"),
    "Stale publication escaped fence",
  );
  record(`${arm}: pending append, stale-resume, new stale mutation and read fenced`, {
    replaced,
    resumed,
    staleRead,
    staleWrite,
    file,
  });
}
async function expiredVolatile(old: Page, replacement: Page, workspace: string) {
  const gate = "expired-volatile";
  const request = await old.evaluate(
    (gate) =>
      proof.client.request(
        { kind: "append", path: "/shared", text: "expired-must-not-commit\n" },
        { gate, expiresAt: Date.now() + 600 },
      ),
    gate,
  );
  const pending = submit(old, request);
  await waitParked(old, gate);
  const refused = await connected(replacement, workspace, "volatile-fast", true);
  assert(refused.kind === "error" && refused.code === "UNAVAILABLE", "Stole held volatile lock");
  const expiresAt = request.expiresAt;
  assert(expiresAt !== undefined, "Missing expiry");
  await old.waitForFunction((expiresAt) => Date.now() >= expiresAt, expiresAt, {
    timeout: 2000,
  });
  await old.evaluate((gate) => proof.client.send({ kind: "release", gate }), gate);
  const expired = await pending;
  assert(
    expired.kind === "error" && expired.code === "UNAVAILABLE",
    "Expired parked mutation ACKed",
  );
  const file = await content(old, "/shared");
  assert(
    file && !file.text.includes("expired-must-not-commit"),
    "Expired mutation published after unavailability",
  );
  record("volatile-fast: held-lock bounded unavailability and expired resume has no ACK/mutation", {
    refused,
    expired,
    file,
    actualFreeze: false,
  });
}
async function renameControl(page: Page, other: Page, workspace: string, arm: Arm) {
  ok(await execute(page, { kind: "write", path: "/rename-old", text: "source" }));
  ok(await execute(page, { kind: "write", path: "/rename-new", text: "target" }));
  const original = await content(page, "/rename-old");
  const gate = "pending-rename";
  const request = await page.evaluate(
    (gate) =>
      proof.client.request({ kind: "rename", from: "/rename-old", to: "/rename-new" }, { gate }),
    gate,
  );
  const pending = submit(page, request);
  await waitParked(page, gate);
  if (arm !== "volatile-fast") {
    ok(await connected(other, workspace, arm, true));
    assert((await content(other, "/rename-old"))?.text === "source", "Partial pre-rename source");
    assert((await content(other, "/rename-new"))?.text === "target", "Partial pre-rename target");
  }
  await page.evaluate((gate) => proof.client.send({ kind: "release", gate }), gate);
  const result = await pending;
  if (arm !== "volatile-fast") {
    assert(result.kind === "error" && result.code === "FENCED", "Pending stale rename ACK");
    ok(await execute(other, { kind: "rename", from: "/rename-old", to: "/rename-new" }));
  } else ok(result);
  const active = arm === "volatile-fast" ? page : other;
  const renamed = await content(active, "/rename-new");
  assert((await content(active, "/rename-old")) === null, "Rename retained old namespace");
  assert(
    renamed?.id === original?.id &&
      renamed?.version === original?.version &&
      renamed?.text === "source",
    "Rename identity/version changed",
  );
  record(`${arm}: pending rename and atomic replacement identity`, { original, result, renamed });
}
async function droppedResponse(page: Page, other: Page, workspace: string, arm: Arm) {
  const request = await page.evaluate(() =>
    proof.client.request(
      { kind: "append", path: "/shared", text: "reply-lost\n" },
      { dropReply: true },
    ),
  );
  const missing = await submit(page, request);
  assert(missing.kind === "error" && missing.code === "UNAVAILABLE", "Response was not dropped");
  if (arm !== "volatile-fast") ok(await connected(other, workspace, arm, true));
  const active = arm === "volatile-fast" ? page : other;
  const current = await active.evaluate(() => proof.client.cursor);
  const retry = { ...request, epoch: current.epoch, dropReply: false };
  const repeated = ok(await submit(active, retry));
  const file = await content(active, "/shared");
  assert(file?.text.split("reply-lost\n").length === 2, "Dropped response retry duplicated append");
  const mismatch = await submit(active, {
    ...retry,
    operation: { kind: "append", path: "/shared", text: "wrong-payload" },
  });
  assert(
    mismatch.kind === "error" && mismatch.code === "OP_ID_CONFLICT",
    "Recovered identity payload mismatch accepted",
  );
  record(
    `${arm}: dropped reply resolves same receipt${arm === "volatile-fast" ? " in live memory" : " after authority replacement"}`,
    { missing, repeated, mismatch, file },
  );
}
async function lateReplyControl(old: Page, next: Page, workspace: string, arm: Arm): Promise<Page> {
  if (arm === "volatile-fast") return old;
  const gate = "late-read-reply";
  const request = await old.evaluate(
    (gate) => proof.client.request({ kind: "read", path: "/shared" }, { replyGate: gate }),
    gate,
  );
  const pending = submit(old, request);
  await waitParked(old, gate);
  ok(await connected(next, workspace, arm, true));
  ok(await execute(next, { kind: "append", path: "/shared", text: "before-late-read\n" }));
  await old.evaluate((gate) => proof.client.send({ kind: "release", gate }), gate);
  const staleRead = await pending;
  assert(
    staleRead.kind === "error" && staleRead.code === "FENCED",
    "Old admitted read ACKed after fenced replacement",
  );
  const writeGate = "late-write-reply";
  const write = await next.evaluate(
    (gate) =>
      proof.client.request(
        { kind: "append", path: "/shared", text: "committed-before-fence\n" },
        { replyGate: gate },
      ),
    writeGate,
  );
  const pendingWrite = submit(next, write);
  await waitParked(next, writeGate);
  const replacement = ok(await connected(old, workspace, arm, true));
  await next.evaluate((gate) => proof.client.send({ kind: "release", gate }), writeGate);
  const staleWrite = await pendingWrite;
  assert(
    staleWrite.kind === "error" && staleWrite.code === "FENCED",
    "Old committed write ACKed after replacement",
  );
  const recovered = ok(
    await submit(old, { ...write, epoch: replacement.cursor.epoch, replyGate: undefined }),
  );
  const file = await content(old, "/shared");
  assert(
    file?.text.split("committed-before-fence\n").length === 2,
    "Late write receipt duplicated",
  );
  record(`${arm}: admitted read/committed write parked before reply cannot emit stale ACK`, {
    staleRead,
    staleWrite,
    recovered,
    file,
    actualFreeze: false,
  });
  return old;
}
async function closeDrain(page: Page, next: Page, workspace: string, arm: Arm) {
  const gate = "drain-close";
  const request = await page.evaluate(
    (gate) =>
      proof.client.request(
        { kind: "append", path: "/shared", text: "drained-before-close\n" },
        { gate },
      ),
    gate,
  );
  const pending = submit(page, request);
  await waitParked(page, gate);
  const closing = page.evaluate(() => proof.client.send({ kind: "close" }));
  await page.evaluate((gate) => proof.client.send({ kind: "release", gate }), gate);
  const appended = ok(await pending),
    closed = ok(await closing);
  ok(await connected(next, workspace, arm));
  const file = await content(next, "/shared");
  assert(file?.text.endsWith("drained-before-close\n"), "Close lost queued append");
  assert(
    closed.cursor.durableWatermark === appended.cursor.watermark,
    "Close did not checkpoint drained cut",
  );
  record(`${arm}: graceful authority close drains queued append and reopens`, {
    appended: appended.cursor,
    closed: closed.cursor,
    file,
  });
}
async function lastClient(browser: Browser, engine: string, arm: Arm) {
  const context = await browser.newContext();
  const workspace = `waffle-e5-last-${arm}-${crypto.randomUUID()}`;
  try {
    const pages: Page[] = [];
    for (let index = 0; index < 4; index++) {
      const page = await context.newPage();
      pages.push(page);
      await page.goto(origin);
      ok(await connected(page, workspace, arm));
    }
    const first = pages[0];
    assert(first, "No last-client page");
    ok(await execute(first, { kind: "write", path: "/last", text: "checkpoint:" }));
    ok(await execute(first, { kind: "checkpoint" }));
    const before = ok(await execute(first, { kind: "append", path: "/last", text: "tail" }));
    for (const page of pages) await page.close();
    assert(context.pages().length === 0, "Not every attaching page closed");
    const reopened = await context.newPage();
    await reopened.goto(origin);
    const connection = ok(await connected(reopened, workspace, arm));
    const file = await content(reopened, "/last");
    const continuous = connection.cursor.epoch === before.cursor.epoch;
    if (arm === "fenced-safe" || continuous)
      assert(file?.text === "checkpoint:tail", "Acknowledged receipt lost on client close");
    if (arm === "volatile-fast" && !continuous) {
      assert(file?.text === "checkpoint:", "Volatile checkpoint not recovered");
      assert(connection.cursor.history !== before.cursor.history, "Volatile reset history reused");
    }
    const changes = ok(
      await execute(reopened, {
        kind: "changes",
        history: before.cursor.history,
        after: before.cursor.watermark,
      }),
    );
    if (arm === "volatile-fast" && !continuous)
      assert(
        changes.result &&
          typeof changes.result === "object" &&
          "kind" in changes.result &&
          changes.result.kind === "gap",
        "Missing reset gap",
      );
    record(`${engine}/${arm}: every attaching page closed then new page reopened`, {
      before: before.cursor,
      connection,
      continuous,
      file,
      changes,
      workerDeathProved: false,
    });
    ok(await reopened.evaluate(() => proof.client.send({ kind: "close" })));
  } finally {
    await context.close();
  }
}
function unobservedAfterDeadline(): Promise<string> {
  return new Promise((resolve) => setTimeout(() => resolve("NOT_OBSERVED"), 1000));
}
async function killAuthority(browser: Browser, workspace: string): Promise<unknown> {
  const cdp = await browser.newBrowserCDPSession();
  try {
    const before = await cdp.send("Target.getTargets");
    const target = before.targetInfos.find(
      (target) => target.type === "shared_worker" && target.url.includes(workspace),
    );
    assert(target, "SharedWorker target absent");
    const destroyed = Promise.withResolvers<string>();
    cdp.on(
      "Target.targetDestroyed",
      (event) => event.targetId === target.targetId && destroyed.resolve(event.targetId),
    );
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    const closed = await cdp.send("Target.closeTarget", { targetId: target.targetId });
    assert(closed.success, "Target.closeTarget refused");
    const after = await cdp.send("Target.getTargets");
    assert(
      !after.targetInfos.some((value) => value.targetId === target.targetId),
      "Authority target still live",
    );
    const event = await Promise.race([destroyed.promise, unobservedAfterDeadline()]);
    return {
      mechanism: "CDP Target.closeTarget shared_worker",
      target,
      destroyedEvent: event,
      absentAfter: true,
      applicationDrain: false,
    };
  } finally {
    await cdp.detach();
  }
}
async function deathControl(browser: Browser, engine: string, arm: Arm) {
  if (engine !== "chromium") {
    const outcome = {
      engine,
      arm,
      status: "NOT VERIFIED",
      label: "external SharedWorker target termination",
      reason: "No matching worker termination control implemented for this engine",
    };
    outcomes.push(outcome);
    console.log(JSON.stringify(outcome));
    return;
  }
  const context = await browser.newContext();
  const workspace = `waffle-e5-death-${arm}-${crypto.randomUUID()}`;
  try {
    const old = await context.newPage(),
      replacement = await context.newPage();
    await old.goto(origin);
    await replacement.goto(origin);
    ok(await connected(old, workspace, arm));
    ok(await connected(replacement, workspace, arm));
    ok(await execute(old, { kind: "write", path: "/shared", text: "checkpoint:" }));
    ok(await execute(old, { kind: "checkpoint" }));
    const tailRequest = await old.evaluate(() =>
      proof.client.request({ kind: "append", path: "/shared", text: "acknowledged-tail" }),
    );
    const tail = ok(await submit(old, tailRequest));
    const lostRequest = await old.evaluate(() =>
      proof.client.request(
        { kind: "append", path: "/shared", text: ":lost-reply" },
        { dropReply: true },
      ),
    );
    const lost = await submit(old, lostRequest);
    assert(
      lost.kind === "error" && lost.code === "UNAVAILABLE",
      "Death control response was not dropped",
    );
    const stored = ok(
      await execute(old, { kind: "status", key: `${lostRequest.client}:${lostRequest.sequence}` }),
    );
    assert(stored.result !== null, "Dropped response has no live receipt");
    const gate = "death-pending";
    const pendingRequest = await old.evaluate(
      (gate) =>
        proof.client.request({ kind: "append", path: "/shared", text: "not-acked" }, { gate }),
      gate,
    );
    const pending = submit(old, pendingRequest);
    await waitParked(old, gate);
    const kill = await killAuthority(browser, workspace);
    const unresolved = await pending;
    assert(
      unresolved.kind === "error" && unresolved.code === "UNAVAILABLE",
      "Killed request falsely ACKed",
    );
    const next = ok(await connected(replacement, workspace, arm, true));
    const file = await content(replacement, "/shared");
    assert(file && !file.text.includes("not-acked"), "Pending mutation escaped death");
    if (arm === "volatile-fast") {
      assert(
        file.text === "checkpoint:",
        "Volatile recovery lost checkpoint or kept volatile tail",
      );
      assert(next.cursor.history !== tail.cursor.history, "Volatile history did not reset");
      const unknown = await submit(replacement, {
        ...lostRequest,
        epoch: next.cursor.epoch,
        dropReply: false,
      });
      assert(
        unknown.kind === "error" && unknown.code === "OUTCOME_UNKNOWN",
        "Volatile tail silently replayed",
      );
      const gap = ok(
        await execute(replacement, {
          kind: "changes",
          history: tail.cursor.history,
          after: tail.cursor.watermark,
        }),
      );
      assert(
        gap.result &&
          typeof gap.result === "object" &&
          "kind" in gap.result &&
          gap.result.kind === "gap",
        "Missing volatile recovery gap",
      );
      record(`${arm}: actual worker target death, checkpoint recovery, explicit unknown/gap`, {
        kill,
        tail: tail.cursor,
        lost,
        stored,
        unresolved,
        next,
        file,
        unknown,
        gap,
      });
    } else {
      assert(
        file.text === "checkpoint:acknowledged-tail:lost-reply",
        "IDB acknowledged tail missing after worker termination",
      );
      const repeated = ok(
        await submit(replacement, { ...lostRequest, epoch: next.cursor.epoch, dropReply: false }),
      );
      assert(
        JSON.stringify(repeated.result) === JSON.stringify(stored.result),
        "Persisted receipt changed",
      );
      record(
        `${arm}: actual worker target death recovers acknowledged receipt without duplicate append`,
        { kill, tail: tail.cursor, lost, stored, unresolved, next, file, repeated },
      );
    }
    ok(await replacement.evaluate(() => proof.client.send({ kind: "close" })));
  } finally {
    await context.close();
  }
}
async function productionControl(browser: Browser, engine: string): Promise<void> {
  const context = await browser.newContext();
  try {
    const owner = await context.newPage(),
      follower = await context.newPage();
    await owner.goto(origin);
    await follower.goto(origin);
    const workspace = `waffle-e5-production-${crypto.randomUUID()}`;
    await owner.evaluate((workspace) => proof.productionOpen(workspace), workspace);
    await owner.evaluate(() => proof.productionWrite());
    await follower.evaluate((workspace) => proof.productionOpen(workspace), workspace);
    await follower.waitForFunction(() => proof.productionState() === "waiting", undefined, {
      timeout: 3000,
    });
    await owner.evaluate(() => proof.productionClose());
    const read = await follower.evaluate(() => proof.productionRead());
    assert(read === "current-production", "Production reopen data lost");
    await follower.evaluate(() => proof.productionClose());
    record(`${engine}: unchanged production exclusive wait/reopen control`, {
      read,
      simultaneousWriters: false,
    });
  } finally {
    await context.close();
  }
}
async function armControl(browser: Browser, arm: Arm): Promise<void> {
  const context = await browser.newContext();
  const workspace = `waffle-e5-${arm}-${crypto.randomUUID()}`;
  const pages: Page[] = [];
  try {
    for (let index = 0; index < 4; index++) {
      const page = await context.newPage();
      pages.push(page);
      await page.goto(origin);
    }
    const connections = await Promise.all(pages.map((page) => connected(page, workspace, arm)));
    for (const connection of connections) ok(connection);
    await firstControl(pages, arm);
    const active = pages[1];
    assert(active, "Missing active page");
    await duplicateControl(active, arm);
    await guestControl(active, arm);
    await streamControl(active, arm);
    const second = pages[2],
      third = pages[3];
    assert(second && third, "Missing lifecycle pages");
    await staleControl(active, second, workspace, arm);
    const afterStale = arm === "volatile-fast" ? active : second;
    await renameControl(afterStale, third, workspace, arm);
    const afterRename = arm === "volatile-fast" ? active : third;
    await droppedResponse(afterRename, second, workspace, arm);
    const final = arm === "volatile-fast" ? active : second;
    const authoritative = await lateReplyControl(final, afterRename, workspace, arm);
    console.log(
      JSON.stringify({
        arm,
        authority: await authoritative.evaluate(() => proof.client.send({ kind: "inspect" })),
      }),
    );
    await closeDrain(authoritative, afterRename, workspace, arm);
    ok(await afterRename.evaluate(() => proof.client.send({ kind: "close" })));
  } finally {
    await context.close();
  }
}
async function runArmSequence(browser: Browser, engine: string, arm: Arm) {
  try {
    await armControl(browser, arm);
    await lastClient(browser, engine, arm);
    await deathControl(browser, engine, arm);
  } catch (error) {
    const result = { engine, arm, status: "FAILED", error: String(error) };
    outcomes.push(result);
    console.error(JSON.stringify(result));
  }
}
async function browserControl(engine: keyof typeof engines): Promise<void> {
  activeEngine = engine;
  const browser = await lifecycle.launch(engine);
  console.log(
    JSON.stringify({
      kind: "browser-environment",
      engine,
      version: browser.version(),
      source: "E5 proof",
    }),
  );
  try {
    await productionControl(browser, engine);
    for (const arm of ["fenced-safe", "fenced-fast", "volatile-fast"] as const)
      await runArmSequence(browser, engine, arm);
  } finally {
    await lifecycle.closeBrowser(browser);
  }
}
try {
  await lifecycle.init();
  const routes: Record<string, Blob | string> = {
    "/": '<!doctype html><title>Experimental E5 filesystem proof</title><script type="module" src="/page.js"></script>',
  };
  for (const entry of ["page", "authority", "guest"])
    routes[`/${entry}.js`] = await browserBundle(`tests/vfs-coordinator-proof/${entry}.ts`);
  routes["/fs-worker.js"] = await browserBundle("browser/fs-worker.ts");
  const port = Number(process.env.E5_PORT ?? "43187");
  origin = lifecycle.serve(routes, port);
  const requested = process.argv.slice(2);
  for (const engine of ["chromium", "firefox", "webkit"] as const)
    if (!requested.length || requested.includes(engine)) await browserControl(engine);
  console.log(JSON.stringify({ kind: "E5_RESULT", outcomes }));
  if (
    outcomes.some(
      (entry) =>
        entry && typeof entry === "object" && "status" in entry && entry.status === "FAILED",
    )
  )
    process.exitCode = 1;
} finally {
  await lifecycle.close();
}
