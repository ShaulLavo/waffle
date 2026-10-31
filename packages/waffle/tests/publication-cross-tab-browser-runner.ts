import { readyPersistent } from "./fixtures/persistent-ready";
import { workspaceCleanupPostFailure } from "./fixtures/publication-cleanup-failure";
import { INDEXEDDB_FORMAT } from "../fs/vfs-format.js";
import { resolve } from "node:path";
import { BrowserRunnerLifecycle, browserBundle } from "./browser-runner-lifecycle";
import type { Browser, Page } from "playwright";
import { installWorkspaceChannelObserver } from "./fixtures/publication-channel-observer";

const lifecycle = new BrowserRunnerLifecycle(180_000);
function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
async function control(page: Page, operation: string, value?: unknown): Promise<unknown> {
  return page.evaluate(
    async ({ operation, value }) => {
      const path = "/cross-tab.js";
      const module: typeof import("./publication-cross-tab-browser") = await import(path);
      return module.control(operation, value);
    },
    { operation, value },
  );
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
async function guestBundle(): Promise<Blob> {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "fixtures/publication-resident-guest.ts")],
    target: "browser",
    plugins: [
      {
        name: "private-claim-test-observer",
        setup(build) {
          build.onLoad({ filter: /fs\/publication-grant\.ts$/ }, async ({ path }) => {
            const source = await Bun.file(path).text();
            const marker = '    try {\n      if (grant.kind === "read") return this.readClaimed';
            if (source.split(marker).length !== 2) throw new Error("claim test marker changed");
            const observation =
              '    const observe = Reflect.get(globalThis, "__publicationClaimed");\n    if (typeof observe === "function") observe();\n';
            return { contents: source.replace(marker, observation + marker), loader: "ts" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "test-only guest bundle failed");
  return build.outputs[0]!;
}
async function observeWorkspaceChannels(page: Page): Promise<void> {
  await page.addInitScript(installWorkspaceChannelObserver);
}
async function workspaceChannels(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const counts: unknown = Reflect.get(globalThis, "__workspaceChannelCounts");
    if (!counts || typeof counts !== "object") throw new Error("channel observer missing");
    return Object.fromEntries(
      Object.entries(counts).filter(([, value]) => typeof value !== "function"),
    );
  });
}
async function channelBarrier(page: Page, action: string): Promise<void> {
  await page.evaluate((action) => {
    const state: unknown = Reflect.get(globalThis, "__workspaceChannelCounts");
    if (!state || typeof state !== "object") throw new Error("channel observer missing");
    if (action !== "release") {
      Reflect.set(state, "hold", action);
      return;
    }
    const release: unknown = Reflect.get(state, "release");
    if (typeof release !== "function") throw new Error("channel release missing");
    release();
  }, action);
}
async function heldChannel(page: Page, count = 1): Promise<void> {
  await page.waitForFunction((count) => {
    const state: unknown = Reflect.get(globalThis, "__workspaceChannelCounts");
    return state && typeof state === "object" && Reflect.get(state, "held") === count;
  }, count);
}
async function workspacePage(
  page: Page,
  operation: string,
  args: unknown[] = [],
  bytes?: number[],
): Promise<unknown> {
  return control(page, "workspacePage", { operation, args, bytes });
}
async function workspaceGuest(
  page: Page,
  key: string,
  operation: string,
  request?: unknown,
): Promise<unknown> {
  return control(page, "workspaceGuestCall", { key, operation, request });
}
async function workspaceControls(browser: Browser, origin: string): Promise<void> {
  const context = await browser.newContext();
  try {
    const first = await context.newPage(),
      second = await context.newPage();
    for (const page of [first, second]) {
      page.on("pageerror", (error) => console.error(error));
      await observeDeaths(page);
      await observeWorkspaceChannels(page);
      await page.goto(origin);
    }
    const descriptor = await control(
      first,
      "workspaceAuthority",
      `workspace-${crypto.randomUUID()}`,
    );
    for (const page of [first, second])
      equal(await control(page, "workspacePeer", descriptor), { authorityRootReceived: false });
    const root = await workspacePage(second, "preopen", ["/"]);
    const old = record(await workspacePage(second, "resolve", [root, "dir/a"]));
    const directory = record(await workspacePage(second, "resolve", [root, "dir"]));
    equal(record(await workspacePage(second, "stat", [old.node])).size, 4);
    equal(
      record(
        await workspacePage(second, "stat", [
          record(await workspacePage(second, "resolve", [root, "dir/b"])).node,
        ]),
      ).size,
      2,
    );
    const entries = await workspacePage(second, "readdir", [directory.node]);
    if (!Array.isArray(entries)) throw new Error("missing current directory entries");
    equal(entries.map((entry) => record(entry).name).sort(), [".", "..", "a", "b"]);
    await control(first, "workspaceGuest", { key: "retained", mode: "wasi" });
    await control(second, "workspaceGuest", { key: "proc", mode: "proc" });
    equal(
      await workspaceGuest(first, "retained", "workspace", { action: "create", path: "dir/new" }),
      0,
    );
    equal(
      await workspaceGuest(first, "retained", "workspace", {
        action: "rename",
        path: "dir/a",
        to: "dir/renamed",
      }),
      0,
    );
    await workspacePage(second, "writeFile", ["/dir/a"], [99]);
    equal(
      await workspaceGuest(first, "retained", "workspace", {
        action: "unlink",
        path: "dir/renamed",
      }),
      0,
    );
    const retained = record(
      await workspaceGuest(first, "retained", "workspace", { action: "stat" }),
    );
    equal(retained.result, 0);
    equal(retained.size, 4);
    equal(retained.handle, old.node);
    equal(
      record(
        await workspacePage(second, "stat", [
          record(await workspacePage(second, "resolve", [root, "dir/a"])).node,
        ]),
      ).size,
      1,
    );
    const unavailable = record(
      await workspaceGuest(second, "proc", "call", { kind: "read", bytes: [88, 88] }),
    );
    equal(unavailable.result, -6);
    equal(unavailable.offset, 0);
    equal(unavailable.bytes, [88, 88]);
    await workspaceGuest(second, "proc", "prepare", { kind: "read", offset: 0, maxBytes: 2 });
    const read = record(
      await workspaceGuest(second, "proc", "call", { kind: "read", bytes: [88, 88] }),
    );
    equal(read.result, 2);
    equal(read.bytes, [10, 20]);
    equal(read.offset, 2);
    await workspacePage(first, "stat", [await workspacePage(first, "preopen", ["/"])]);
    const cut = await control(first, "workspaceCut");
    await workspaceGuest(second, "proc", "prepare", { kind: "write", offset: 2, maxBytes: 1 });
    const written = record(
      await workspaceGuest(second, "proc", "call", { kind: "write", bytes: [77] }),
    );
    equal(written.result, 1);
    equal(written.offset, 3);
    // There is no settle or notification. The other page's current query must settle ACK.
    equal(record(await workspacePage(second, "stat", [old.node])).size, 4);
    const changed = record(await control(first, "workspaceChanges", cut));
    equal(changed.kind, "changes");
    if (!Array.isArray(changed.publications)) throw new Error("missing ordered changes");
    equal(changed.publications.length, 1);
    const group = record(changed.publications[0]);
    if (!Array.isArray(group.changes)) throw new Error("missing complete effects");
    equal(
      group.changes.map((effect) => record(effect).kind),
      ["bytes", "metadata"],
    );
    equal(await workspaceGuest(second, "proc", "observerDenied"), 2);
    await control(second, "workspaceDescendant", { parent: "proc", key: "child", mode: "proc" });
    await workspaceGuest(second, "child", "prepare", { kind: "read", offset: 3, maxBytes: 1 });
    const childRead = record(
      await workspaceGuest(second, "child", "call", { kind: "read", bytes: [88] }),
    );
    equal(childRead.result, 1);
    equal(childRead.bytes, [40]);
    equal(childRead.offset, 4);
    equal(await workspaceGuest(second, "proc", "offset"), 4);
    await workspacePage(second, "setMode", [old.node, 0]);
    equal(
      await workspaceGuest(second, "proc", "prepareDenied", {
        kind: "read",
        offset: 4,
        maxBytes: 1,
      }),
      2,
    );
    await workspacePage(second, "setMode", [old.node, 0o666]);
    const id = await workspacePage(second, "workspaceNext");
    const mutation = [id, "writeFile", ["/dir/once"]];
    await workspacePage(second, "workspaceMutation", mutation, [42]);
    const receipt = await workspacePage(second, "workspaceReceipt", [id]);
    await workspacePage(second, "workspaceMutation", mutation, [42]);
    equal(await workspacePage(second, "workspaceReceipt", [id]), receipt);
    equal(
      await control(second, "workspacePageDenied", {
        operation: "workspaceMutation",
        args: mutation,
        bytes: [43],
      }),
      28,
    );
    const recent = await workspacePage(second, "workspaceReceipts");
    if (
      !Array.isArray(recent) ||
      !recent.some((entry) => JSON.stringify(record(entry).outcome) === JSON.stringify(receipt))
    )
      throw new Error("missing own-session recovery receipt");
    for (const [page, key] of [
      [second, "child"],
      [second, "proc"],
      [first, "retained"],
    ] as const) {
      const before = record(await workspaceChannels(page));
      const stopped = record(await control(page, "workspaceGuestStop", { key }));
      equal(record(stopped.exit).type, "exit");
      const after = record(await workspaceChannels(page));
      console.log("WORKSPACE_EXIT_CHANNELS=" + JSON.stringify({ key, before, after }));
      equal(after.opened, before.opened);
      equal(after.closed, Number(before.closed) + 1);
    }
    for (const page of [first, second]) await control(page, "workspaceStop");
    await control(first, "workspaceAuthorityStop");
    console.log(
      "PASS workspace independent pages, genuine WASI namespace, retained unlink/replacement, current async metadata, real runtime_proc EAGAIN/read/write, lost-nudge complete changes, guest observer denial, codec reservation/shared offsets, permissions, exact duplicate/conflict/own receipts and joined stop",
    );
  } finally {
    await context.close();
  }
}
async function waitForCancellation(page: Page, before: number): Promise<void> {
  await page.waitForFunction((before) => {
    const state: unknown = Reflect.get(globalThis, "__workspaceChannelCounts");
    return state && typeof state === "object" && Number(Reflect.get(state, "cancelled")) > before;
  }, before);
}
async function joinedGuestStop(page: Page, key: string): Promise<void> {
  equal(record(await control(page, "workspaceGuestTerminal", { key, event: "exit" })).type, "exit");
  await control(page, "workspaceGuestDeath", { key });
}
async function startupCleanup(page: Page): Promise<void> {
  const before = record(await workspaceChannels(page));
  const cancelled = record(await control(page, "workspaceCancelledStartup"));
  equal(record(cancelled.finished).setupCount, 0);
  equal(cancelled.exit, false);
  equal(cancelled.cleanupError, false);
  equal(record(await workspaceChannels(page)).closed, Number(before.closed) + 1);
  await control(page, "workspaceGuest", { key: "setup-failed", mode: "wasi", failSetup: true });
  equal(
    record(await control(page, "workspaceGuestTerminal", { key: "setup-failed", event: "error" }))
      .type,
    "error",
  );
  equal(record(await workspaceChannels(page)).closed, Number(before.closed) + 2);
  await control(page, "workspaceGuestDeath", { key: "setup-failed" });
  console.log(
    "PASS actual workspace startup cancellation and setup failure close their owned bridges",
  );
}
async function pendingCleanup(page: Page): Promise<void> {
  await control(page, "workspaceGuest", { key: "pending", mode: "proc" });
  const before = record(await workspaceChannels(page));
  await channelBarrier(page, "workspace");
  await workspaceGuest(page, "pending", "beginPending");
  await heldChannel(page);
  await control(page, "workspaceGuestSignalStop", { key: "pending" });
  await waitForCancellation(page, Number(before.cancelled));
  equal(record(await control(page, "workspaceGuestStatus", { key: "pending" })).exit, false);
  equal(record(await workspaceChannels(page)).closed, before.closed);
  await channelBarrier(page, "release");
  await joinedGuestStop(page, "pending");
  const after = record(await workspaceChannels(page));
  equal(after.closed, Number(before.closed) + 1);
  equal(after.pending, 0);
  equal(after.closedPending, 0);
  console.log(
    "PASS actual workspace exit waits for the native pending authority reply before channel close and exit ACK",
  );
}
async function transferCleanup(page: Page): Promise<void> {
  await control(page, "workspaceGuest", { key: "parent", mode: "proc" });
  const before = record(await workspaceChannels(page));
  await channelBarrier(page, "workspaceAdopt");
  await control(page, "workspaceDescendantQueue", {
    parent: "parent",
    key: "living-child",
    mode: "proc",
  });
  await heldChannel(page);
  await control(page, "workspaceGuestSignalStop", { key: "parent" });
  // A fresh channel query gives the page/worker event queues a real round trip, not a sleep.
  await workspacePage(page, "stat", [await workspacePage(page, "preopen", ["/"])]);
  equal(record(await control(page, "workspaceGuestStatus", { key: "parent" })).exit, false);
  equal(record(await workspaceChannels(page)).closed, before.closed);
  await channelBarrier(page, "release");
  await control(page, "workspaceGuestReady", { key: "living-child" });
  await joinedGuestStop(page, "parent");
  equal(record(await workspaceChannels(page)).closed, Number(before.closed) + 1);
  await workspaceGuest(page, "living-child", "prepare", { kind: "read", offset: 0, maxBytes: 1 });
  equal(
    record(await workspaceGuest(page, "living-child", "call", { kind: "read", bytes: [88] })).bytes,
    [10],
  );
  await control(page, "workspaceGuestStop", { key: "living-child" });
  equal(record(await workspaceChannels(page)).closed, Number(before.closed) + 2);
  equal(record(await workspaceChannels(page)).closedPending, 0);
  console.log(
    "PASS actual workspace exit joins codec adoption while the accepted independent child survives and reads",
  );
}
async function repeatedCleanup(page: Page): Promise<void> {
  await control(page, "workspaceGuest", { key: "repeat", mode: "proc" });
  const before = record(await workspaceChannels(page));
  await workspaceGuest(page, "repeat", "repeatStop");
  equal(await workspaceGuest(page, "repeat", "revokedData"), 11);
  await control(page, "workspaceGuestStop", { key: "repeat" });
  equal(record(await workspaceChannels(page)).closed, Number(before.closed) + 1);
  await control(page, "workspaceGuest", { key: "cancel-parent", mode: "proc" });
  await channelBarrier(page, "connect");
  const connecting = record(await workspaceChannels(page));
  const cancelling = control(page, "workspaceDescendantCancel", { parent: "cancel-parent" }).then(
    () => ({ joined: true, error: "" }),
    (error: unknown) => ({ joined: false, error: String(error) }),
  );
  await page.waitForFunction(() => {
    const state: unknown = Reflect.get(globalThis, "__workspaceChannelCounts");
    return (
      state &&
      typeof state === "object" &&
      Reflect.get(state, "connectHeld") === 1 &&
      Reflect.has(globalThis, "__workspaceChildCancelled")
    );
  });
  const held = record(await workspaceChannels(page));
  equal(held.connectDelivered, connecting.connectDelivered);
  equal(held.opened, connecting.opened);
  const cancelled: unknown = await page.evaluate(() =>
    Reflect.get(globalThis, "__workspaceChildCancelled"),
  );
  equal(record(cancelled).revoked, 1);
  equal(record(cancelled).reservations, [[1, 2]]);
  await page.evaluate(() => {
    const state: unknown = Reflect.get(globalThis, "__workspaceChannelCounts");
    if (!state || typeof state !== "object") throw new Error("missing channel observer");
    const release: unknown = Reflect.get(state, "releaseConnect");
    if (typeof release !== "function") throw new Error("missing connect release");
    release();
  });
  await page.waitForFunction((before) => {
    const state: unknown = Reflect.get(globalThis, "__workspaceChannelCounts");
    return (
      state && typeof state === "object" && Number(Reflect.get(state, "connectDelivered")) > before
    );
  }, Number(connecting.connectDelivered));
  const result = await cancelling;
  console.log(
    "WORKSPACE_CONNECT_CANCEL=" +
      JSON.stringify({ connecting, held, cancelled, after: await workspaceChannels(page), result }),
  );
  equal(result.joined, true);
  const joined = record(await workspaceChannels(page));
  equal(joined.opened, held.opened);
  equal(joined.closed, held.closed);
  await control(page, "workspaceGuestStop", { key: "cancel-parent" });
  const stopped = record(await workspaceChannels(page));
  equal(stopped.opened, held.opened);
  equal(stopped.closed, Number(held.closed) + 1);
  console.log(
    "PASS repeated stop/dispose stays revoked and closes once; unaccepted codec reservation cancellation joins separately",
  );
}
async function lateReservationCleanup(page: Page): Promise<void> {
  await control(page, "workspaceGuest", { key: "late-parent", mode: "proc" });
  await control(page, "workspaceDescendantReserve", { parent: "late-parent", key: "late-child" });
  const before = record(await workspaceChannels(page));
  await control(page, "workspaceGuestSignalStop", { key: "late-parent" });
  await page.waitForFunction((before) => {
    const state: unknown = Reflect.get(globalThis, "__workspaceChannelCounts");
    return (
      state && typeof state === "object" && Number(Reflect.get(state, "cleanupStarted")) > before
    );
  }, Number(before.cleanupStarted));
  equal(record(await control(page, "workspaceGuestStatus", { key: "late-parent" })).exit, false);
  equal(record(await workspaceChannels(page)).closed, before.closed);
  await control(page, "workspaceDescendantCancelReserved", { key: "late-child" });
  await joinedGuestStop(page, "late-parent");
  const after = record(await workspaceChannels(page));
  equal(after.closed, Number(before.closed) + 2);
  equal(after.pending, 0);
  equal(after.closedPending, 0);
  console.log(
    "PASS observed actual parent cleanup joins later pre-bind child cancellation before closed-once exit ACK",
  );
}
async function continuityGuards(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const locks = await navigator.locks.query();
    return (locks.held ?? []).filter((lock) =>
      lock.name?.startsWith("waffle:publication:continuity:"),
    ).length;
  });
}
async function unknownCleanup(page: Page): Promise<void> {
  await control(page, "workspaceGuest", { key: "lost", mode: "proc" });
  const before = record(await workspaceChannels(page));
  const guards = await continuityGuards(page);
  await channelBarrier(page, "workspace");
  await workspaceGuest(page, "lost", "beginPending");
  await heldChannel(page);
  await control(page, "workspaceGuestSignalStop", { key: "lost" });
  await waitForCancellation(page, Number(before.cancelled));
  await waitForCancellation(page, Number(before.cancelled) + 1);
  await control(page, "workspaceGuestPendingSettled", { key: "lost" });
  await heldChannel(page, 2);
  equal(await control(page, "workspaceGuestStatus", { key: "lost" }), {
    exit: false,
    finished: false,
    cleanupError: false,
  });
  const held = record(await workspaceChannels(page));
  equal(held.closed, before.closed);
  equal(held.pending, 1);
  equal(held.held, 2);
  equal(held.reconciled, Number(before.reconciled) + 1);
  equal(held.closedPending, 0);
  equal(await continuityGuards(page), guards);
  equal(await control(page, "exclusive"), false);
  await channelBarrier(page, "release");
  equal(
    record(await control(page, "workspaceGuestTerminal", { key: "lost", event: "exit" })).type,
    "exit",
  );
  equal(await control(page, "workspaceGuestStatus", { key: "lost" }), {
    exit: true,
    finished: true,
    cleanupError: false,
  });
  const reconciled = record(await workspaceChannels(page));
  equal(reconciled.closed, Number(before.closed) + 1);
  equal(reconciled.pending, 0);
  equal(reconciled.held, 0);
  equal(reconciled.closedPending, 0);
  equal(await continuityGuards(page), guards - 1);
  await control(page, "workspaceStop");
  await control(page, "workspaceAuthorityStop");
  equal(await control(page, "exclusive"), true);
  console.log("WORKSPACE_UNKNOWN_CLEANUP=" + JSON.stringify({ before, held, reconciled, guards }));
  await control(page, "workspaceGuestDeath", { key: "lost" });
  console.log(
    "PASS withholding both original terminal deliveries keeps stop and guard pending past the caller deadline; releasing the matching result joins exit and one channel close before guest death",
  );
}
async function failedCleanup(page: Page): Promise<void> {
  await control(page, "workspaceGuest", { key: "failed", mode: "proc", cleanupFailure: true });
  const before = record(await workspaceChannels(page));
  await control(page, "workspaceGuestSignalStop", { key: "failed" });
  const failure = record(
    await control(page, "workspaceGuestTerminal", { key: "failed", event: "cleanup-error" }),
  );
  equal(failure.type, "cleanup-error");
  if (typeof failure.message !== "string" || !failure.message.includes(workspaceCleanupPostFailure))
    throw new Error("missing explicit cleanup post failure");
  equal(await control(page, "workspaceGuestStatus", { key: "failed" }), {
    exit: false,
    finished: true,
    cleanupError: true,
  });
  equal(record(await workspaceChannels(page)).closed, before.closed);
  equal(record(await workspaceChannels(page)).pending, 0);
  console.log("WORKSPACE_EXPLICIT_CLEANUP_FAILURE=" + JSON.stringify(failure));
  await control(page, "workspaceStop");
  await control(page, "authorityDeath");
  equal(await control(page, "exclusive"), false);
  await control(page, "workspaceGuestDeath", { key: "failed" });
  equal(await control(page, "exclusive"), true);
  console.log(
    "PASS explicit workspace cleanup post failure emits cleanup-error without exit ACK/channel close; native worker death alone releases retained continuity",
  );
}
async function workspaceCleanupPage(
  browser: Browser,
  origin: string,
  exercise: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.on("pageerror", (error) => console.error(error));
    await observeDeaths(page);
    await observeWorkspaceChannels(page);
    await page.goto(origin);
    const descriptor = await control(page, "workspaceAuthority", `cleanup-${crypto.randomUUID()}`);
    await control(page, "workspacePeer", descriptor);
    await exercise(page);
  } finally {
    await context.close();
  }
}
async function workspaceCleanupControls(browser: Browser, origin: string): Promise<void> {
  await workspaceCleanupPage(browser, origin, async (page) => {
    await startupCleanup(page);
    await pendingCleanup(page);
    await transferCleanup(page);
    await repeatedCleanup(page);
    await lateReservationCleanup(page);
    await unknownCleanup(page);
  });
  await workspaceCleanupPage(browser, origin, failedCleanup);
}
async function runWorkspaceCleanup(name: string, origin: string): Promise<void> {
  if (name !== "chromium" && name !== "firefox" && name !== "webkit")
    throw new Error(`unknown browser ${name}`);
  const browser = await lifecycle.launch(name);
  try {
    await workspaceCleanupControls(browser, origin);
    console.log(`${name} ${browser.version()}: workspace cleanup controls passed`);
  } finally {
    await lifecycle.closeBrowser(browser);
  }
}
async function currentPersistentBaseline(page: Page): Promise<void> {
  const result = record(await control(page, "persistentBaseline"));
  const seeded = record(result.seeded),
    reopened = record(result.reopened);
  const before = record(result.before),
    after = record(result.after);
  equal(seeded.name, reopened.name);
  for (const value of [seeded, reopened]) {
    equal(value.implementation, "indexeddb");
    equal(value.format, INDEXEDDB_FORMAT);
    equal(value.first, [11, 22, 33, 44]);
    equal(value.second, [91, 82, 73]);
    equal(value.mode, 0o400);
    equal(value.size, 4);
  }
  equal(before.inspection, "readonly-native-no-owner-claim");
  equal(after.inspection, before.inspection);
  equal(after.name, before.name);
  equal(after.format, before.format);
  if (typeof before.epoch !== "number" || typeof after.epoch !== "number")
    throw new Error("saved owner epochs missing");
  equal(after.epoch, before.epoch + 1);
  equal(after.generation, before.generation);
  if (seeded.worker === reopened.worker) throw new Error("native owner attempts reused identity");
  console.log("CURRENT_API_PERSISTENT_BASELINE=" + JSON.stringify(result));
  console.log("PASS ordinary native persistent worker same-name reopen, permissions and bytes");
}
function persistentAttempt(name: string, original?: unknown): unknown {
  return { name, runtimeLifetime: crypto.randomUUID(), attempt: crypto.randomUUID(), original };
}
function noFactoryNativeOpen(result: Record<string, unknown>): void {
  if (
    !Array.isArray(result.events) ||
    result.events.some((event) => String(event).startsWith("native-"))
  )
    throw new Error("refused factory touched native storage");
}
function nativeClosedBeforeRelease(value: unknown): void {
  const result = record(value);
  equal(result.same, true);
  equal(result.stopped, true);
  if (!Array.isArray(result.events)) throw new Error("native lifecycle evidence missing");
  const events = result.events;
  const close = events.indexOf("native-closed");
  const finalRelease = events.lastIndexOf("guard-released");
  // The initial exclusive-to-shared handoff has its own earlier release.
  if (
    close < 0 ||
    finalRelease <= close ||
    events.slice(close + 1).filter((event) => event === "guard-released").length !== 2
  )
    throw new Error("native close did not precede both final guard releases");
}
function cancelledBeforeLoad(value: unknown): void {
  const result = record(value);
  equal(result.ready, false);
  const stopped = record(result.stopped);
  equal(stopped.same, true);
  equal(stopped.stopped, true);
  if (!Array.isArray(stopped.events)) throw new Error("native cancellation events missing");
  const events = stopped.events;
  const close = events.indexOf("native-db-closed");
  if (
    close < 0 ||
    events.slice(close + 1).filter((event) => event === "guard-released").length !== 2
  )
    throw new Error("physical close did not precede final guards");
  for (const stage of ["native-acquired", "native-load", "filesystem-ready"])
    if (events.includes(stage)) throw new Error(`cancelled owner reached ${stage}`);
}
async function pendingClaimControl(owner: Page, holder: Page, name: string): Promise<void> {
  equal(await control(holder, "persistentOrdinaryHold", name), [11, 22, 33, 44]);
  const before = await control(owner, "persistentInspect", name);
  const result = record(
    await control(owner, "persistentCancelPendingClaim", persistentAttempt(name)),
  );
  equal(result.held, 1);
  equal(result.pending, 1);
  equal(result.heldAfter, 1);
  equal(result.pendingAfter, 0);
  cancelledBeforeLoad(result);
  const events = record(result.stopped).events;
  if (
    !Array.isArray(events) ||
    !events.includes("indexeddb-open-resolved") ||
    events.includes("filesystem-epoch-requested")
  )
    throw new Error("pending claim did not stay before epoch after a real native open");
  equal(await control(holder, "persistentOrdinaryRead"), [11, 22, 33, 44]);
  equal(await control(owner, "persistentInspect", name), before);
  await control(owner, "persistentDeath");
  await control(holder, "persistentOrdinaryRelease");
  console.log("P1_PENDING_NATIVE_CLAIM=" + JSON.stringify(result));
  console.log(
    "PASS pending native claim cancels after real DB open while ordinary worker retains its lock, epoch and bytes",
  );
}
async function lateRequestControl(owner: Page, holder: Page, failClose: boolean): Promise<void> {
  const name = `waffle-u1-late-request-${crypto.randomUUID()}`;
  equal(await control(holder, "persistentBlockNativeOpen", name), { blocked: true });
  const result = record(
    await control(owner, "persistentBeginLateRequest", {
      ...record(persistentAttempt(name)),
      failClose,
    }),
  );
  equal(result.ready, false);
  equal(result.pending, true);
  if (
    !Array.isArray(result.events) ||
    !result.events.includes("indexeddb-open-requested") ||
    result.events.includes("indexeddb-open-resolved")
  )
    throw new Error("native open was not physically pending at abort");
  equal(await control(holder, "persistentProbe", name), false);
  await control(holder, "persistentUnblockNativeOpen");
  const stopped = record(await control(owner, "persistentStop"));
  equal(stopped.same, true);
  equal(stopped.stopped, !failClose);
  if (failClose) {
    equal(stopped.originalFailure, true);
    equal(await control(owner, "persistentStop"), stopped);
    equal(await control(holder, "persistentProbe", name), false);
  } else cancelledBeforeLoad({ ready: false, stopped });
  console.log("P1_LATE_NATIVE_REQUEST=" + JSON.stringify({ failClose, result, stopped }));
  if (failClose) await control(owner, "persistentDeath");
  equal(await control(holder, "persistentProbe", name), true);
  await control(owner, "persistentDelete", name);
  console.log(
    `PASS physically pending native request joins actual late delivery and ${failClose ? "retains original failed close and guards" : "closes before guards release"}`,
  );
}
async function epochCancellationControl(owner: Page, name: string): Promise<void> {
  const before = record(await control(owner, "persistentInspect", name));
  const result = record(await control(owner, "persistentCancelEpoch", persistentAttempt(name)));
  cancelledBeforeLoad(result);
  const events = record(result.stopped).events;
  if (!Array.isArray(events) || !events.includes("filesystem-epoch-resolved"))
    throw new Error("actual epoch transaction did not complete before cancellation");
  const after = record(await control(owner, "persistentInspect", name));
  equal(after.epoch, Number(before.epoch) + 1);
  equal(after.generation, before.generation);
  await control(owner, "persistentDeath");
  console.log("P1_NATIVE_EPOCH_CANCELLATION=" + JSON.stringify(result));
  console.log(
    "PASS granted native epoch retires before cancelled factory closes without adapter load",
  );
}
async function closePersistentHolder(owner: Page, holder: Page, workspace: unknown): Promise<void> {
  if (typeof workspace !== "string") throw new Error("persistent workspace missing");
  const lockName = `waffle:publication:continuity:${workspace}`;
  const released = owner.evaluate(
    (name) => navigator.locks.request(name, { mode: "exclusive" }, () => {}),
    lockName,
  );
  void released.catch(() => {});
  await owner.waitForFunction(async (name) => {
    const locks = await navigator.locks.query();
    return (
      locks.held?.some((lock) => lock.name === name && lock.mode === "shared") &&
      locks.pending?.some((lock) => lock.name === name && lock.mode === "exclusive")
    );
  }, lockName);
  await holder.close();
  await released;
  console.log("PASS native continuity release acknowledged after surviving holder page closes");
}
async function persistentOwnerControls(browser: Browser, origin: string): Promise<void> {
  const context = await browser.newContext();
  const name = `waffle-u1-native-${crypto.randomUUID()}`;
  try {
    const owner = await context.newPage(),
      holder = await context.newPage();
    for (const page of [owner, holder]) {
      await observeDeaths(page);
      await page.goto(origin);
    }
    await control(owner, "persistentSeed", name);
    await pendingClaimControl(owner, holder, name);
    await lateRequestControl(owner, holder, false);
    await lateRequestControl(owner, holder, true);
    await epochCancellationControl(owner, name);
    const before = await control(owner, "persistentInspect", name);
    await control(holder, "persistentHold", name);
    for (const attempt of ["first-live-holder", "second-explicit-live-holder"]) {
      const denied = record(await control(owner, "persistentStart", persistentAttempt(name)));
      equal(denied.ready, false);
      noFactoryNativeOpen(denied);
      const stopped = record(await control(owner, "persistentStop"));
      equal(stopped.same, true);
      equal(stopped.stopped, true);
      equal(await control(owner, "persistentInspect", name), before);
      console.log(
        `PASS ${attempt} refused before factory native open/claim/load; readonly inspection unchanged`,
      );
    }
    await control(holder, "persistentRelease");
    const first = readyPersistent(await control(owner, "persistentStart", persistentAttempt(name)));
    equal(await control(holder, "persistentRead", first.descriptor), {
      first: [11, 22, 33, 44],
      second: [91, 82, 73],
      mode: 0o400,
      size: 4,
    });
    nativeClosedBeforeRelease(await control(owner, "persistentStop"));
    const reopened = readyPersistent(
      await control(owner, "persistentStart", persistentAttempt(name, first.identity)),
    );
    const previous = record(first.identity),
      fresh = record(reopened.identity);
    if (previous.instance === fresh.instance || previous.history === fresh.history)
      throw new Error("reopen reused history or instance");
    if (typeof fresh.history !== "string") throw new Error("reopened history missing");
    const recoveredCut = { history: fresh.history, generation: 0 };
    equal(await control(holder, "persistentRead", reopened.descriptor), {
      first: [11, 22, 33, 44],
      second: [91, 82, 73],
      mode: 0o400,
      size: 4,
    });
    nativeClosedBeforeRelease(await control(owner, "persistentStop"));
    console.log(
      "PASS private factory same-name explicit v1 reopen, fresh identities, cold namespace bytes/mode and native-close-before-final-guard-release",
    );
    const aborted = record(
      await control(owner, "persistentAbortLateOpen", persistentAttempt(name)),
    );
    equal(aborted.ready, false);
    equal(aborted.pendingBeforeRelease, true);
    nativeClosedBeforeRelease(record(aborted.stopped));
    console.log("PASS abort joins a late actual native adapter and never publishes readiness");
    readyPersistent(await control(owner, "persistentStart", persistentAttempt(name)), recoveredCut);
    await control(owner, "persistentFailClose");
    const failed = record(await control(owner, "persistentStop"));
    equal(failed.same, true);
    equal(failed.stopped, false);
    equal(await control(owner, "persistentStop"), failed);
    equal(await control(holder, "persistentProbe", name), false);
    await control(owner, "persistentDeath");
    const afterFailure = readyPersistent(
      await control(owner, "persistentStart", persistentAttempt(name)),
      recoveredCut,
    );
    await control(holder, "workspacePeer", afterFailure.descriptor);
    await control(owner, "persistentDeath");
    const survivorDenied = record(await control(owner, "persistentStart", persistentAttempt(name)));
    equal(survivorDenied.ready, false);
    noFactoryNativeOpen(survivorDenied);
    console.log("P1_SURVIVOR_DENIED=" + JSON.stringify(survivorDenied));
    equal(record(await control(owner, "persistentStop")).stopped, true);
    await closePersistentHolder(owner, holder, record(afterFailure.descriptor).workspace);
    readyPersistent(await control(owner, "persistentStart", persistentAttempt(name)), recoveredCut);
    nativeClosedBeforeRelease(await control(owner, "persistentStop"));
    console.log(
      "PASS failed native close stays failed; surviving real attachment blocks replacement until genuine realm destruction",
    );
    await control(owner, "persistentDelete", name);
  } finally {
    await context.close();
  }
}
async function run(name: string, origin: string, persistentOnly: boolean): Promise<void> {
  if (name !== "chromium" && name !== "firefox" && name !== "webkit")
    throw new Error(`unknown engine ${name}`);
  const browser = await lifecycle.launch(name);
  try {
    if (persistentOnly) {
      await persistentOwnerControls(browser, origin);
      console.log(`${name} ${browser.version()}: private persistent owner controls passed`);
      return;
    }
    const context = await browser.newContext();
    const first = await context.newPage(),
      second = await context.newPage();
    for (const page of [first, second]) {
      page.on("console", (message) => console.log(message.text()));
      page.on("pageerror", (error) => console.error(error));
      await observeDeaths(page);
      await page.goto(origin);
    }
    await currentPersistentBaseline(first);
    await persistentOwnerControls(browser, origin);
    const lifecycleControl = await control(first, "guardLifecycle");
    console.log("GUARD_LIFECYCLE=" + JSON.stringify(lifecycleControl));
    equal(lifecycleControl, { pending: 6, failed: 11, idleStopped: 11, queued: 11, stopped: true });
    const survivor = await control(first, "ordinarySurvivor");
    console.log("ORDINARY_SURVIVOR=" + JSON.stringify(survivor));
    const descriptor = await control(first, "authority", `resident-${crypto.randomUUID()}`);
    equal(await control(second, "peer", descriptor), {
      attached: true,
      authorityRootReceived: false,
    });
    await control(first, "startGuest", "wasi");
    await control(second, "startGuest", "proc");
    await control(second, "armDefensiveHooks", { mode: "proc" });
    const initial = record(await control(first, "authorityInspect"));
    equal(initial.count, 3);
    const failed = record(
      await control(second, "call", { mode: "proc", request: { kind: "write", bytes: [8] } }),
    );
    equal(failed.result, -6);
    equal(failed.offset, 0);
    equal(failed.bytes, [8]);
    await control(second, "prepare", {
      mode: "proc",
      request: { kind: "write", offset: 0, maxBytes: 1 },
    });
    equal(await control(first, "authorityBypass"), { read: -6, write: -6, namespace: 6, lock: 0 });
    const write = record(
      await control(second, "call", { mode: "proc", request: { kind: "write", bytes: [9] } }),
    );
    equal(write.result, 1);
    equal(write.offset, 1);
    const intercepted = await control(second, "defensiveResult", { mode: "proc" });
    console.log("PRIVATE_VIEW_INTERCEPTIONS=" + JSON.stringify(intercepted));
    equal(survivor, {
      before: 1,
      activated: -6,
      survivor: -6,
      observedNativeAuthorityDeath: true,
      exclusive: true,
      descendant: -6,
    });
    equal(intercepted, 0);
    console.log("PASS ordinary survivor exclusion and post-exposure defensive private-view hooks");
    equal(record(await control(first, "authorityInspect")).count, -6);
    // No settle/nudge is sent after ACK. The next request must query the old cell.
    await control(second, "prepare", { mode: "proc", request: { kind: "append", maxBytes: 2 } });
    const append = record(
      await control(second, "call", { mode: "proc", request: { kind: "append", bytes: [4, 5] } }),
    );
    equal(append.result, 2);
    equal(append.offset, 5);
    equal(record(await control(first, "authorityInspect")).count, -6);
    await control(first, "prepare", {
      mode: "wasi",
      request: { kind: "read", offset: 0, maxBytes: 5 },
    });
    const read = record(
      await control(first, "call", {
        mode: "wasi",
        request: { kind: "read", offset: 0, bytes: [80, 80, 80, 80, 80] },
      }),
    );
    equal(read.result, 0);
    equal(read.count, 5);
    equal(read.bytes, [9, 2, 3, 4, 5]);
    equal(read.offset, 5);
    await control(first, "settle", { mode: "wasi" });
    const repeat = await control(second, "settle", { mode: "proc" });
    equal(await control(second, "settle", { mode: "proc" }), repeat);
    const final = record(await control(first, "authorityInspect"));
    equal(final.count, 5);
    equal(record(final.cut).generation, 2);
    const changes = record(await control(first, "changes", initial.cut));
    equal(changes.kind, "changes");
    if (!Array.isArray(changes.publications)) throw new Error("missing complete groups");
    equal(changes.publications.length, 2);
    for (let index = 0; index < changes.publications.length; index++) {
      const group = record(changes.publications[index]),
        receipt = record(group.receipt);
      equal(record(receipt.cut).generation, index + 1);
      equal(record(receipt.cut).history, record(initial.cut).history);
      equal(record(receipt.id).sequence, index + 1);
      equal(receipt.durability, { kind: "untracked" });
      if (!Array.isArray(group.changes)) throw new Error("missing complete effects");
      equal(group.changes.length, 2);
      equal(
        group.changes.map((effect) => record(effect).kind),
        ["bytes", "metadata"],
      );
    }
    equal(record(record(record(changes.publications[1]).receipt).result), {
      kind: "append",
      written: 2,
      offset: 5,
    });
    console.log(
      "PASS independent pages, real runtime_proc writes/append and Preview1 current read, no root SAB transfer, no commit nudge, exact two groups",
    );
    equal(await control(first, "lateAttachment"), { accepted: false, count: 1, bytes: [9] });
    console.log(
      "PASS late open cancellation joins exact session cleanup without detaching successor",
    );
    equal(await control(first, "latePreparation"), {
      denied: true,
      count: 5,
      generation: 2,
      bytes: [9, 2, 3, 4, 5, 90, 90, 90],
    });
    console.log(
      "PASS stopped late readiness cancels exactly once before guard release, with no captured input or effects",
    );
    equal(await control(first, "oldSettlement"), { denied: true, queries: 1, current: "ready" });
    console.log(
      "PASS duplicate old cancellation cannot erase the next READY grant from transport status tracking",
    );
    equal(await control(first, "queuedAttachment"), { accepted: false, joined: true });
    equal(record(await control(first, "cancelledStartup")).setupCount, 0);
    console.log(
      "PASS queued acquisition cancellation joins cleanup and actual cancelled bootstrap never reaches setup",
    );
    const recovery = await context.newPage();
    await recovery.goto(origin);
    equal(await control(recovery, "peer", descriptor), {
      attached: true,
      authorityRootReceived: false,
    });
    await control(recovery, "pageStop");
    await control(first, "stopGuest", { mode: "wasi" });
    await control(second, "prepare", {
      mode: "proc",
      request: { kind: "write", offset: 5, maxBytes: 1 },
    });
    await control(second, "armClaim", { mode: "proc", request: { kind: "write", bytes: [7] } });
    await control(first, "pageStop");
    await control(second, "pageStop");
    equal(await control(first, "authorityDeath"), { observedNativeDeath: true });
    equal(await control(first, "exclusive"), false);
    await first.close();
    equal(await control(recovery, "exclusive"), false);
    // Creator-page closure is not claimant death. Its actual worker on the other page
    // still holds workspace continuity, including across a replacement epoch.
    await new Promise((resolve) => setTimeout(resolve, 3200));
    equal(await control(recovery, "exclusive"), false);
    equal(await control(second, "guestDeath", { mode: "proc" }), { observedNativeDeath: true });
    equal(await control(recovery, "exclusive"), true);
    console.log(
      "PASS CLAIMED live worker blocks exclusive continuity after creator authority death, creator page close and timeout; separate native worker death releases guard",
    );
    await context.close();
    await workspaceControls(browser, origin);
    await workspaceCleanupControls(browser, origin);
    console.log(`${name} ${browser.version()}: focused resident and workspace controls passed`);
  } finally {
    await lifecycle.closeBrowser(browser);
  }
}
try {
  await lifecycle.init();
  const origin = lifecycle.serve(
    {
      "/": "<!doctype html><title>Private resident controls</title>",
      "/cross-tab.js": await browserBundle(
        resolve(import.meta.dir, "publication-cross-tab-browser.ts"),
      ),
      "/resident-authority.js": await browserBundle(
        resolve(import.meta.dir, "fixtures/publication-resident-authority.ts"),
      ),
      "/resident-guest.js": await guestBundle(),
      "/fs-worker.js": await browserBundle(resolve(import.meta.dir, "../browser/fs-worker.ts")),
    },
    Number(process.env.PUBLICATION_CROSS_TAB_PORT ?? 0),
  );
  const cleanupOnly = process.argv.includes("--workspace-cleanup-only");
  const persistentOnly = process.argv.includes("--persistent-owner-only");
  const names = process.argv
    .slice(2)
    .filter((name) => name !== "--persistent-owner-only" && name !== "--workspace-cleanup-only");
  for (const name of names.length ? names : ["chromium"]) {
    if (cleanupOnly) await runWorkspaceCleanup(name, origin);
    else await run(name, origin, persistentOnly);
  }
} finally {
  await lifecycle.close();
}
