import { resolve } from "node:path";
import { BrowserRunnerLifecycle, browserBundle } from "./browser-runner-lifecycle";
import type { Page } from "playwright";

const lifecycle = new BrowserRunnerLifecycle(180_000);
function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
async function control(page: Page, operation: string, value?: unknown): Promise<unknown> {
  return page.evaluate(async ({ operation, value }) => {
    const path = "/cross-tab.js";
    const module: typeof import("./publication-cross-tab-browser") = await import(path);
    return module.control(operation, value);
  }, { operation, value });
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("missing result");
  return Object.fromEntries(Object.entries(value));
}
async function observeDeaths(page: Page): Promise<void> {
  const deaths = new Map<string, Promise<void>>();
  page.on("worker", (worker) => {
    const closed = Promise.withResolvers<void>();
    worker.once("close", () => closed.resolve());
    deaths.set(worker.url(), closed.promise);
  });
  await page.exposeFunction("__publicationWaitForClose", async (url: string) => {
    const death = deaths.get(url);
    if (!death) throw new Error(`Worker not observed natively ${url}`);
    await death;
  });
}
async function run(name: string, origin: string): Promise<void> {
  if (name !== "chromium" && name !== "firefox" && name !== "webkit") throw new Error(`unknown engine ${name}`);
  const browser = await lifecycle.launch(name);
  try {
    const context = await browser.newContext();
    const first = await context.newPage(), second = await context.newPage();
    for (const page of [first, second]) {
      page.on("console", (message) => console.log(message.text()));
      page.on("pageerror", (error) => console.error(error));
      await observeDeaths(page);
      await page.goto(origin);
    }
    const descriptor = await control(first, "authority", `resident-${crypto.randomUUID()}`);
    equal(await control(second, "peer", descriptor), { attached: true, authorityRootReceived: false });
    await control(first, "startGuest", "wasi");
    await control(second, "startGuest", "proc");
    const initial = record(await control(first, "authorityInspect"));
    equal(initial.count, 3);
    const failed = record(await control(second, "call", { mode: "proc", request: { kind: "write", bytes: [8] } }));
    equal(failed.result, -6); equal(failed.offset, 0); equal(failed.bytes, [8]);
    await control(second, "prepare", { mode: "proc", request: { kind: "write", offset: 0, maxBytes: 1 } });
    equal(await control(first, "authorityBypass"), { read: -6, write: -6, namespace: 6, lock: 0 });
    const write = record(await control(second, "call", { mode: "proc", request: { kind: "write", bytes: [9] } }));
    equal(write.result, 1); equal(write.offset, 1);
    equal(record(await control(first, "authorityInspect")).count, -6);
    // No settle/nudge is sent after ACK. The next request must query the old cell.
    await control(second, "prepare", { mode: "proc", request: { kind: "append", maxBytes: 2 } });
    const append = record(await control(second, "call", { mode: "proc", request: { kind: "append", bytes: [4, 5] } }));
    equal(append.result, 2); equal(append.offset, 5);
    equal(record(await control(first, "authorityInspect")).count, -6);
    await control(first, "prepare", { mode: "wasi", request: { kind: "read", offset: 0, maxBytes: 5 } });
    const read = record(await control(first, "call", { mode: "wasi", request: { kind: "read", offset: 0, bytes: [80, 80, 80, 80, 80] } }));
    equal(read.result, 0); equal(read.count, 5); equal(read.bytes, [9, 2, 3, 4, 5]); equal(read.offset, 5);
    await control(first, "settle", { mode: "wasi" });
    const repeat = await control(second, "settle", { mode: "proc" });
    equal(await control(second, "settle", { mode: "proc" }), repeat);
    const final = record(await control(first, "authorityInspect"));
    equal(final.count, 5); equal(record(final.cut).generation, 2);
    const changes = record(await control(first, "changes", initial.cut));
    equal(changes.kind, "changes");
    if (!Array.isArray(changes.publications)) throw new Error("missing complete groups");
    equal(changes.publications.length, 2);
    for (let index = 0; index < changes.publications.length; index++) {
      const group = record(changes.publications[index]), receipt = record(group.receipt);
      equal(record(receipt.cut).generation, index + 1);
      equal(record(receipt.cut).history, record(initial.cut).history);
      equal(record(receipt.id).sequence, index + 1);
      equal(receipt.durability, { kind: "untracked" });
      if (!Array.isArray(group.changes)) throw new Error("missing complete effects");
      equal(group.changes.length, 2);
      equal(group.changes.map((effect) => record(effect).kind), ["bytes", "metadata"]);
    }
    equal(record(record(record(changes.publications[1]).receipt).result), { kind: "append", written: 2, offset: 5 });
    console.log("PASS independent pages, real runtime_proc writes/append and Preview1 current read, no root SAB transfer, no commit nudge, exact two groups");
    equal(await control(first, "lateAttachment"), { accepted: false, count: 1, bytes: [9] });
    console.log("PASS late open cancellation joins exact session cleanup without detaching successor");
    equal(await control(first, "oldSettlement"), { denied: true, queries: 1, current: "ready" });
    console.log("PASS duplicate old cancellation cannot erase the next READY grant from transport status tracking");
    equal(await control(first, "queuedAttachment"), { accepted: false, joined: true });
    equal(record(await control(first, "cancelledStartup")).setupCount, 0);
    console.log("PASS queued acquisition cancellation joins cleanup and actual cancelled bootstrap never reaches setup");
    await control(first, "stopGuest", { mode: "wasi" });
    await control(second, "prepare", { mode: "proc", request: { kind: "write", offset: 5, maxBytes: 1 } });
    await control(second, "armClaim", { mode: "proc", request: { kind: "write", bytes: [7] } });
    await control(first, "pageStop"); await control(second, "pageStop");
    equal(await control(first, "authorityDeath"), { observedNativeDeath: true });
    equal(await control(first, "exclusive"), false);
    // A live frozen worker alone holds continuity, including across a replacement epoch.
    await new Promise((resolve) => setTimeout(resolve, 3200));
    equal(await control(first, "exclusive"), false);
    equal(await control(second, "guestDeath", { mode: "proc" }), { observedNativeDeath: true });
    equal(await control(first, "exclusive"), true);
    console.log("PASS CLAIMED live worker blocks exclusive continuity after creator authority death and timeout; separate native worker death releases guard");
    await context.close();
    console.log(`${name} ${browser.version()}: focused resident grant pilot controls passed`);
  } finally { await lifecycle.closeBrowser(browser); }
}
try {
  await lifecycle.init();
  const origin = lifecycle.serve({ "/": "<!doctype html><title>Private resident controls</title>",
    "/cross-tab.js": await browserBundle(resolve(import.meta.dir, "publication-cross-tab-browser.ts")),
    "/resident-authority.js": await browserBundle(resolve(import.meta.dir, "fixtures/publication-resident-authority.ts")),
    "/resident-guest.js": await browserBundle(resolve(import.meta.dir, "fixtures/publication-resident-guest.ts")) });
  const names = process.argv.slice(2);
  for (const name of names.length ? names : ["chromium"]) await run(name, origin);
} finally { await lifecycle.close(); }
