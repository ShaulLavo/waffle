import { expect, test } from "bun:test";
import {
  MemoryBackend,
  FilesystemClient,
  FilesystemService,
  createFilesystemConnection,
} from "../fs";
import { publicationObserver, type PublicationLimits } from "../fs/publication-internal";
import {
  createPublicationBuffers,
  PublicationDomain,
  snapshotPublicationCheckpoint,
  decodeEffects,
} from "../fs/publication";
import { snapshotBatch } from "../fs/storage";
import { resolve } from "node:path";
import { createServer } from "node:net";
import type { Browser, CDPSession, Page, Worker } from "playwright";
import { BrowserRunnerLifecycle, browserBundle } from "./browser-runner-lifecycle";
import { call, owner, host, runStep } from "./persistent-lifecycle-r2-browser-runner";
import {
  proofEqual as equal,
  proofReport,
  reportJson,
  type ProofStep,
} from "./persistent-authority-report";
import { record } from "../fs/publication-attachment";
async function observed(check: () => boolean, name: string): Promise<void> {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= end) throw new Error(`missing native observation: ${name}`);
    await Bun.sleep(10);
  }
}

class WorkerPause {
  private serial = 0;
  private pending = new Map<number, ReturnType<typeof Promise.withResolvers<unknown>>>();
  private paused = false;
  private resumed = 0;
  private constructor(
    private root: CDPSession,
    private sessionId: string,
  ) {
    root.on("Target.receivedMessageFromTarget", ({ sessionId, message }) => {
      if (sessionId !== this.sessionId) return;
      const value = record(JSON.parse(message));
      if (value.method === "Debugger.paused") this.paused = true;
      if (value.method === "Debugger.resumed") {
        this.paused = false;
        this.resumed++;
      }
      if (typeof value.id !== "number") return;
      const answer = this.pending.get(value.id);
      this.pending.delete(value.id);
      if (value.error) answer?.reject(new Error(reportJson(value.error)));
      else answer?.resolve(value.result);
    });
  }
  static async attach(browser: Browser, url: string): Promise<WorkerPause> {
    const root = await browser.newBrowserCDPSession();
    const targets = await root.send("Target.getTargets");
    const matches = targets.targetInfos.filter(
      (target) => target.type === "worker" && target.url === url,
    );
    equal(matches.length, 1);
    const target = matches[0];
    if (!target) throw new Error("native worker target absent");
    const attached = await root.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: false,
    });
    const debug = new WorkerPause(root, attached.sessionId);
    await debug.send("Debugger.enable");
    return debug;
  }
  private async send(method: string): Promise<unknown> {
    const id = ++this.serial,
      answer = Promise.withResolvers<unknown>();
    this.pending.set(id, answer);
    await this.root.send("Target.sendMessageToTarget", {
      sessionId: this.sessionId,
      message: JSON.stringify({ id, method }),
    });
    return answer.promise;
  }
  async pause(): Promise<void> {
    await this.send("Debugger.pause");
    await observed(() => this.paused, "Debugger.paused");
  }
  async resume(): Promise<void> {
    if (!this.paused) return;
    const before = this.resumed;
    await this.send("Debugger.resume");
    await observed(() => this.resumed > before, "Debugger.resumed");
  }
  async close(): Promise<void> {
    await this.resume();
    await this.root.detach();
  }
}
async function readSaved(page: Page): Promise<unknown> {
  const root = await host(page, "preopen", ["/"]);
  const file = record(await host(page, "resolve", [root, "saved"]));
  return host(page, "read", [file.node, 64, 0]);
}
async function refused(page: Page, name: string): Promise<unknown> {
  try {
    const answer = await call(page, "refusedStart", { name });
    equal(answer, { kind: "rejected", errno: 6 });
    return answer;
  } finally {
    await call(page, "terminate");
  }
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test port allocation absent");
    return address.port;
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
async function ownerBundle(failStartup = false): Promise<string> {
  const path = resolve(import.meta.dir, "fixtures/persistent-lifecycle-r2-owner.ts");
  const source = await Bun.file(path).text();
  const timing = `
import { PersistentBackend } from "../../fs/persistent";
const originalFlush = PersistentBackend.prototype.flush;
let startupFlush = true;
PersistentBackend.prototype.flush = async function (...args: Parameters<typeof originalFlush>) {
  const first = startupFlush;
  startupFlush = false;
  const started = performance.now();
  try {
    await Reflect.apply(originalFlush, this, args);
  } finally {
    if (first) events.push("startup-durability-ms=" + (performance.now() - started));
  }
};
`;
  const fault = `
const originalStorageFlush = IndexedDBStorage.prototype.flush;
IndexedDBStorage.prototype.flush = async function (...args: Parameters<typeof originalStorageFlush>) {
  await Reflect.apply(originalStorageFlush, this, args);
  throw new Error("injected-startup-flush-failure " + JSON.stringify(await navigator.locks.query()));
};
`;
  const built = await Bun.build({
    entrypoints: [path],
    target: "browser",
    plugins: [
      {
        name: "continuity-startup-observation",
        setup(build) {
          build.onLoad({ filter: /persistent-lifecycle-r2-owner\.ts$/ }, () => ({
            contents: source + timing + (failStartup ? fault : ""),
            loader: "ts",
          }));
        },
      },
    ],
  });
  if (!built.success || !built.outputs[0]) throw new Error("owner fixture build failed");
  return built.outputs[0].text();
}
async function startupDurabilityMs(page: Page): Promise<number> {
  const probe = record(await owner(page, "probe"));
  if (!Array.isArray(probe.events)) throw new Error("startup events missing");
  const event: unknown = probe.events.find(
    (value: unknown) => typeof value === "string" && value.startsWith("startup-durability-ms="),
  );
  if (typeof event !== "string") throw new Error("startup durability measurement missing");
  const milliseconds = Number(event.split("=")[1]);
  if (!Number.isFinite(milliseconds) || milliseconds < 0)
    throw new Error("invalid startup durability measurement");
  return milliseconds;
}

async function nativeCheckpointPressure() {
  const { IndexedDBStorage } = await import("../fs/indexeddb");
  const { PersistentBackend } = await import("../fs/persistent");
  const { FilesystemService } = await import("../fs/service");
  const { FilesystemClient } = await import("../fs/client");
  const { createFilesystemConnection } = await import("../fs/protocol");
  const name = `continuity-copy-pressure-${crypto.randomUUID()}`;
  const storage = await IndexedDBStorage.open(name, { whenBusy: "wait" });
  const backend = await PersistentBackend.open(storage, {
    intervalMs: 0,
    checkpointLimits: { maxBytes: 1048576, maxMetadataBytes: 65536, maxOperations: 8 },
  });
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection(undefined, {
    observe: true,
    limits: {
      sessions: 4,
      operations: 4,
      inputBytes: 64,
      argumentBytes: 512,
      effectBytes: 4096,
      effects: 16,
      resultBytes: 256,
      logRecords: 2,
      logBytes: 8192,
      pins: 1,
      pinBytes: 64,
    },
  });
  const client = new FilesystemClient(connection.client);
  service.connect(connection.server);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const work: Promise<void>[] = [];
  try {
    const root: number = await client.asyncCall("preopen", ["/"]);
    await client.asyncCall("setMode", [root, 0o750]);
    const domain = backend.shared.publication;
    if (!domain) throw new Error("real backend publication absent");
    let captures = 0;
    const capture = domain.checkpoint.bind(domain);
    domain.checkpoint = () => {
      captures++;
      return capture();
    };
    const persist = storage.persist.bind(storage);
    storage.persist = async (batch) => {
      entered.resolve();
      await release.promise;
      await persist(batch);
    };
    const first = backend.checkpoint().catch((error: unknown) => {
      throw new Error(
        JSON.stringify({
          firstCaptureFailure: String(error),
          publicationMetadata: domain.checkpointMetadataBytes(),
          pressure: backend.checkpointPressure(),
          dirty: backend.shared.dirtyAdmission.diagnostics(0),
        }),
        { cause: error },
      );
    });
    work.push(first);
    await Promise.race([entered.promise, first]);
    if (backend.checkpointPressure().pendingMetadataBytes < domain.checkpointMetadataBytes() * 4)
      throw new Error("publication copies uncharged");
    let refused = false,
      admitted = 1;
    let pending = backend.checkpointPressure();
    let copy = backend.shared.dirtyAdmission.diagnostics(0);
    for (let index = 1; index < 8; index++) {
      pending = backend.checkpointPressure();
      copy = backend.shared.dirtyAdmission.diagnostics(0);
      const beforeCapture = captures;
      let rejection: unknown;
      const next = backend.checkpoint().catch((error: unknown) => {
        rejection = error;
      });
      work.push(next);
      await Promise.resolve();
      if (rejection === undefined) {
        admitted++;
        continue;
      }
      if (Reflect.get(Object(rejection), "errno") !== 6) throw rejection;
      if (captures !== beforeCapture) throw new Error("pressure copied before rejecting");
      const after = backend.checkpointPressure();
      const afterCopy = backend.shared.dirtyAdmission.diagnostics(0);
      if (
        after.pendingMetadataBytes !== pending.pendingMetadataBytes ||
        afterCopy.immutableMetadataUnits !== copy.immutableMetadataUnits ||
        afterCopy.pendingOperations !== copy.pendingOperations
      )
        throw new Error("rejected admission leaked a reservation");
      refused = true;
      break;
    }
    if (!refused || admitted >= 8) throw new Error("metadata ceiling did not bound captures");
    release.resolve();
    await Promise.all(work);
    const clean = backend.checkpointPressure();
    const cleanCopy = backend.shared.dirtyAdmission.diagnostics(0);
    if (
      clean.pendingMetadataBytes ||
      clean.pendingOperations ||
      cleanCopy.immutableMetadataUnits ||
      cleanCopy.pendingOperations
    )
      throw new Error("successful persistence leaked a reservation");
    const sentinel = new Error("injected-publication-persist-failure");
    storage.persist = async () => {
      throw sentinel;
    };
    const failed = await backend.checkpoint().then(
      () => false,
      (error: unknown) => error === sentinel,
    );
    const failedPressure = backend.checkpointPressure();
    const failedCopy = backend.shared.dirtyAdmission.diagnostics(0);
    if (
      !failed ||
      failedPressure.pendingMetadataBytes ||
      failedPressure.pendingOperations ||
      failedCopy.immutableMetadataUnits ||
      failedCopy.pendingOperations
    )
      throw new Error("failed persistence leaked a reservation");
    return {
      pending,
      copy,
      admitted,
      captures,
      refused,
      clean,
      cleanCopy,
      failedPressure,
      failedCopy,
    };
  } finally {
    release.resolve();
    await Promise.allSettled(work);
    backend.dispose();
    client.dispose();
    service.dispose();
    await storage.close();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("pressure database deletion blocked"));
    });
  }
}
async function pressureBundle(): Promise<string> {
  const path = resolve(import.meta.dir, "persistent-lifecycle-r2-page.ts");
  const built = await Bun.build({
    entrypoints: [path],
    target: "browser",
    plugins: [
      {
        name: "native-publication-copy-pressure",
        setup(build) {
          build.onLoad({ filter: /persistent-lifecycle-r2-page\.ts$/ }, () => ({
            contents: "export const verify = " + nativeCheckpointPressure.toString(),
            loader: "js",
          }));
        },
      },
    ],
  });
  if (!built.success || !built.outputs[0]) throw new Error("pressure fixture build failed");
  return built.outputs[0].text();
}

test("completed native checkpoint restores publication identity without restoring capabilities", async () => {
  const runner = new BrowserRunnerLifecycle(150000);
  const evidence: Record<string, unknown> = {
    base: "b1256947d7f7857b255f0730705af08aff6d1440",
    adapter: "d451ffbbc64b14f9cbc5b84dccf269a6105e294b",
    helpers: [
      "763125340c27e09e4c691b489ff1d3e1cdc5ce6a",
      "6102244817daa7a23daabf4b5c004eebb12ecc18",
    ],
  };
  const steps: ProofStep[] = [
    "native owner and completed durable cut",
    "frozen live owner refuses replacement",
    "definitive worker close",
    "initial-open recovery and stale capability fencing",
    "explicit reset remains a new history",
    "completed-cut continuity contract",
    "startup checkpoint failure never publishes ready and retires native guards",
  ].map((name) => ({ name, kind: "unrun" }));
  const workers = new Map<Worker, boolean>();
  const pages: Page[] = [];
  const name = `workspace-continuity-${crypto.randomUUID()}`;
  let debug: WorkerPause | undefined;
  let original: Record<string, unknown> = {},
    tail: Record<string, unknown> = {},
    unflushed: Record<string, unknown> = {},
    recovered: Record<string, unknown> = {};
  let savedCut: unknown, savedReceipt: unknown, savedChanges: unknown;
  let root: Page | undefined, peer: Page | undefined, audit: Page | undefined;
  try {
    await runner.init();
    const port = Number(process.env.WORKSPACE_CONTINUITY_PORT ?? (await unusedPort()));
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error("set explicit free WORKSPACE_CONTINUITY_PORT");
    const origin = runner.serve(
      {
        "/": "<!doctype html><title>Workspace continuity</title>",
        "/persistent-lifecycle-r2-page.js": await browserBundle(
          resolve(import.meta.dir, "persistent-lifecycle-r2-page.ts"),
        ),
        "/persistent-lifecycle-r2-owner.js": await ownerBundle(),
      },
      port,
    );
    const browser = await runner.launch("chromium");
    const context = await browser.newContext();
    evidence.browser = browser.version();
    evidence.database = name;
    evidence.scratch = runner.scratch;
    for (let index = 0; index < 3; index++) {
      const page = await context.newPage();
      pages.push(page);
      page.on("worker", (worker) => {
        workers.set(worker, false);
        worker.once("close", () => workers.set(worker, true));
      });
      await page.goto(origin);
      equal(await page.evaluate(() => crossOriginIsolated), true);
    }
    [root, peer, audit] = pages;
    if (!root || !peer || !audit) throw new Error("three native pages required");
    const a = root,
      b = peer,
      c = audit;
    await runStep(steps, 0, async () => {
      const started = performance.now();
      original = record(await call(a, "start", { name }));
      evidence.startupTotalMs = performance.now() - started;
      evidence.startupDurabilityMs = await startupDurabilityMs(a);
      await call(b, "attach", original.descriptor);
      await host(b, "writeFile", ["/saved"], [10, 20, 30]);
      tail = record(await call(b, "acknowledgedTail"));
      await host(b, "flush");
      savedCut = await owner(a, "cut");
      savedReceipt = await owner(a, "receipt", tail.id);
      savedChanges = await owner(a, "changes", {
        history: record(savedCut).history,
        generation: 0,
      });
      equal(record(savedReceipt).kind, "committed");
      equal(record(savedReceipt).receipt, record(tail.settlement).receipt);
      equal(await readSaved(b), [10, 20, 30, 90]);
      return { cut: savedCut, receipt: savedReceipt, native: await call(c, "nativeRecords", name) };
    });
    await runStep(steps, 1, async () => {
      debug = await WorkerPause.attach(browser, `${origin}/persistent-lifecycle-r2-owner.js`);
      await debug.pause();
      const held = record(await call(c, "locks"));
      if (!Array.isArray(held.held)) throw new Error("native lock query unavailable");
      const storageLock = `bun-wasm:filesystem:indexeddb:${name}`;
      equal(
        held.held.map(record).some((lock) => lock.name === storageLock),
        true,
      );
      const refusal = await refused(c, name);
      await debug.resume();
      equal(await owner(a, "cut"), savedCut);
      await owner(a, "probe");
      return { pausedEvent: true, held, refusal, sameCutAfterNativeResume: true };
    });
    await runStep(steps, 2, async () => {
      await debug?.close();
      debug = undefined;
      await owner(a, "holdCheckpoint");
      await call(b, "stopPeer");
      await call(b, "attach", original.descriptor);
      unflushed = record(await call(b, "acknowledgedTail"));
      if (Number(record(unflushed.id).session) <= Number(record(tail.id).session))
        throw new Error("tail did not use a new post-cut session");
      await call(b, "stopPeer");
      await call(a, "terminate");
      await observed(
        () => Array.from(workers.values()).every(Boolean),
        "actual worker close events",
      );
      return { nativeWorkerCloseEvents: workers.size, locks: await call(c, "locks") };
    });
    await runStep(steps, 3, async () => {
      const started = performance.now();
      recovered = record(await call(a, "start", { name }));
      evidence.recoveryTotalMs = performance.now() - started;
      evidence.recoveryDurabilityMs = await startupDurabilityMs(a);
      const staleDescriptor = await call(c, "staleDescriptor", original.descriptor);
      const staleOutcome = await call(c, "staleOutcome", {
        descriptor: recovered.descriptor,
        token: tail.token,
        outcome: tail.outcome,
      });
      equal(staleDescriptor, { kind: "rejected", errno: 11 });
      equal(staleOutcome, [
        { kind: "rejected", errno: 11 },
        { kind: "rejected", errno: 11 },
      ]);
      await call(b, "attach", recovered.descriptor);
      equal(await readSaved(b), [10, 20, 30, 90]);
      const receipt = await owner(a, "receipt", tail.id),
        cut = await owner(a, "cut");
      const changes = await owner(a, "changes", {
        history: record(savedCut).history,
        generation: 0,
      });
      const fresh = record(await call(b, "acknowledgedTail"));
      if (Number(record(fresh.id).session) <= Number(record(unflushed.id).session))
        throw new Error("fresh session reused a post-cut tail receipt identity");
      equal(await owner(a, "receipt", unflushed.id), { kind: "unknown" });
      evidence.recovery = {
        ready: recovered,
        receipt,
        cut,
        changes,
        freshId: fresh.id,
        lostTailId: unflushed.id,
        lostTailReceipt: await owner(a, "receipt", unflushed.id),
        staleDescriptor,
        staleOutcome,
      };
      return evidence.recovery;
    });
    await runStep(steps, 4, async () => {
      await call(b, "stopPeer");
      await owner(a, "stop");
      await call(a, "terminate");
      await observed(() => Array.from(workers.values()).every(Boolean), "replacement worker close");
      const reset = record(await call(a, "start", { name, original: recovered.identity }));
      equal(record(reset.notice).kind, "v1-new-history");
      if (record(reset.identity).history === record(recovered.identity).history)
        throw new Error("explicit reset retained old history");
      equal(await owner(a, "receipt", tail.id), { kind: "unknown" });
      return reset;
    });
    await runStep(steps, 5, async () => {
      const result = record(evidence.recovery);
      equal(result.cut, savedCut);
      equal(result.receipt, savedReceipt);
      equal(result.changes, savedChanges);
      equal(record(recovered.identity).history, record(original.identity).history);
      if (record(recovered.identity).instance === record(original.identity).instance)
        throw new Error("old authority instance restored");
      equal(record(recovered.notice).kind, "completed-cut-recovered");
      equal(record(recovered.notice).durablePublicationCut, savedCut);
      return { recoveredCut: savedCut, exactReceipt: true, freshCapabilities: true };
    });
    await runStep(steps, 6, async () => {
      await owner(a, "stop");
      await call(a, "terminate");
      const faulty = await ownerBundle(true);
      await context.route("**/persistent-lifecycle-r2-owner.js", (route) =>
        route.fulfill({ contentType: "application/javascript", body: faulty }),
      );
      const outcome = await call(a, "start", { name: `${name}-failed-start` }).then(
        (value) => ({ kind: "ready", value }),
        (error: unknown) => ({ kind: "rejected", failure: String(error) }),
      );
      equal(outcome.kind, "rejected");
      const failure = record(outcome).failure;
      if (
        typeof failure !== "string" ||
        !failure.includes("injected-startup-flush-failure") ||
        !failure.includes(`bun-wasm:filesystem:indexeddb:${name}-failed-start`) ||
        !failure.includes("continuity:bootstrap:")
      )
        throw new Error("startup failure did not observe native ownership guards");
      await owner(a, "stop");
      equal(await call(c, "locks"), { held: [], pending: [] });
      await call(a, "terminate");
      return {
        outcome,
        locks: await call(c, "locks"),
        deleted: await call(c, "delete", `${name}-failed-start`),
      };
    });
  } catch (error) {
    evidence.failure = String(error);
    throw error;
  } finally {
    try {
      await debug?.close();
      if (root) {
        await owner(root, "stop").catch(() => {});
        await call(root, "terminate");
      }
      for (const page of pages.slice(0, 2)) await page.close();
      await observed(() => Array.from(workers.values()).every(Boolean), "containment worker close");
      if (audit) {
        const locks = await call(audit, "locks");
        equal(locks, { held: [], pending: [] });
        evidence.cleanup = {
          locks,
          deleted: await call(audit, "delete", name),
          failedStartDeleted: await call(audit, "delete", `${name}-failed-start`),
        };
      }
    } finally {
      await runner.close();
      evidence.outerCleanup = "browser, server and scratch retired";
      const report = proofReport(evidence, steps);
      console.log(reportJson(report));
      if (process.env.WORKSPACE_CONTINUITY_REPORT)
        await Bun.write(process.env.WORKSPACE_CONTINUITY_REPORT, reportJson(report, 2) + "\n");
    }
  }
}, 150000);

test("native publication checkpoint copy admission rejects before capture and retires reservations", async () => {
  const runner = new BrowserRunnerLifecycle(150000);
  try {
    await runner.init();
    const origin = runner.serve(
      { "/": "<!doctype html>", "/continuity-pressure.js": await pressureBundle() },
      await unusedPort(),
    );
    const browser = await runner.launch("chromium");
    const page = await browser.newPage();
    await page.goto(origin);
    const result = await page.evaluate(async () => {
      const path = "/continuity-pressure.js";
      const module: { verify: typeof nativeCheckpointPressure } = await import(path);
      return module.verify();
    });
    expect(result.refused).toBe(true);
    expect(result.captures).toBe(result.admitted + 1);
    const locks = await page.evaluate(() => navigator.locks.query());
    expect(locks).toEqual({ held: [], pending: [] });
    const evidence = { browser: browser.version(), result, locks };
    console.log(reportJson(evidence));
    if (process.env.WORKSPACE_CONTINUITY_REPORT)
      await Bun.write(
        process.env.WORKSPACE_CONTINUITY_REPORT + ".pressure.json",
        reportJson(evidence, 2) + "\n",
      );
  } finally {
    await runner.close();
  }
}, 150000);

const smallLimits: PublicationLimits = {
  sessions: 4,
  operations: 4,
  inputBytes: 64,
  argumentBytes: 512,
  effectBytes: 4096,
  effects: 16,
  resultBytes: 256,
  logRecords: 2,
  logBytes: 8192,
  pins: 1,
  pinBytes: 64,
};
test("real publication checkpoint owns bounded receipts, gap suffix and content counters", async () => {
  const backend = new MemoryBackend();
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection(undefined, {
    limits: smallLimits,
    observe: true,
    restore: {
      kind: "settled-publication-v1",
      cut: { history: crypto.randomUUID(), generation: 0 },
      sessionSerial: 0,
      limits: smallLimits,
      receipts: [],
      changes: [],
      contentVersions: [],
    },
  });
  const client = new FilesystemClient(connection.client);
  service.connect(connection.server);
  try {
    const observer = publicationObserver(client),
      original = await observer.cut();
    await client.asyncCall("writeFile", ["/file"], new Uint8Array([1]));
    const firstPage = await observer.changes(original, smallLimits.logBytes);
    if (firstPage.kind !== "changes" || !firstPage.publications[0])
      throw new Error("real publication absent");
    const firstReceipt = firstPage.publications[0].receipt;
    for (let value = 2; value <= 8; value++)
      await client.asyncCall("writeFile", ["/file"], new Uint8Array([value]));
    const captured = backend.shared.current(true, undefined, client.connection.owner, () =>
      backend.shared.publication!.checkpoint(),
    );
    expect(captured.receipts.length).toBeLessThanOrEqual(4);
    expect(captured.changes).toHaveLength(2);
    const batch = snapshotBatch({
      generation: 1,
      root: 1,
      upserts: [],
      removes: [],
      data: new Map(),
      publication: captured,
    });
    const owned = batch.publication;
    if (!owned) throw new Error("checkpoint missing from owned batch");
    const saved = structuredClone(owned);
    const live = backend.shared.publication!;
    const postCutSession = live.openSession();
    const postCutId = live.next(postCutSession);
    captured.changes[0]?.fill(0);
    expect(owned).toEqual(saved);
    const restored = new PublicationDomain(createPublicationBuffers(smallLimits, false, owned));
    expect(restored.cut()).toEqual(saved.cut);
    expect(restored.changes(original, 8192)).toEqual({ kind: "gap", current: saved.cut });
    expect(restored.lookupAny(firstReceipt.id)).toEqual({ kind: "unknown" });
    for (const receipt of saved.receipts)
      expect(restored.lookupAny(receipt.id)).toEqual({ kind: "committed", receipt });
    for (const entry of saved.contentVersions)
      expect(restored.contentVersion(entry.ino)).toBe(entry.version);
    const diagnostics = restored.diagnostics();
    expect(diagnostics.sessions).toBe(0);
    expect(diagnostics.pending).toBe(0);
    expect(diagnostics.pins).toBe(0);
    const oldSession = connection.client.publication?.session;
    if (!oldSession) throw new Error("root session absent");
    expect(() => restored.next(oldSession)).toThrow();
    const session = restored.openSession();
    expect(session.serial).toBeGreaterThan(saved.sessionSerial);
    expect(session.serial).toBeGreaterThan(postCutId.session);
    expect(restored.lookupAny(postCutId)).toEqual({ kind: "unknown" });
    live.closeSession(postCutSession);
    for (let index = 0; index < 8; index++) {
      const id = restored.next(session);
      const admission = restored.admit(
        session,
        id,
        { kind: "preopen", path: "/" },
        new Uint8Array(),
      );
      if (admission.kind !== "admitted") throw new Error("fresh receipt unexpectedly duplicated");
      restored.commit(restored.prepare(admission.admission, { kind: "void" }, []));
    }
    for (const receipt of saved.receipts)
      expect(restored.lookupAny(receipt.id)).toEqual({ kind: "unknown" });
    expect(() =>
      snapshotPublicationCheckpoint({ ...saved, receipts: saved.receipts.concat(saved.receipts) }),
    ).toThrow();
    expect(() => snapshotPublicationCheckpoint({ ...saved, sessionSerial: 0 })).toThrow();
    expect(() =>
      snapshotPublicationCheckpoint({
        ...saved,
        cut: { ...saved.cut, history: "x".repeat(257) },
      }),
    ).toThrow();
    expect(() =>
      snapshotPublicationCheckpoint({ ...saved, changes: saved.changes.toReversed() }),
    ).toThrow();
    expect(() =>
      createPublicationBuffers({ ...smallLimits, operations: 5 }, false, saved),
    ).toThrow();
    const exhausted = new PublicationDomain(
      createPublicationBuffers(smallLimits, false, { ...saved, sessionSerial: 0x7ffffffd }),
    );
    expect(exhausted.openSession().serial).toBe(0x7ffffffe);
    const beforeExhaustion = exhausted.checkpoint();
    const arenas = [
      exhausted.buffers.control,
      exhausted.buffers.sessions,
      exhausted.buffers.operations,
    ];
    const beforeArenas = arenas.map((buffer) => Array.from(new Uint8Array(buffer)));
    expect(() => exhausted.openSession()).toThrow();
    expect(arenas.map((buffer) => Array.from(new Uint8Array(buffer)))).toEqual(beforeArenas);
    expect(exhausted.checkpoint()).toEqual(beforeExhaustion);
    expect(createPublicationBuffers(smallLimits).sessionLimit).toBe(0x7ffffffe);
    expect(() => createPublicationBuffers(smallLimits, false, beforeExhaustion)).toThrow();
    const first = saved.changes[0];
    if (!first) throw new Error("saved suffix absent");
    expect(decodeEffects(first).receipt.cut.generation).toBe(saved.cut.generation - 1);
  } finally {
    client.dispose();
    service.dispose();
  }
});
