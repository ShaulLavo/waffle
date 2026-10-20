import { storageLockKeepAlive } from "./fixtures/storage-lock-startup.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import type { Page, BrowserContext } from "playwright";

const args = process.argv.slice(2);
function option(name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value) throw new Error(`Missing value for ${name}`);
  args.splice(index, 2);
  return value;
}

const source = resolve(option("--source", resolve(import.meta.dir, "..")));
const dependencies = resolve(option("--dependencies", source));
const requestedEngines = args.length ? args : ["chromium", "firefox", "webkit"];
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync("/work/cache/ms-playwright")) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = "/work/cache/ms-playwright";
}
const require = createRequire(resolve(dependencies, "package.json"));
const { chromium, firefox, webkit } = await import(
  pathToFileURL(require.resolve("playwright")).href
);

type EngineName = "chromium" | "firefox" | "webkit";
type Backend = "opfs" | "indexeddb";

type TestCase = {
  label: string;
  backend: Backend;
  run(context: BrowserContext, baseURL: string, name: string): Promise<void>;
};

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function text(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
function uniqueName(label: string): string {
  return `storage-lock-${label}-${crypto.randomUUID()}`;
}
function lockName(backend: Backend, name: string): string {
  return backend === "indexeddb"
    ? `bun-wasm:filesystem:indexeddb:${name}`
    : `bun-wasm:filesystem:${name}`;
}

async function pageFixture(context: BrowserContext, baseURL: string): Promise<Page> {
  const page = (await context.newPage()) as Page;
  await page.goto(baseURL);
  await page.waitForFunction(() => (globalThis as any).lockTest !== undefined);
  return page;
}
async function startPage(
  page: Page,
  backend: Backend,
  name: string,
  whenBusy?: "wait" | "takeover",
  gatedRecovery: boolean | "recovered" = false,
): Promise<void> {
  await page.evaluate(
    ({ backend, name, whenBusy, gatedRecovery }) =>
      (globalThis as any).lockTest.start(backend, name, whenBusy, gatedRecovery),
    { backend, name, whenBusy, gatedRecovery },
  );
}
async function openFilesystem(
  context: BrowserContext,
  baseURL: string,
  backend: Backend,
  name: string,
  whenBusy?: "wait" | "takeover",
  gatedRecovery: boolean | "recovered" = false,
): Promise<Page> {
  const page = await pageFixture(context, baseURL);
  await startPage(page, backend, name, whenBusy, gatedRecovery);
  return page;
}
async function waitState(page: Page, expected: string): Promise<void> {
  await page.waitForFunction((status) => {
    const current = (globalThis as any).lockTest.state().status;
    return (
      current === status ||
      current === "failed" ||
      current === "disposed" ||
      ((status === "waiting" || status === "failed") && current === "ready")
    );
  }, expected);
  const current = await state(page);
  assert(current.status === expected, `Expected ${expected}, got ${JSON.stringify(current)}`);
}
async function state(
  page: Page,
): Promise<{ status: string; error?: string; code?: string; vfs?: string }> {
  return await page.evaluate(() => (globalThis as any).lockTest.state());
}
async function assertWaiting(page: Page, label: string): Promise<void> {
  await waitState(page, "waiting");
  const current = await state(page);
  assert(
    current.status === "waiting" && !current.error,
    `${label} was not a clean waiting state: ${JSON.stringify(current)}`,
  );
}
async function assertReady(page: Page, label: string): Promise<void> {
  await waitState(page, "ready");
  const current = await state(page);
  assert(current.status === "ready", `${label} was not ready: ${JSON.stringify(current)}`);
}
async function dispose(page: Page): Promise<void> {
  await page.evaluate(() => (globalThis as any).lockTest.dispose());
}
async function barrier(page: Page, backend: Backend, name: string): Promise<void> {
  await page.evaluate(
    ({ backend, name }) => (globalThis as any).lockTest.lockBarrier(backend, name),
    { backend, name },
  );
}
async function query(page: Page): Promise<any> {
  return await page.evaluate(() => (globalThis as any).lockTest.queryLocks());
}
async function closePages(pages: Page[]): Promise<void> {
  for (const page of pages) if (!page.isClosed()) await page.close();
}

async function contested(
  context: BrowserContext,
  baseURL: string,
  backend: Backend,
  name: string,
): Promise<void> {
  const pages: Page[] = [];
  try {
    const owner = await openFilesystem(context, baseURL, backend, name, "wait");
    pages.push(owner);
    await assertReady(owner, "owner");
    assert(
      (await owner.evaluate(() => (globalThis as any).lockTest.seed())) === "durable marker",
      "owner seed failed",
    );
    const waiter = await openFilesystem(
      context,
      baseURL,
      backend,
      name,
      backend === "opfs" ? undefined : "wait",
    );
    pages.push(waiter);
    await assertWaiting(waiter, "contender");
    const locks = await query(waiter);
    const applicationLock = lockName(backend, name);
    assert(
      locks.pending?.some((lock: any) => lock.name === applicationLock),
      `waiting ${backend} page did not queue ${applicationLock}`,
    );
    await dispose(owner);
    await owner.close();
    await assertReady(waiter, "waiter after owner disposal");
    assert(
      (await waiter.evaluate(() => (globalThis as any).lockTest.readSaved())) === "durable marker",
      `${backend} waiter lost flushed data`,
    );
  } finally {
    await closePages(pages);
  }
}

async function earlyReload(
  context: BrowserContext,
  baseURL: string,
  backend: Backend,
  name: string,
): Promise<void> {
  const pages: Page[] = [];
  try {
    const owner = await openFilesystem(context, baseURL, backend, name, "wait");
    pages.push(owner);
    await assertReady(owner, "early-reload owner");
    await owner.evaluate(() => (globalThis as any).lockTest.seed());
    const waiter = await openFilesystem(context, baseURL, backend, name, "wait");
    pages.push(waiter);
    await assertWaiting(waiter, "early-reload waiter");
    await owner.close();
    await waiter.reload();
    await waiter.waitForFunction(() => (globalThis as any).lockTest !== undefined);
    await startPage(waiter, backend, name, "wait");
    await assertReady(waiter, "reloaded waiter");
    assert(
      (await waiter.evaluate(() => (globalThis as any).lockTest.readSaved())) === "durable marker",
      `${backend} early reload lost flushed data`,
    );
  } finally {
    await closePages(pages);
  }
}

async function crashedOwner(
  context: BrowserContext,
  baseURL: string,
  backend: Backend,
  name: string,
): Promise<void> {
  const pages: Page[] = [];
  try {
    const owner = await openFilesystem(context, baseURL, backend, name, "wait");
    pages.push(owner);
    await assertReady(owner, "crash owner");
    await owner.evaluate(() => (globalThis as any).lockTest.seed());
    const waiter = await openFilesystem(context, baseURL, backend, name, "wait");
    pages.push(waiter);
    await assertWaiting(waiter, "crash waiter");
    // Deliberately skip dispose: this models a tab/worker crash and exercises browser cleanup.
    await owner.close();
    await assertReady(waiter, "waiter after owner crash");
    assert(
      (await waiter.evaluate(() => (globalThis as any).lockTest.readSaved())) === "durable marker",
      `${backend} crash handoff lost data`,
    );
  } finally {
    await closePages(pages);
  }
}

async function cancelWhileWaiting(
  context: BrowserContext,
  baseURL: string,
  backend: Backend,
  name: string,
): Promise<void> {
  const pages: Page[] = [];
  try {
    const owner = await openFilesystem(context, baseURL, backend, name, "wait");
    pages.push(owner);
    await assertReady(owner, "cancel owner");
    const waiter = await openFilesystem(context, baseURL, backend, name, "wait");
    pages.push(waiter);
    await assertWaiting(waiter, "cancel waiter");
    await waiter.evaluate(() => (globalThis as any).lockTest.beginWrite("must never be replayed"));
    await waiter.evaluate(async () => {
      await (globalThis as any).lockTest.dispose();
      await (globalThis as any).lockTest.dispose();
    });
    await waiter.waitForFunction(
      () => (globalThis as any).lockTest.operation().status === "rejected",
    );
    const cancelled = await waiter.evaluate(() => (globalThis as any).lockTest.operation());
    assert(
      cancelled.errno === 11,
      `cancelled guest work did not reject with ECANCELED: ${JSON.stringify(cancelled)}`,
    );
    const afterDispose = await state(waiter);
    assert(
      afterDispose.status === "disposed",
      `waiting dispose did not settle as disposed: ${JSON.stringify(afterDispose)}`,
    );
    const disposedCount = (
      await waiter.evaluate(() => (globalThis as any).lockTest.states())
    ).filter((item: any) => item.status === "disposed").length;
    assert(disposedCount === 1, `dispose was reported ${disposedCount} times`);
    const resources = await waiter.evaluate(() => (globalThis as any).lockTest.resources());
    assert(
      resources.terminations === 1,
      `waiting disposal terminated its worker ${resources.terminations} times`,
    );
    assert(
      resources.clientDisposals === 1,
      `waiting disposal released its client ${resources.clientDisposals} times`,
    );
    const third = await pageFixture(context, baseURL);
    pages.push(third);
    const locks = await query(third);
    const applicationLock = lockName(backend, name);
    assert(
      !locks.pending?.some((lock: any) => lock.name === applicationLock),
      `cancelled ${backend} waiter left a queued lock request`,
    );
    await dispose(owner);
    await barrier(third, backend, name);
    await startPage(third, backend, name, "wait");
    await assertReady(third, "third page after cancelled waiter");
    assert(
      (await third.evaluate(() => (globalThis as any).lockTest.readQueued())) === undefined,
      "cancelled mutation was replayed",
    );
  } finally {
    await closePages(pages);
  }
}

async function fifoWaiters(
  context: BrowserContext,
  baseURL: string,
  backend: Backend,
  name: string,
): Promise<void> {
  const pages: Page[] = [];
  try {
    const owner = await openFilesystem(context, baseURL, backend, name, "wait");
    pages.push(owner);
    await assertReady(owner, "FIFO owner");
    const waiters: Page[] = [];
    for (let index = 0; index < 3; index++) {
      const waiter = await openFilesystem(context, baseURL, backend, name, "wait");
      pages.push(waiter);
      waiters.push(waiter);
      await assertWaiting(waiter, `FIFO waiter ${index}`);
      const snapshot = await query(waiter);
      const queued = snapshot.pending?.filter(
        (lock: any) => lock.name === lockName(backend, name),
      ).length;
      assert(
        queued === index + 1,
        `FIFO request ${index} was not queued before its successor: ${JSON.stringify(snapshot)}`,
      );
    }
    await dispose(owner);
    for (let index = 0; index < waiters.length; index++) {
      await assertReady(waiters[index]!, `FIFO waiter ${index} ownership`);
      for (let peer = index + 1; peer < waiters.length; peer++) {
        const peerState = await state(waiters[peer]!);
        assert(
          peerState.status === "waiting",
          `FIFO waiter ${peer} became ${peerState.status} while waiter ${index} owned lock`,
        );
      }
      if (index + 1 < waiters.length) await dispose(waiters[index]!);
    }
    await dispose(waiters[waiters.length - 1]!);
  } finally {
    await closePages(pages);
  }
}

async function guestWork(
  context: BrowserContext,
  baseURL: string,
  backend: Backend,
  name: string,
): Promise<void> {
  const pages: Page[] = [];
  try {
    const owner = await openFilesystem(context, baseURL, backend, name, "wait");
    pages.push(owner);
    await assertReady(owner, "guest-work owner");
    const waiter = await openFilesystem(context, baseURL, backend, name, "wait");
    pages.push(waiter);
    await assertWaiting(waiter, "guest-work waiter");
    await waiter.evaluate(() => (globalThis as any).lockTest.beginWrite("queued until ownership"));
    const operation = await waiter.evaluate(() => (globalThis as any).lockTest.operation());
    assert(
      operation.status === "pending",
      `guest mutation ran before ownership: ${JSON.stringify(operation)}`,
    );
    await dispose(owner);
    await assertReady(waiter, "guest-work waiter ownership");
    await waiter.waitForFunction(
      () => (globalThis as any).lockTest.operation().status === "fulfilled",
    );
    assert(
      (await waiter.evaluate(() => (globalThis as any).lockTest.readQueued())) ===
        "queued until ownership",
      `${backend} queued guest work did not run after ownership`,
    );
  } finally {
    await closePages(pages);
  }
}

async function indexedDBTakeover(
  context: BrowserContext,
  baseURL: string,
  name: string,
  policy?: "takeover",
): Promise<void> {
  const pages: Page[] = [];
  try {
    const owner = await openFilesystem(context, baseURL, "indexeddb", name);
    pages.push(owner);
    await assertReady(owner, "takeover owner");
    const contender = await openFilesystem(context, baseURL, "indexeddb", name, policy);
    pages.push(contender);
    await assertReady(contender, "takeover contender");
    await owner.waitForFunction(() => (globalThis as any).lockTest.state().status === "failed");
    const ownerState = await state(owner);
    assert(
      ownerState.error?.includes("opened in another tab") === true,
      `takeover owner error changed: ${JSON.stringify(ownerState)}`,
    );
    assert(
      (await contender.evaluate(() => (globalThis as any).lockTest.seed())) === "durable marker",
      "takeover owner could not write after stealing",
    );
  } finally {
    await closePages(pages);
  }
}

async function waitProbe(page: Page, probe: string): Promise<void> {
  await page.waitForFunction(
    (probe) => (globalThis as any).lockTest.probes().includes(probe),
    probe,
  );
}

async function recoveryOwnershipLoss(
  context: BrowserContext,
  baseURL: string,
  name: string,
  timing: "disposing" | "recovering" | "ready",
): Promise<void> {
  const pages: Page[] = [];
  try {
    const owner = await openFilesystem(context, baseURL, "indexeddb", name, "wait", true);
    pages.push(owner);
    await waitProbe(owner, "probe-recovery");
    const snapshot = await query(owner);
    assert(
      snapshot.held?.some((lock: any) => lock.name === lockName("indexeddb", name)),
      "recovery gate entered without owning the workspace lock",
    );
    const gatedState = await state(owner);
    assert(
      gatedState.status === "opening" || gatedState.status === "waiting",
      `gated owner left startup before recovery finished: ${JSON.stringify(gatedState)}`,
    );
    if (timing === "ready") {
      await owner.evaluate(() => (globalThis as any).lockTest.releaseRecovery());
      await assertReady(owner, "owner after gated recovery");
      await owner.evaluate(() => (globalThis as any).lockTest.seed());
    } else {
      await owner.evaluate(() => (globalThis as any).lockTest.beginWrite("must never be replayed"));
      assert(
        (await owner.evaluate(() => (globalThis as any).lockTest.operation())).status === "pending",
        "guest work escaped gated recovery",
      );
      if (timing === "disposing") {
        await owner.evaluate(() => (globalThis as any).lockTest.beginDispose());
        await waitProbe(owner, "probe-dispose-received");
        const beforeLoss = await owner.evaluate(() => ({
          disposal: (globalThis as any).lockTest.disposal(),
          resources: (globalThis as any).lockTest.resources(),
        }));
        assert(
          beforeLoss.disposal.status === "pending" && beforeLoss.resources.terminations === 0,
          `startup disposal did not retain the recovering worker: ${JSON.stringify(beforeLoss)}`,
        );
      }
    }
    const successor = await openFilesystem(context, baseURL, "indexeddb", name);
    pages.push(successor);
    // Observe the actual worker message, even when the page ignores it during disposal.
    await waitProbe(owner, "filesystem-ownership-lost");
    if (timing !== "ready") {
      // Without disposal the page terminates its failed worker; posting to that worker
      // is harmless. In the disposal race this releases the retained cleanup path.
      await owner.evaluate(() => (globalThis as any).lockTest.releaseRecovery());
    }
    if (timing === "disposing") {
      await owner.waitForFunction(
        () => (globalThis as any).lockTest.disposal().status !== "pending",
      );
      const disposal = await owner.evaluate(() => (globalThis as any).lockTest.disposal());
      assert(
        disposal.status === "fulfilled",
        `ownership loss stranded startup disposal: ${JSON.stringify(disposal)}`,
      );
      await waitProbe(owner, "filesystem-disposed");
      assert((await state(owner)).status === "disposed", "ownership loss replaced disposed state");
    } else {
      await waitState(owner, "failed");
      assert(
        (await state(owner)).error?.includes("opened in another tab"),
        "ownership loss did not expose its typed failure",
      );
      await owner.evaluate(() => (globalThis as any).lockTest.beginDispose());
      await owner.waitForFunction(
        () => (globalThis as any).lockTest.disposal().status !== "pending",
      );
      assert(
        (await owner.evaluate(() => (globalThis as any).lockTest.disposal())).status ===
          "fulfilled",
        "failed owner's disposal did not settle",
      );
    }
    await dispose(owner);
    const resources = await owner.evaluate(() => (globalThis as any).lockTest.resources());
    assert(
      resources.terminations === 1 && resources.clientDisposals === 1,
      `ownership loss released resources more than once: ${JSON.stringify(resources)}`,
    );
    await assertReady(successor, "takeover successor");
    if (timing !== "ready") {
      await owner.waitForFunction(
        () => (globalThis as any).lockTest.operation().status === "rejected",
      );
      const operation = await owner.evaluate(() => (globalThis as any).lockTest.operation());
      if (timing === "disposing")
        assert(
          operation.errno === 11,
          `cancelled recovery operation did not reject with ECANCELED: ${JSON.stringify(operation)}`,
        );
      else
        assert(
          operation.error?.includes("opened in another tab"),
          `recovery operation did not report ownership loss: ${JSON.stringify(operation)}`,
        );
      assert(
        (await successor.evaluate(() => (globalThis as any).lockTest.readQueued())) === undefined,
        "failed recovery replayed a queued mutation",
      );
    } else {
      assert(
        (await successor.evaluate(() => (globalThis as any).lockTest.readSaved())) ===
          "durable marker",
        "ready owner's flushed data did not survive takeover",
      );
    }
  } finally {
    await closePages(pages);
  }
}

async function lateRecoveryPublication(
  context: BrowserContext,
  baseURL: string,
  name: string,
): Promise<void> {
  const pages: Page[] = [];
  try {
    const owner = await openFilesystem(context, baseURL, "indexeddb", name, "wait", "recovered");
    pages.push(owner);
    await waitProbe(owner, "probe-recovered");
    await owner.evaluate(() =>
      (globalThis as any).lockTest.beginDirectWrite("queued", "stale recovered mutation"),
    );
    assert(
      (await owner.evaluate(() => (globalThis as any).lockTest.directWrite("queued"))).status ===
        "pending",
      "queued write escaped load recovery gate",
    );
    const successor = await openFilesystem(context, baseURL, "indexeddb", name);
    pages.push(successor);
    await waitProbe(owner, "filesystem-ownership-lost");
    const beforeRelease = await state(owner);
    assert(
      beforeRelease.status === "opening" || beforeRelease.status === "waiting",
      `held ownership-loss message reached page: ${JSON.stringify(beforeRelease)}`,
    );
    await owner.evaluate(() => (globalThis as any).lockTest.releaseRecovery());
    // A terminal startup message is the barrier: merely observing recovery's
    // return would race the production factory's continuation and publication.
    await owner.waitForFunction(() => {
      const probes = (globalThis as any).lockTest.probes();
      return probes.includes("filesystem-error") || probes.includes("filesystem-state:ready");
    });
    const probes = await owner.evaluate(() => (globalThis as any).lockTest.probes());
    assert(
      !probes.includes("filesystem-state:ready"),
      "worker published a recovered backend after ownership was lost",
    );
    assert(
      probes.includes("probe-backend-disposed"),
      "worker did not dispose the backend returned after ownership loss",
    );
    await waitState(owner, "failed");
    await owner.evaluate(() =>
      (globalThis as any).lockTest.beginDirectWrite("new", "new stale mutation"),
    );
    for (const label of ["queued", "new"]) {
      await owner.waitForFunction(
        (label) => (globalThis as any).lockTest.directWrite(label).status !== "pending",
        label,
      );
      const result = await owner.evaluate(
        (label) => (globalThis as any).lockTest.directWrite(label),
        label,
      );
      assert(
        result.status === "rejected" &&
          result.isError === true &&
          typeof result.name === "string" &&
          typeof result.message === "string",
        `${label} writeFile did not reject with an Error: ${JSON.stringify(result)}`,
      );
    }
    await owner.evaluate(() => (globalThis as any).lockTest.releaseOwnershipLoss());
    await dispose(owner);
    const resources = await owner.evaluate(() => (globalThis as any).lockTest.resources());
    assert(
      resources.terminations === 1 && resources.clientDisposals === 1,
      `late recovery cleanup was not exactly once: ${JSON.stringify(resources)}`,
    );
    await assertReady(successor, "late-recovery takeover successor");
    assert(
      (await successor.evaluate(() => (globalThis as any).lockTest.readQueued())) === undefined,
      "late recovered backend replayed revoked work",
    );
  } finally {
    await closePages(pages);
  }
}

async function opfsTakeoverRejected(
  context: BrowserContext,
  baseURL: string,
  name: string,
): Promise<void> {
  const page = await pageFixture(context, baseURL);
  try {
    await page.evaluate((name) => (globalThis as any).lockTest.failWithOpfsTakeover(name), name);
    await waitState(page, "failed");
    const current = await state(page);
    assert(
      current.code === "INVALID_VFS_SETTINGS" && current.vfs === "opfs-memory",
      `OPFS takeover was not rejected clearly: ${JSON.stringify(current)}`,
    );
  } finally {
    await closePages([page]);
  }
}

function cases(): TestCase[] {
  const result: TestCase[] = [];
  for (const backend of ["opfs", "indexeddb"] as const) {
    result.push(
      {
        backend,
        label: "contested open waits and reads flushed data",
        run: (context, url, name) => contested(context, url, backend, name),
      },
      {
        backend,
        label: "early reload after owner close becomes ready",
        run: (context, url, name) => earlyReload(context, url, backend, name),
      },
      {
        backend,
        label: "crashed owner releases lock to waiter",
        run: (context, url, name) => crashedOwner(context, url, backend, name),
      },
      {
        backend,
        label: "dispose while waiting removes queued request",
        run: (context, url, name) => cancelWhileWaiting(context, url, backend, name),
      },
      {
        backend,
        label: "several waiters acquire ownership FIFO",
        run: (context, url, name) => fifoWaiters(context, url, backend, name),
      },
      {
        backend,
        label: "guest work remains pending until ownership",
        run: (context, url, name) => guestWork(context, url, backend, name),
      },
    );
  }
  result.push(
    {
      backend: "indexeddb",
      label: "default takeover still fences the old owner",
      run: (context, url, name) => indexedDBTakeover(context, url, name),
    },
    {
      backend: "indexeddb",
      label: "explicit takeover still fences the old owner",
      run: (context, url, name) => indexedDBTakeover(context, url, name, "takeover"),
    },
    {
      backend: "opfs",
      label: "takeover is rejected for OPFS",
      run: (context, url, name) => opfsTakeoverRejected(context, url, name),
    },
    {
      backend: "indexeddb",
      label: "ownership loss during gated recovery acknowledges disposal",
      run: (context, url, name) => recoveryOwnershipLoss(context, url, name, "disposing"),
    },
    {
      backend: "indexeddb",
      label: "ownership loss during gated recovery fails without disposal",
      run: (context, url, name) => recoveryOwnershipLoss(context, url, name, "recovering"),
    },
    {
      backend: "indexeddb",
      label: "ownership loss after gated recovery cleans up once",
      run: (context, url, name) => recoveryOwnershipLoss(context, url, name, "ready"),
    },
    {
      backend: "indexeddb",
      label: "ownership loss before recovered backend publication rejects startup",
      run: (context, url, name) => lateRecoveryPublication(context, url, name),
    },
  );
  return result;
}

let scratch: string | undefined;
let scratchCreation: Promise<string> | undefined;
let firefoxScratch: string | undefined;
let firefoxScratchCreation: Promise<string> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let context: BrowserContext | undefined;
let launching: Promise<BrowserContext> | undefined;
const previousTmp = process.env.TMPDIR;
let cleaning: Promise<void> | undefined;
async function cleanup(): Promise<void> {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    let stopped = false;
    try {
      await (context ?? (await launching?.catch(() => undefined)))?.close();
      context = undefined;
      launching = undefined;
      stopped = true;
    } finally {
      server?.stop(true);
      scratch ??= await scratchCreation?.catch(() => undefined);
      firefoxScratch ??= await firefoxScratchCreation?.catch(() => undefined);
      if (stopped) {
        if (scratch) await rm(scratch, { recursive: true, force: true });
        if (firefoxScratch) await rm(firefoxScratch, { recursive: true, force: true });
      } else
        console.error(`Browser shutdown unconfirmed; retaining ${scratch} and ${firefoxScratch}`);
      if (previousTmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmp;
    }
  })();
  return cleaning;
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(2));
  });
const deadline = setTimeout(() => {
  console.error("Storage lock browser matrix exceeded 10 minutes");
  void cleanup().finally(() => process.exit(2));
}, 600_000);

try {
  const scratchRoot =
    process.env.STORAGE_SCRATCH_ROOT ??
    (process.platform === "darwin" ? resolve(homedir(), "tmp") : tmpdir());
  await mkdir(scratchRoot, { recursive: true });
  scratchCreation = mkdtemp(resolve(scratchRoot, "wlock-"));
  scratch = await scratchCreation;
  if (cleaning) throw new Error("Storage lock runner stopped during scratch creation");
  const fixtureBuild = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "storage-lock-browser.ts")],
    target: "browser",
    plugins: [
      {
        name: "waffle-lock-source",
        setup(build) {
          build.onResolve({ filter: /^\.\.\/browser\/shared-fs\.js$/ }, () => ({
            path: resolve(source, "browser/shared-fs.ts"),
          }));
        },
      },
    ],
  });
  if (!fixtureBuild.success)
    throw new AggregateError(fixtureBuild.logs, "Storage lock fixture build failed");
  const workerBuild = await Bun.build({
    entrypoints: [resolve(source, "browser/fs-worker.ts")],
    target: "browser",
  });
  if (!workerBuild.success)
    throw new AggregateError(workerBuild.logs, "Filesystem worker build failed");
  const recoveryBuild = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "storage-lock-recovery-worker.ts")],
    target: "browser",
    plugins: [
      {
        name: "waffle-recovery-source",
        setup(build) {
          build.onResolve({ filter: /^\.\.\/fs\/persistent\.js$/ }, () => ({
            path: resolve(source, "fs/persistent.ts"),
          }));
          build.onResolve({ filter: /^\.\.\/browser\/fs-worker\.js$/ }, () => ({
            path: resolve(source, "browser/fs-worker.ts"),
          }));
        },
      },
    ],
  });
  if (!recoveryBuild.success)
    throw new AggregateError(recoveryBuild.logs, "Gated recovery worker build failed");
  const bundles = new Map([
    ["/fixture.js", await fixtureBuild.outputs[0]!.text()],
    ["/fs-worker.js", await workerBuild.outputs[0]!.text()],
    ["/recovery-fs-worker.js", await recoveryBuild.outputs[0]!.text()],
  ]);
  if (cleaning) throw new Error("Storage lock runner stopped before server setup");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const script = bundles.get(path);
      return new Response(
        script ??
          "<!doctype html><title>Waffle storage lock tests</title><script type=module src=/fixture.js></script>",
        {
          headers: {
            "content-type": script ? "text/javascript" : "text/html",
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
          },
        },
      );
    },
  });
  const failures: string[] = [];
  for (const name of requestedEngines) {
    if (!(name in { chromium, firefox, webkit })) throw new Error(`Unknown browser: ${name}`);
    const engine = ({ chromium, firefox, webkit } as Record<EngineName, any>)[name as EngineName];
    if (name === "firefox" && process.platform === "linux") {
      firefoxScratchCreation = mkdtemp(
        resolve(process.env.WAFFLE_BROWSER_SHM_ROOT ?? "/dev/shm", "waffle-lock-firefox-"),
      );
      firefoxScratch = await firefoxScratchCreation;
    }
    if (cleaning) throw new Error("Storage lock runner stopped before browser launch");
    const profileRoot = name === "firefox" && firefoxScratch ? firefoxScratch : scratch;
    const profile = resolve(profileRoot!, name);
    process.env.TMPDIR = profileRoot;
    launching = engine.launchPersistentContext(profile, {
      headless: true,
      downloadsPath: scratch,
      tracesDir: scratch,
    });
    context = await launching!;
    context.setDefaultTimeout(15_000);
    console.log(JSON.stringify({ engine: name, version: context.browser()?.version(), source }));
    await storageLockKeepAlive(context, `http://127.0.0.1:${server.port}/blank`, (diagnostic) =>
      console.error(JSON.stringify({ engine: name, source, startup: diagnostic })),
    );
    let selected = 0;
    for (const test of cases()) {
      if (
        process.env.STORAGE_LOCK_TEST_FILTER &&
        !`${test.backend}: ${test.label}`.includes(process.env.STORAGE_LOCK_TEST_FILTER)
      )
        continue;
      selected++;
      const testName = uniqueName(`${name}-${test.backend}`);
      try {
        await test.run(context, `http://127.0.0.1:${server.port}/`, testName);
        console.log(`PASS ${name} ${test.backend}: ${test.label}`);
      } catch (error) {
        const failure = `${name} ${test.backend}: ${test.label}\n${text(error)}`;
        failures.push(failure);
        console.error(`FAIL ${failure}`);
      }
    }
    if (selected === 0)
      throw new Error(
        `No storage lock cases match ${JSON.stringify(process.env.STORAGE_LOCK_TEST_FILTER)}`,
      );
    await context.close();
    context = undefined;
    launching = undefined;
    if (firefoxScratch) {
      await rm(firefoxScratch, { recursive: true, force: true });
      firefoxScratch = undefined;
      firefoxScratchCreation = undefined;
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures.map((item) => new Error(item)),
      `${failures.length} storage lock test(s) failed`,
    );
} finally {
  clearTimeout(deadline);
  await cleanup();
}
