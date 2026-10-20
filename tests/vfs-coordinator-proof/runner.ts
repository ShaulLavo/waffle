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
  return page.evaluate(({ operation, options }) => proof.client.execute(operation, options), { operation, options });
}
async function connected(page: Page, workspace: string, arm: Arm, replace = false) {
  return page.evaluate(({ workspace, arm, replace }) => proof.client.connect(workspace, arm, replace), { workspace, arm, replace });
}
async function content(page: Page, path: string): Promise<{ id: number; version: number; text: string } | null> {
  const reply = ok(await execute(page, { kind: "read", path }));
  const value = reply.result;
  if (value === null) return null;
  assert(value && typeof value === "object" && "text" in value && typeof value.text === "string" &&
    "id" in value && typeof value.id === "number" && "version" in value && typeof value.version === "number", "Invalid read");
  return { id: value.id, version: value.version, text: value.text };
}
function record(label: string, detail: unknown): void {
  const result = { engine: activeEngine, label, status: "VERIFIED", detail };
  outcomes.push(result); console.log(JSON.stringify(result));
}
async function firstControl(pages: Page[], arm: Arm) {
  const [first, second] = pages;
  assert(first && second, "Four pages required");
  ok(await execute(first, { kind: "write", path: "/shared", text: "" }));
  const replies = await Promise.all(pages.map((page, index) => execute(page,
    { kind: "append", path: "/shared", text: `tab-${index}\n` })));
  const cuts = replies.map((reply) => ok(reply).cursor);
  assert(new Set(cuts.map((cut) => cut.epoch)).size === 1, "Split authority epoch");
  assert(new Set(cuts.map((cut) => cut.watermark)).size === 4, "Lost commit order");
  const reads = await Promise.all(pages.map((page) => content(page, "/shared")));
  for (const value of reads) assert(value && value.text.trim().split("\n").sort().join(",") === "tab-0,tab-1,tab-2,tab-3", "Four-writer coherence");
  assert(new Set(reads.map((value) => value?.id)).size === 1, "File identity diverged");
  record(`${arm}: four independently created writer/tool tabs`, { cuts, reads });
  await first.close();
  ok(await execute(second, { kind: "append", path: "/shared", text: "after-first-close\n" }));
  assert((await content(second, "/shared"))?.text.endsWith("after-first-close\n"), "First-page close broke authority");
  record(`${arm}: first attaching tab closed, other writers live`, { remaining: 3 });
}
async function duplicateControl(page: Page, arm: Arm) {
  const request = await page.evaluate(() => proof.client.request({ kind: "append", path: "/shared", text: "once\n" }));
  const one = await page.evaluate((request) => proof.client.submit(request), request);
  const two = await page.evaluate((request) => proof.client.submit(request), request);
  assert(JSON.stringify(one) === JSON.stringify(two), "Duplicate receipt changed");
  const conflict = { ...request, operation: { kind: "append", path: "/shared", text: "different\n" } } satisfies Request;
  const mismatch = await page.evaluate((request) => proof.client.submit(request), conflict);
  assert(mismatch.kind === "error" && mismatch.code === "OP_ID_CONFLICT", "Mismatched duplicate accepted");
  assert((await content(page, "/shared"))?.text.split("once\n").length === 2, "Append duplicated");
  record(`${arm}: repeated operation identity and payload mismatch`, { one, two, mismatch });
}
async function guestControl(page: Page, arm: Arm) {
  ok(await execute(page, { kind: "write", path: "/guest", text: "host:" }));
  const result = await page.evaluate(() => proof.runGuest("/guest", "wasm"));
  assert(result && typeof result === "object" && "kind" in result && result.kind === "guest-complete", `Guest did not complete: ${JSON.stringify(result)}`);
  assert(await content(page, "/guest") === null, "Guest rename left source");
  const file = await content(page, "/guest.guest");
  assert(file?.text === "host:wasm", "Guest append or rename missing");
  record(`${arm}: actual Wasm through production WASI append and rename`, { result, file });
}
async function streamControl(page: Page, arm: Arm) {
  const snapshot = ok(await execute(page, { kind: "snapshot" }));
  const before = await page.evaluate(() => proof.client.nudges);
  ok(await execute(page, { kind: "append", path: "/shared", text: "dropped-final-nudge\n" }, { dropNudge: true, actor: "tool" }));
  const after = await page.evaluate(() => proof.client.nudges);
  const changes = ok(await execute(page, { kind: "changes", history: snapshot.cursor.history, after: snapshot.cursor.watermark }));
  assert(before === after, "Final notification was not dropped");
  const value = changes.result;
  assert(value && typeof value === "object" && "kind" in value && value.kind === "batch" && "changes" in value && Array.isArray(value.changes) && value.changes.length === 1, "Snapshot/stream missed final change");
  record(`${arm}: snapshot-to-stream handoff with dropped final nudge`, { snapshot: snapshot.cursor, changes });
}
async function waitParked(page: Page, gate: string): Promise<void> {
  await page.waitForFunction(async (gate) => {
    const reply = await proof.client.send({ kind: "inspect" });
    return reply.kind === "ok" && JSON.stringify(reply.result).includes(`"gate":"${gate}"`);
  }, gate, { timeout: 2500 });
}
async function submit(page: Page, request: Request): Promise<Reply> {
  return page.evaluate((request) => proof.client.submit(request), request);
}
async function staleControl(old: Page, replacement: Page, workspace: string, arm: Arm) {
  const gate = "pending-append";
  const request = await old.evaluate((gate) => proof.client.request({ kind: "append", path: "/shared", text: "pending-old\n" }, { gate }), gate);
  const pending = submit(old, request);
  await waitParked(old, gate);
  const replaced = await connected(replacement, workspace, arm, true);
  if (arm === "volatile-fast") {
    assert(replaced.kind === "error" && replaced.code === "UNAVAILABLE", "Stole volatile lock");
    await old.evaluate((gate) => proof.client.send({ kind: "release", gate }), gate);
    ok(await pending);
    const after = ok(await execute(old, { kind: "read", path: "/shared" }));
    assert(after.cursor.epoch === request.epoch, "Volatile authority changed despite held lock");
    record(`${arm}: parked lock holder refuses suspicion takeover, resumes same authority`, { replaced, after: after.cursor });
    return;
  }
  ok(replaced);
  ok(await execute(replacement, { kind: "append", path: "/shared", text: "successor\n" }));
  await old.evaluate((gate) => proof.client.send({ kind: "release", gate }), gate);
  const resumed = await pending;
  const staleRead = await execute(old, { kind: "read", path: "/shared" });
  const staleWrite = await execute(old, { kind: "append", path: "/shared", text: "stale-new\n" });
  for (const reply of [resumed, staleRead, staleWrite]) assert(reply.kind === "error" && reply.code === "FENCED", "Stale authority read or ACK");
  const file = await content(replacement, "/shared");
  assert(file && !file.text.includes("pending-old") && !file.text.includes("stale-new"), "Stale publication escaped fence");
  record(`${arm}: pending append, stale-resume, new stale mutation and read fenced`, { replaced, resumed, staleRead, staleWrite, file });
}
async function renameControl(page: Page, other: Page, workspace: string, arm: Arm) {
  ok(await execute(page, { kind: "write", path: "/rename-old", text: "source" }));
  ok(await execute(page, { kind: "write", path: "/rename-new", text: "target" }));
  const original = await content(page, "/rename-old");
  const gate = "pending-rename";
  const request = await page.evaluate((gate) => proof.client.request({ kind: "rename", from: "/rename-old", to: "/rename-new" }, { gate }), gate);
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
  assert(await content(active, "/rename-old") === null, "Rename retained old namespace");
  assert(renamed?.id === original?.id && renamed?.version === original?.version && renamed?.text === "source", "Rename identity/version changed");
  record(`${arm}: pending rename and atomic replacement identity`, { original, result, renamed });
}
async function droppedResponse(page: Page, other: Page, workspace: string, arm: Arm) {
  const request = await page.evaluate(() => proof.client.request({ kind: "append", path: "/shared", text: "reply-lost\n" }, { dropReply: true }));
  const missing = await submit(page, request);
  assert(missing.kind === "error" && missing.code === "UNAVAILABLE", "Response was not dropped");
  if (arm !== "volatile-fast") ok(await connected(other, workspace, arm, true));
  const active = arm === "volatile-fast" ? page : other;
  const current = await active.evaluate(() => proof.client.cursor);
  const retry = { ...request, epoch: current.epoch, history: current.history, dropReply: false };
  const repeated = ok(await submit(active, retry));
  const file = await content(active, "/shared");
  assert(file?.text.split("reply-lost\n").length === 2, "Dropped response retry duplicated append");
  record(`${arm}: dropped reply resolves same receipt${arm === "volatile-fast" ? " in live memory" : " after authority replacement"}`, { missing, repeated, file });
}
async function productionControl(browser: Browser, engine: string): Promise<void> {
  const context = await browser.newContext();
  try {
    const owner = await context.newPage(), follower = await context.newPage();
    await owner.goto(origin); await follower.goto(origin);
    const workspace = `waffle-e5-production-${crypto.randomUUID()}`;
    await owner.evaluate((workspace) => proof.productionOpen(workspace), workspace);
    await owner.evaluate(() => proof.productionWrite());
    await follower.evaluate((workspace) => proof.productionOpen(workspace), workspace);
    await follower.waitForFunction(() => proof.productionState() === "waiting", undefined, { timeout: 3000 });
    await owner.evaluate(() => proof.productionClose());
    const read = await follower.evaluate(() => proof.productionRead());
    assert(read === "current-production", "Production reopen data lost");
    await follower.evaluate(() => proof.productionClose());
    record(`${engine}: unchanged production exclusive wait/reopen control`, { read, simultaneousWriters: false });
  } finally { await context.close(); }
}
async function armControl(browser: Browser, arm: Arm): Promise<void> {
  const context = await browser.newContext();
  const workspace = `waffle-e5-${arm}-${crypto.randomUUID()}`;
  const pages: Page[] = [];
  try {
    for (let index = 0; index < 4; index++) { const page = await context.newPage(); pages.push(page); await page.goto(origin); }
    const connections = await Promise.all(pages.map((page) => connected(page, workspace, arm)));
    for (const connection of connections) ok(connection);
    await firstControl(pages, arm);
    const active = pages[1]; assert(active, "Missing active page");
    await duplicateControl(active, arm);
    await guestControl(active, arm);
    await streamControl(active, arm);
    const second = pages[2], third = pages[3]; assert(second && third, "Missing lifecycle pages");
    await staleControl(active, second, workspace, arm);
    const afterStale = arm === "volatile-fast" ? active : second;
    await renameControl(afterStale, third, workspace, arm);
    const afterRename = arm === "volatile-fast" ? active : third;
    await droppedResponse(afterRename, second, workspace, arm);
    const final = arm === "volatile-fast" ? active : second;
    console.log(JSON.stringify({ arm, authority: await final.evaluate(() => proof.client.send({ kind: "inspect" })) }));
    ok(await final.evaluate(() => proof.client.send({ kind: "close" })));
  } finally { await context.close(); }
}
async function browserControl(engine: keyof typeof engines): Promise<void> {
  activeEngine = engine;
  const browser = await lifecycle.launch(engine);
  try {
    await productionControl(browser, engine);
    for (const arm of ["fenced-safe", "fenced-fast", "volatile-fast"] as const) {
      try { await armControl(browser, arm); }
      catch (error) { const result = { engine, arm, status: "FAILED", error: String(error) }; outcomes.push(result); console.error(JSON.stringify(result)); }
    }
  } finally { await lifecycle.closeBrowser(browser); }
}
try {
  await lifecycle.init();
  const routes: Record<string, Blob | string> = { "/": '<!doctype html><title>Experimental E5 filesystem proof</title><script type="module" src="/page.js"></script>' };
  for (const entry of ["page", "authority", "guest"]) routes[`/${entry}.js`] = await browserBundle(`tests/vfs-coordinator-proof/${entry}.ts`);
  routes["/fs-worker.js"] = await browserBundle("browser/fs-worker.ts");
  const port = Number(process.env.E5_PORT ?? "43187");
  origin = lifecycle.serve(routes, port);
  const requested = process.argv.slice(2);
  for (const engine of ["chromium", "firefox", "webkit"] as const) if (!requested.length || requested.includes(engine)) await browserControl(engine);
  console.log(JSON.stringify({ kind: "E5_RESULT", outcomes }));
  if (outcomes.some((entry) => entry && typeof entry === "object" && "status" in entry && entry.status === "FAILED")) process.exitCode = 1;
} finally { await lifecycle.close(); }
