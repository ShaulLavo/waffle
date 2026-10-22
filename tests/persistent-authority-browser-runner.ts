import { resolve } from "node:path";
import type { Browser, Page, Worker } from "playwright";
import { BrowserRunnerLifecycle, browserBundle } from "./browser-runner-lifecycle";
import type { PublicationCut } from "../fs/publication";

const lifecycle = new BrowserRunnerLifecycle(180_000);
const negative = process.argv.includes("--negative-control");
const deadWorkers = new WeakSet<Worker>();
const roots = new WeakMap<Page, unknown>();
const reportPath = process.env.PERSISTENT_AUTHORITY_REPORT;
const schedule = [
  "four independent pages",
  "native persistent factory and peers",
  "seed and actual guest bootstrap",
  "host append and other-page read after ACK",
  "runtime_proc append ACK without final settlement nudge",
  "other-page current read imports missing nudge",
  "host replacement rename and coherent namespace",
  "WASI append and runtime_proc current read",
  "explicit append identity and replay",
  "WASI rename and complete ordered effects",
  "completed flush",
  "original client cleanup",
  "actual authority stop and observed native worker death",
  "v1 reopen resets history and old outcomes",
  "stale descriptor rejection",
  "saved bytes and namespace through new peers",
  "reopened owner stop and database deletion",
];
type Step =
  | { name: string; kind: "unrun" }
  | { name: string; kind: "completed"; value: unknown }
  | { name: string; kind: "failed"; failure: string };
const steps: Step[] = schedule.map((name) => ({ name, kind: "unrun" }));
const evidence: Record<string, unknown> = {
  negativeControl: negative,
  base: "c69fece24599a1ce97422583d081be394b29b341",
};
function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("missing record");
  return Object.fromEntries(Object.entries(value));
}
async function step(name: string, action: () => Promise<unknown>): Promise<void> {
  const index = schedule.indexOf(name);
  if (index < 0 || steps[index]?.kind !== "unrun") throw new Error(`invalid step ${name}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const budget = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`step deadline: ${name}`)), 15_000);
    });
    const value = await Promise.race([action(), budget]);
    steps[index] = { name, kind: "completed", value: value ?? null };
    console.log(`PASS ${name}`);
  } catch (error) {
    steps[index] = { name, kind: "failed", failure: String(error) };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
async function control(page: Page, operation: string, value?: unknown): Promise<unknown> {
  return page.evaluate(
    async ({ operation, value }) => {
      const path = "/persistent.js";
      const module: typeof import("./persistent-authority-browser") = await import(path);
      return module.control(operation, value);
    },
    { operation, value },
  );
}
async function host(page: Page, operation: string, args: unknown[] = [], bytes?: number[]) {
  try {
    return await control(page, "workspacePage", { operation, args, bytes });
  } catch (cause) {
    throw new Error(`page workspace ${operation} ${JSON.stringify(args)}`, { cause });
  }
}
function guest(page: Page, key: "wasi" | "proc", operation: string, request?: unknown) {
  return control(page, "workspaceGuestCall", { key, operation, request });
}
async function read(page: Page, path: string, expected: readonly number[]): Promise<void> {
  const root = roots.get(page);
  if (root === undefined) throw new Error("page root was not opened");
  const file = record(await host(page, "resolve", [root, path]));
  equal(await host(page, "read", [file.node, expected.length + 2, 0]), expected);
  equal(record(await host(page, "stat", [file.node])).size, expected.length);
}
async function absent(page: Page, path: string): Promise<void> {
  const root = roots.get(page);
  if (root === undefined) throw new Error("page root was not opened");
  equal(record(await host(page, "resolve", [root, path])).node, undefined);
}
async function observeDeaths(page: Page): Promise<() => Worker> {
  const deaths = new Map<string, Promise<void>>();
  let authority: Worker | undefined;
  page.on("worker", (worker) => {
    const closed = Promise.withResolvers<void>();
    worker.once("close", () => {
      deadWorkers.add(worker);
      closed.resolve();
    });
    deaths.set(worker.url(), closed.promise);
    if (new URL(worker.url()).pathname === "/resident-authority.js") authority = worker;
  });
  await page.exposeFunction("__publicationWaitForClose", async (url: string) => {
    const death = deaths.get(url);
    if (!death) throw new Error(`native worker not observed ${url}`);
    await death;
  });
  return () => {
    if (!authority) throw new Error("actual authority worker missing");
    return authority;
  };
}
async function inspect(worker: Worker, operation: string, body?: unknown): Promise<unknown> {
  return worker.evaluate(
    async ({ operation, body }) => {
      const observe: unknown = Reflect.get(globalThis, "__persistentAuthorityProof");
      if (typeof observe !== "function") throw new Error("factory root observer missing");
      const value: unknown = await observe(operation, body);
      return value;
    },
    { operation, body },
  );
}
function cut(value: unknown): PublicationCut {
  const data = record(value);
  if (typeof data.history !== "string" || typeof data.generation !== "number")
    throw new Error("missing publication cut");
  return { history: data.history, generation: data.generation };
}
async function appendGuest(page: Page, key: "wasi" | "proc", byte: number): Promise<unknown> {
  if (key === "proc") await guest(page, key, "prepare", { kind: "append", maxBytes: 1 });
  const ack = record(await guest(page, key, "call", { kind: "append", bytes: [byte] }));
  equal(ack.result, key === "wasi" ? 0 : 1);
  if (key === "wasi") equal(ack.count, 1);
  return ack;
}
function completeEffects(value: unknown, before: PublicationCut): Record<string, unknown>[] {
  const changes = record(value);
  equal(changes.kind, "changes");
  if (!Array.isArray(changes.publications)) throw new Error("missing complete publications");
  const groups = changes.publications.map(record);
  equal(groups.length, 6);
  const kinds = [
    ["bytes", "metadata"],
    ["bytes", "metadata"],
    ["entry", "entry", "metadata"],
    ["bytes", "metadata"],
    ["bytes", "metadata"],
    ["entry", "entry", "metadata"],
  ];
  const identities = new Set<string>();
  for (const [index, group] of groups.entries()) {
    const receipt = record(group.receipt);
    equal(receipt.cut, { history: before.history, generation: before.generation + index + 1 });
    equal(receipt.durability, { kind: "untracked" });
    identities.add(JSON.stringify(receipt.id));
    if (!Array.isArray(group.changes)) throw new Error("missing atomic effects");
    equal(
      group.changes.map((effect) => record(effect).kind),
      kinds[index],
    );
  }
  equal(identities.size, 6);
  equal(changes.next, { history: before.history, generation: before.generation + 6 });
  return groups;
}
function appendEffects(group: Record<string, unknown>, offset: number, bytes: number[]) {
  if (!Array.isArray(group.changes)) throw new Error("missing append group");
  const data = record(group.changes[0]);
  const metadata = record(group.changes[1]);
  equal(data.offset, offset);
  equal(data.bytes, Object.fromEntries(bytes.map((byte, index) => [index, byte])));
  equal(data.size, offset + bytes.length);
  equal(metadata.file, data.file);
  equal(typeof metadata.mode, "number");
  equal(typeof metadata.mtime, "number");
  if (typeof data.version !== "number") throw new Error("missing content version");
  return { file: data.file, version: data.version };
}
function renameEffects(
  group: Record<string, unknown>,
  from: string,
  to: string,
  replacement: boolean,
) {
  if (!Array.isArray(group.changes)) throw new Error("missing rename group");
  const entries = group.changes.map(record);
  const removed = entries.find((entry) => entry.name === from);
  const added = entries.find((entry) => entry.name === to);
  if (!removed || !added) throw new Error("partial rename effects");
  equal(removed.after, null);
  equal(added.after, removed.before);
  equal(added.parent, removed.parent);
  equal(added.before === null, !replacement);
  const metadata = entries.find((entry) => entry.kind === "metadata");
  if (!metadata) throw new Error("missing parent metadata effect");
  equal(metadata.file, added.parent);
  equal(typeof metadata.mode, "number");
  equal(typeof metadata.mtime, "number");
  return removed.before;
}
async function stopped(page: Page): Promise<unknown> {
  const stop = record(await control(page, "persistentStop"));
  equal(stop.stopped, true);
  equal(stop.same, true);
  if (!Array.isArray(stop.events)) throw new Error("native close events missing");
  const physical = stop.events.lastIndexOf("native-db-closed");
  const released = stop.events.lastIndexOf("guard-released");
  if (physical < 0 || released <= physical) throw new Error("guard released before native close");
  return stop;
}
async function scenario(browser: Browser, origin: string): Promise<void> {
  const context = await browser.newContext();
  try {
    await history(context, origin);
  } finally {
    await context.close();
  }
}
async function history(
  context: Awaited<ReturnType<Browser["newContext"]>>,
  origin: string,
): Promise<void> {
  const a = await context.newPage(),
    b = await context.newPage();
  const c = await context.newPage(),
    d = await context.newPage();
  const pages = [a, b, c, d];
  const authority = await observeDeaths(a);
  await observeDeaths(b);
  await observeDeaths(c);
  await observeDeaths(d);
  await step(schedule[0]!, async () => {
    for (const page of pages) {
      await page.goto(origin);
      equal(await page.opener(), null);
      equal(await page.evaluate(() => crossOriginIsolated), true);
    }
    return { pages: pages.length, independentTopLevel: true };
  });
  const name = `waffle-fourpage-${crypto.randomUUID()}`;
  let ready: Record<string, unknown> = {};
  await step(schedule[1]!, async () => {
    const started = record(
      await control(a, "persistentStart", {
        name,
        runtimeLifetime: crypto.randomUUID(),
        attempt: crypto.randomUUID(),
      }),
    );
    equal(started.ready, true);
    ready = record(started.value);
    equal(record(record(ready.request).selected).implementation, "indexeddb");
    for (const page of pages) {
      await control(page, "workspacePeer", ready.descriptor);
      roots.set(page, await host(page, "preopen", ["/"]));
    }
    return started;
  });
  let initial: PublicationCut = { history: "uninitialized", generation: 0 };
  await step(schedule[2]!, async () => {
    await host(a, "mkdirp", ["/dir"]);
    await host(a, "writeFile", ["/dir/a"], [10, 20, 30]);
    await host(a, "writeFile", ["/dir/target"], [99]);
    await control(b, "workspaceGuest", { key: "wasi", mode: "wasi" });
    await control(d, "workspaceGuest", { key: "proc", mode: "proc" });
    initial = cut(await inspect(authority(), "cut"));
    return { cut: initial, guests: ["Preview1", "runtime_proc"] };
  });
  await step(schedule[3]!, async () => {
    await host(a, "writeFile", ["/dir/a", true], [41]);
    await read(c, "dir/a", [10, 20, 30, 41]);
  });
  await step(schedule[4]!, async () => {
    const ack = await appendGuest(d, "proc", 42);
    return { ack, finalSettlementNudgesSent: 0, omitted: 1 };
  });
  await step(schedule[5]!, async () => {
    await read(c, "dir/a", [10, 20, 30, 41, 42]);
    const settled = await guest(d, "proc", "settle");
    equal(await guest(d, "proc", "settle"), settled);
    evidence.missingNudgeReceipt = settled;
    return settled;
  });
  await step(schedule[6]!, async () => {
    await host(c, "move", ["/dir/a", "/dir/target"]);
    await absent(a, "dir/a");
    await read(a, "dir/target", [10, 20, 30, 41, 42]);
  });
  await step(schedule[7]!, async () => {
    const ack = await appendGuest(b, "wasi", 43);
    await guest(d, "proc", "prepare", { kind: "read", offset: 0, maxBytes: 6 });
    const read = record(
      await guest(d, "proc", "call", { kind: "read", offset: 0, bytes: [0, 0, 0, 0, 0, 0] }),
    );
    equal(read.result, 6);
    equal(read.bytes, [10, 20, 30, 41, 42, 43]);
    const settled = await guest(d, "proc", "settle");
    return { ack, settled, read };
  });
  let id: unknown;
  let receipt: unknown;
  await step(schedule[8]!, async () => {
    id = await host(a, "workspaceNext");
    const args = [id, "writeFile", ["/dir/target", true]];
    await host(a, "workspaceMutation", args, [44, 45]);
    receipt = await host(a, "workspaceReceipt", [id]);
    const replayId = negative ? await host(a, "workspaceNext") : id;
    await host(a, "workspaceMutation", [replayId, args[1], args[2]], [44, 45]);
    await read(c, "dir/target", [10, 20, 30, 41, 42, 43, 44, 45]);
    equal(await host(a, "workspaceReceipt", [id]), receipt);
    equal(record(receipt).kind, "committed");
    return { id, receipt, replayId };
  });
  await step(schedule[9]!, async () => {
    equal(
      await guest(b, "wasi", "workspace", {
        action: "rename",
        path: "dir/target",
        to: "dir/final",
      }),
      0,
    );
    await absent(c, "dir/target");
    await read(d, "dir/final", [10, 20, 30, 41, 42, 43, 44, 45]);
    const changes = await inspect(authority(), "changes", initial);
    evidence.changes = changes;
    const groups = completeEffects(changes, initial);
    const first = appendEffects(groups[0]!, 3, [41]);
    const proc = appendEffects(groups[1]!, 4, [42]);
    const wasi = appendEffects(groups[3]!, 5, [43]);
    const replay = appendEffects(groups[4]!, 6, [44, 45]);
    equal(proc, { file: first.file, version: first.version + 1 });
    equal(wasi, { file: first.file, version: first.version + 2 });
    equal(replay, { file: first.file, version: first.version + 3 });
    equal(groups[1]!.receipt, record(evidence.missingNudgeReceipt).receipt);
    equal(renameEffects(groups[2]!, "a", "target", true), first.file);
    equal(renameEffects(groups[5]!, "target", "final", false), first.file);
    equal(record(groups[4]!.receipt).id, id);
    equal(record(groups[4]!.receipt), record(receipt).receipt);
    return changes;
  });
  await step(schedule[10]!, async () => {
    await host(c, "flush");
    evidence.saved = await control(a, "persistentInspect", name);
    return evidence.saved;
  });
  await step(schedule[11]!, async () => {
    await control(b, "workspaceGuestStop", { key: "wasi" });
    await control(d, "workspaceGuestStop", { key: "proc" });
    for (const page of pages) await control(page, "workspaceStop");
  });
  await step(schedule[12]!, async () => {
    const stop = await stopped(a);
    equal(deadWorkers.has(authority()), true);
    return { stop, nativeWorkerDeath: true };
  });
  await step(schedule[13]!, async () => {
    const previous = ready;
    const started = record(
      await control(a, "persistentStart", {
        name,
        original: previous.identity,
        runtimeLifetime: crypto.randomUUID(),
        attempt: crypto.randomUUID(),
      }),
    );
    equal(started.ready, true);
    ready = record(started.value);
    const identity = record(ready.identity),
      old = record(previous.identity);
    equal(identity.instance === old.instance, false);
    equal(identity.history === old.history, false);
    equal(ready.notice, {
      kind: "v1-new-history",
      durablePublicationCut: "untracked",
      oldCapabilities: "not-restored",
      oldMutationOutcomes: "not-restored",
      acknowledgedTail: "may-be-lost",
    });
    equal(await inspect(authority(), "changes", initial), {
      kind: "gap",
      current: await inspect(authority(), "cut"),
    });
    equal(await inspect(authority(), "receipt", id), { kind: "unknown" });
    evidence.originalDescriptor = previous.descriptor;
    return started;
  });
  await step(schedule[14]!, async () => {
    equal(await control(c, "staleDescriptor", evidence.originalDescriptor), 11);
    return { errno: 11 };
  });
  await step(schedule[15]!, async () => {
    for (const page of pages) {
      await control(page, "workspacePeer", ready.descriptor);
      roots.set(page, await host(page, "preopen", ["/"]));
      await read(page, "dir/final", [10, 20, 30, 41, 42, 43, 44, 45]);
      await absent(page, "dir/a");
      await absent(page, "dir/target");
    }
    return { savedBytes: [10, 20, 30, 41, 42, 43, 44, 45], pages: 4 };
  });
  await step(schedule[16]!, async () => {
    for (const page of pages) await control(page, "workspaceStop");
    await stopped(a);
    equal(deadWorkers.has(authority()), true);
    await control(a, "persistentDelete", name);
    return { nativeWorkerDeath: true, deleted: name };
  });
}
try {
  await lifecycle.init();
  evidence.scratch = lifecycle.scratch;
  const port = Number(process.env.PERSISTENT_AUTHORITY_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("set an explicit free PERSISTENT_AUTHORITY_PORT");
  const origin = lifecycle.serve(
    {
      "/": "<!doctype html><title>Persistent authority proof</title>",
      "/persistent.js": await browserBundle(
        resolve(import.meta.dir, "persistent-authority-browser.ts"),
      ),
      "/resident-authority.js": await browserBundle(
        resolve(import.meta.dir, "fixtures/persistent-authority-observer.ts"),
      ),
      "/resident-guest.js": await browserBundle(
        resolve(import.meta.dir, "fixtures/publication-resident-guest.ts"),
      ),
    },
    port,
  );
  evidence.origin = origin;
  const browser = await lifecycle.launch("chromium");
  evidence.browser = { name: "chromium", version: browser.version() };
  await scenario(browser, origin);
} finally {
  try {
    await lifecycle.close();
    evidence.cleanup = "browser, server and owned scratch retired";
  } finally {
    const counts = {
      completed: steps.filter((step) => step.kind === "completed").length,
      failed: steps.filter((step) => step.kind === "failed").length,
      unrun: steps.filter((step) => step.kind === "unrun").length,
    };
    const report = { ...evidence, counts, steps };
    console.log(JSON.stringify(report));
    if (reportPath) await Bun.write(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
}
