import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { BrowserContext, Page } from "playwright";
import {
  BrowserRunnerLifecycle,
  browserBundle,
  type engines,
} from "../testing/browser-runner-lifecycle.js";
import { navigateTestPage } from "../testing/browser-navigation.js";

if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync("/work/cache/ms-playwright")) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = "/work/cache/ms-playwright";
}

type EngineName = keyof typeof engines;

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

async function openTabPage(context: BrowserContext, origin: string): Promise<Page> {
  const page = await context.newPage();
  page.on("pageerror", (err) => {
    console.error(`[multitab-browser pageerror]`, err);
  });
  await navigateTestPage(page, origin, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean((globalThis as any).multitabTest), undefined, {
    timeout: 30000,
  });
  return page;
}

async function runIndexedDBSuite(
  engine: EngineName,
  context: BrowserContext,
  origin: string,
): Promise<void> {
  // 1. 3-tab simultaneous attach: live R/W, >1 MiB chunking, conditional remove, nonblocking try*, cross-tab watch!
  {
    const name = `mt-idb-3tab-${engine}-${crypto.randomUUID()}`;
    const [pA, pB, pC] = await Promise.all([
      openTabPage(context, origin),
      openTabPage(context, origin),
      openTabPage(context, origin),
    ]);
    try {
      const a = await pA.evaluate((n) => (globalThis as any).multitabTest.open({ name: n }), name);
      assert(a.multiTab === "shared-host", `${engine}: A multiTab=${a.multiTab}`);
      assert(
        a.directSharedMemory.reads === false && a.directSharedMemory.mutations === false,
        `${engine}: expected directSharedMemory false`,
      );
      const [b, c] = await Promise.all([
        pB.evaluate((n) => (globalThis as any).multitabTest.open({ name: n }), name),
        pC.evaluate((n) => (globalThis as any).multitabTest.open({ name: n }), name),
      ]);
      assert(b.status === "ready" && c.status === "ready", `${engine}: B/C ready`);

      // Live R/W across all 3 tabs without flush!
      await pA.evaluate(
        ({ id }) => (globalThis as any).multitabTest.writeFile(id, "/a.txt", "hello-A"),
        a,
      );
      const readOnB = await pB.evaluate(
        ({ id }) => (globalThis as any).multitabTest.readFileText(id, "/a.txt"),
        b,
      );
      const readOnC = await pC.evaluate(
        ({ id }) => (globalThis as any).multitabTest.readFileText(id, "/a.txt"),
        c,
      );
      assert(readOnB === "hello-A" && readOnC === "hello-A", `${engine}: B/C read A write`);

      // Peer B writes >1 MiB (1.5 MiB) chunked payload; Peer C reads it back!
      const size = 1572864;
      await pB.evaluate(
        ({ id, sz }) => (globalThis as any).multitabTest.writeBinary(id, "/big.bin", sz, 7),
        { id: b.id, sz: size },
      );
      const bigC = await pC.evaluate(
        ({ id }) => (globalThis as any).multitabTest.readBinarySummary(id, "/big.bin"),
        c,
      );
      assert(
        bigC && bigC.byteLength === size && bigC.first === 7 && bigC.mid === 8 && bigC.last === 7,
        `${engine}: chunked binary mismatch ${JSON.stringify(bigC)}`,
      );

      // Conditional remove + mkdirp + move + listFiles
      await pC.evaluate(({ id }) => (globalThis as any).multitabTest.mkdirp(id, "/dir"), c);
      await pB.evaluate(
        ({ id }) => (globalThis as any).multitabTest.move(id, "/a.txt", "/dir/moved.txt"),
        b,
      );
      const wrongRm = await pC.evaluate(
        ({ id }) => (globalThis as any).multitabTest.remove(id, "/dir/moved.txt", "wrong"),
        c,
      );
      assert(wrongRm === false, `${engine}: wrong ifContent must return false`);
      const rightRm = await pC.evaluate(
        ({ id }) => (globalThis as any).multitabTest.remove(id, "/dir/moved.txt", "hello-A"),
        c,
      );
      assert(rightRm === true, `${engine}: matching ifContent must remove`);

      // Uniform -58 (-ENOTSUP) on direct-memory tryRead/tryWrite/tryAppend!
      const nb = await pB.evaluate(
        ({ id }) => (globalThis as any).multitabTest.checkNonBlocking(id, "/big.bin"),
        b,
      );
      assert(
        nb.tryRead === -58 && nb.tryWrite === -58 && nb.tryAppend === -58,
        `${engine}: expected uniform -58, got ${JSON.stringify(nb)}`,
      );

      // Real browser Worker WASI + runtime_proc redirection conformance on Peer B & Host A!
      await pA.evaluate(
        ({ id }) =>
          (globalThis as any).multitabTest.writeFile(id, "/cross-tab.txt", "browser-host"),
        a,
      );
      const peerProc = await pB.evaluate(
        ({ id }) => (globalThis as any).multitabTest.runWorkerRedirection(id, "browser-host"),
        b,
      );
      assert(
        peerProc.ok === true &&
          peerProc.outText === "first\nsecond\n" &&
          peerProc.crossTabRead === "browser-host",
        `${engine}: Peer worker redirection failed: ${JSON.stringify(peerProc)}`,
      );
      const hostReadOut = await pA.evaluate(
        ({ id }) => (globalThis as any).multitabTest.readFileText(id, "/out.txt"),
        a,
      );
      assert(
        hostReadOut === "first\nsecond\n",
        `${engine}: Host did not see Peer redirection output: ${JSON.stringify(hostReadOut)}`,
      );
      const hostProc = await pA.evaluate(
        ({ id }) => (globalThis as any).multitabTest.runWorkerRedirection(id, "browser-host"),
        a,
      );
      assert(
        hostProc.ok === true && hostProc.outText === "first\nsecond\n",
        `${engine}: Host worker redirection failed: ${JSON.stringify(hostProc)}`,
      );

      // Cross-tab fs.watch: B opens watch, C writes, B receives event!
      const widB = await pB.evaluate(
        ({ id }) => (globalThis as any).multitabTest.openWatch(id, "/", true),
        b,
      );
      const nextWatchB = pB.evaluate(
        ({ id, wid }) => (globalThis as any).multitabTest.nextWatch(id, wid),
        { id: b.id, wid: widB },
      );
      await pC.evaluate(
        ({ id }) => (globalThis as any).multitabTest.writeFile(id, "/event.txt", "ping"),
        c,
      );
      const ev = await nextWatchB;
      assert(
        ev.kind === "events" && ev.names.includes("event.txt"),
        `${engine}: cross-tab watch failed: ${JSON.stringify(ev)}`,
      );

      // Idle workspace returns "busy" while attached!
      const idleBusy = await pC.evaluate(
        (n) => (globalThis as any).multitabTest.openIdleStatus(n),
        name,
      );
      assert(
        idleBusy === "busy",
        `${engine}: idle must be busy while attached, got ${JSON.stringify(idleBusy)}`,
      );

      // Graceful Host close failover (NO explicit flush before dispose -> zero lost writes!)
      await pA.evaluate(
        ({ id }) => (globalThis as any).multitabTest.writeFile(id, "/unflushed.txt", "zero-loss"),
        a,
      );
      const overflowPromise = pB.evaluate(
        async ({ id, wid }) => {
          for (let i = 0; i < 8; i++) {
            const ev = await (globalThis as any).multitabTest.nextWatch(id, wid);
            if (ev.kind === "overflow") return ev;
          }
          return { kind: "timeout", names: [] };
        },
        { id: b.id, wid: widB },
      );
      await pA.evaluate(({ id }) => (globalThis as any).multitabTest.dispose(id), a);
      const overflowEv = await overflowPromise;
      assert(
        overflowEv.kind === "overflow",
        `${engine}: expected watch overflow on failover, got ${JSON.stringify(overflowEv)}`,
      );

      // Peer B/C survive failover and read the unflushed write from A!
      const survived = await pC.evaluate(
        ({ id }) => (globalThis as any).multitabTest.readFileText(id, "/unflushed.txt"),
        c,
      );
      assert(survived === "zero-loss", `${engine}: graceful failover lost write: ${survived}`);

      // Fresh watch works after failover!
      const widB2 = await pB.evaluate(
        ({ id }) => (globalThis as any).multitabTest.openWatch(id, "/", true),
        b,
      );
      const nextAfterFailover = pB.evaluate(
        ({ id, wid }) => (globalThis as any).multitabTest.nextWatch(id, wid),
        { id: b.id, wid: widB2 },
      );
      await pC.evaluate(
        ({ id }) => (globalThis as any).multitabTest.writeFile(id, "/post-failover.txt", "ok"),
        c,
      );
      const ev2 = await nextAfterFailover;
      assert(
        ev2.kind === "events" && ev2.names.includes("post-failover.txt"),
        `${engine}: post-failover watch failed: ${JSON.stringify(ev2)}`,
      );

      // Guarantee B is the active Host before testing abrupt Host crash, then re-attach C as Peer!
      await pC.evaluate(({ id }) => (globalThis as any).multitabTest.dispose(id), c);
      await pB.evaluate(({ id }) => (globalThis as any).multitabTest.flush(id), b);
      const c2 = await pC.evaluate((n) => (globalThis as any).multitabTest.open({ name: n }), name);
      assert(c2.status === "ready", `${engine}: C2 ready`);

      // Abrupt Host close failover (page.close() without dispose!)
      await pB.close();
      // Pure stateless read retries seamlessly across abrupt Host crash failover!
      const survivedCrash = await pC.evaluate(
        ({ id }) => (globalThis as any).multitabTest.readFileText(id, "/unflushed.txt"),
        c2,
      );
      assert(
        survivedCrash === "zero-loss",
        `${engine}: read across abrupt close failed: ${survivedCrash}`,
      );
      // Subsequent write succeeds on promoted Host C!
      await pC.evaluate(
        ({ id }) => (globalThis as any).multitabTest.writeFile(id, "/after-crash.txt", "alive"),
        c2,
      );
      const afterCrash = await pC.evaluate(
        ({ id }) => (globalThis as any).multitabTest.readFileText(id, "/after-crash.txt"),
        c2,
      );
      assert(afterCrash === "alive", `${engine}: abrupt close failover failed`);

      // Dispose last tab -> openIdleWorkspace & deleteWorkspace succeed!
      await pC.evaluate(({ id }) => (globalThis as any).multitabTest.dispose(id), c2);
      const idleAfter = await pA.evaluate(
        (n) => (globalThis as any).multitabTest.openIdleStatus(n),
        name,
      );
      assert(
        typeof idleAfter === "object" &&
          idleAfter.status === "opened" &&
          idleAfter.files.includes("/after-crash.txt"),
        `${engine}: idle after close failed: ${JSON.stringify(idleAfter)}`,
      );
      const deleted = await pA.evaluate(
        (n) => (globalThis as any).multitabTest.deleteWsStatus(n),
        name,
      );
      assert(deleted === "deleted", `${engine}: deleteWorkspace failed: ${deleted}`);
    } finally {
      await Promise.allSettled([pA.close(), pB.close(), pC.close()]);
    }
  }

  // 2. Legacy takeover interop: legacy whenBusy: "takeover" notifies attach tabs of ownershipLost!
  {
    const name = `mt-idb-legacy-${engine}-${crypto.randomUUID()}`;
    const [pA, pB, pLegacy] = await Promise.all([
      openTabPage(context, origin),
      openTabPage(context, origin),
      openTabPage(context, origin),
    ]);
    try {
      const a = await pA.evaluate((n) => (globalThis as any).multitabTest.open({ name: n }), name);
      const b = await pB.evaluate((n) => (globalThis as any).multitabTest.open({ name: n }), name);
      await pA.evaluate(
        ({ id }) => (globalThis as any).multitabTest.writeFile(id, "/shared.txt", "before-legacy"),
        a,
      );
      await pA.evaluate(({ id }) => (globalThis as any).multitabTest.flush(id), a);

      // Legacy exclusive tab takes over!
      const leg = await pLegacy.evaluate(
        (n) => (globalThis as any).multitabTest.open({ name: n, whenBusy: "takeover" }),
        name,
      );
      const fromLegacy = await pLegacy.evaluate(
        ({ id }) => (globalThis as any).multitabTest.readFileText(id, "/shared.txt"),
        leg,
      );
      assert(fromLegacy === "before-legacy", `${engine}: legacy takeover read failed`);

      // Wait for attach Host A and Peer B to observe ownershipLost!
      await pA.waitForFunction(
        (id) => (globalThis as any).multitabTest.state(id).ownershipLost === true,
        a.id,
        { timeout: 25000 },
      );
      await pB.waitForFunction(
        (id) => (globalThis as any).multitabTest.state(id).ownershipLost === true,
        b.id,
        { timeout: 25000 },
      );
      await pLegacy.evaluate(({ id }) => (globalThis as any).multitabTest.dispose(id), leg);
    } finally {
      await Promise.allSettled([pA.close(), pB.close(), pLegacy.close()]);
    }
  }

  // 3. Real Host worker freeze & thaw: Peer steals IndexedDB via verified broker steal,
  //    thawed Host demotes cleanly to Peer (NOT ownershipLost!) and reads new Host's writes!
  {
    const name = `mt-idb-freeze-${engine}-${crypto.randomUUID()}`;
    const freezeKey = crypto.randomUUID();
    const [pA, pB] = await Promise.all([
      openTabPage(context, origin),
      openTabPage(context, origin),
    ]);
    try {
      const a = await pA.evaluate(
        ({ n, fk }) =>
          (globalThis as any).multitabTest.open({
            name: n,
            workerURL: `/freeze-fs-worker.js?freezeKey=${fk}`,
          }),
        { n: name, fk: freezeKey },
      );
      const b = await pB.evaluate((n) => (globalThis as any).multitabTest.open({ name: n }), name);
      await pA.evaluate(
        ({ id }) => (globalThis as any).multitabTest.writeFile(id, "/pre-freeze.txt", "before"),
        a,
      );
      await pA.evaluate(({ id }) => (globalThis as any).multitabTest.flush(id), a);

      // Freeze Host A's worker thread synchronously via Atomics.wait for 5000ms!
      // Wait for the worker to acknowledge entering Atomics.wait before triggering B's failover read.
      await pA.evaluate((fk) => {
        return new Promise<boolean>((resolve) => {
          const ch = new BroadcastChannel(`multitab-test-freeze:${fk}`);
          const thawed = new Promise<boolean>((resolveThawed) => {
            ch.onmessage = (e) => {
              if (e.data?.freezing) resolve(true);
              if (e.data?.thawed) {
                ch.close();
                resolveThawed(true);
              }
            };
          });
          (globalThis as any).__multitabThawed = thawed;
          ch.postMessage({ ms: 5000 });
        });
      }, freezeKey);
      const thawedPromise = pA.evaluate(
        () => (globalThis as any).__multitabThawed as Promise<boolean>,
      );

      // While Host A is frozen, Peer B detects heartbeat timeout, verifies steal, promotes, and reads+writes!
      const readOnB = await pB.evaluate(
        ({ id }) => (globalThis as any).multitabTest.readFileText(id, "/pre-freeze.txt"),
        b,
      );
      assert(readOnB === "before", `${engine}: Peer B failed read after frozen Host steal`);
      await pB.evaluate(
        ({ id }) => (globalThis as any).multitabTest.writeFile(id, "/during-freeze.txt", "after"),
        b,
      );

      // Wait for Host A to thaw; it MUST demote to Peer (NO ownershipLost!) and read /during-freeze.txt!
      await thawedPromise;
      const onThawedA = await pA.evaluate(
        ({ id }) => (globalThis as any).multitabTest.readFileText(id, "/during-freeze.txt"),
        a,
      );
      assert(
        onThawedA === "after",
        `${engine}: thawed Host A failed to demote and read: ${onThawedA}`,
      );
      const stateA = await pA.evaluate((id) => (globalThis as any).multitabTest.state(id), a.id);
      assert(
        stateA.ownershipLost === false && stateA.status === "ready",
        `${engine}: thawed Host A should demote cleanly, got ${JSON.stringify(stateA)}`,
      );
      await pA.evaluate(({ id }) => (globalThis as any).multitabTest.dispose(id), a);
      await pB.evaluate(({ id }) => (globalThis as any).multitabTest.dispose(id), b);
    } finally {
      await Promise.allSettled([pA.close(), pB.close()]);
    }
  }
}

async function runOpfsSuite(
  engine: EngineName,
  context: BrowserContext,
  origin: string,
): Promise<void> {
  const name = `mt-opfs-${engine}-${crypto.randomUUID()}`;
  const [pA, pB] = await Promise.all([openTabPage(context, origin), openTabPage(context, origin)]);
  try {
    const a = await pA.evaluate(
      (n) => (globalThis as any).multitabTest.open({ name: n, implementation: "opfs-memory" }),
      name,
    );
    const b = await pB.evaluate(
      (n) => (globalThis as any).multitabTest.open({ name: n, implementation: "opfs-memory" }),
      name,
    );
    assert(a.status === "ready" && b.status === "ready", `${engine} OPFS: A/B ready`);

    await pA.evaluate(
      ({ id }) => (globalThis as any).multitabTest.writeFile(id, "/opfs.txt", "hello-opfs"),
      a,
    );
    const onB = await pB.evaluate(
      ({ id }) => (globalThis as any).multitabTest.readFileText(id, "/opfs.txt"),
      b,
    );
    assert(onB === "hello-opfs", `${engine} OPFS: B read A write`);

    // Cross-tab watch on OPFS
    const widB = await pB.evaluate(
      ({ id }) => (globalThis as any).multitabTest.openWatch(id, "/", true),
      b,
    );
    const nextB = pB.evaluate(
      ({ id, wid }) => (globalThis as any).multitabTest.nextWatch(id, wid),
      { id: b.id, wid: widB },
    );
    await pA.evaluate(
      ({ id }) => (globalThis as any).multitabTest.writeFile(id, "/opfs-watch.txt", "w"),
      a,
    );
    const ev = await nextB;
    assert(
      ev.kind === "events" && ev.names.includes("opfs-watch.txt"),
      `${engine} OPFS watch failed`,
    );

    // Graceful close failover on OPFS (unflushed write preserved!)
    await pA.evaluate(
      ({ id }) => (globalThis as any).multitabTest.writeFile(id, "/opfs-unflushed.txt", "saved"),
      a,
    );
    await pA.evaluate(({ id }) => (globalThis as any).multitabTest.dispose(id), a);
    const survived = await pB.evaluate(
      ({ id }) => (globalThis as any).multitabTest.readFileText(id, "/opfs-unflushed.txt"),
      b,
    );
    assert(survived === "saved", `${engine} OPFS graceful failover lost write: ${survived}`);

    // Re-attach A as Peer and test abrupt Host close on OPFS!
    const a2 = await pA.evaluate(
      (n) => (globalThis as any).multitabTest.open({ name: n, implementation: "opfs-memory" }),
      name,
    );
    await pB.evaluate(({ id }) => (globalThis as any).multitabTest.flush(id), b);
    await pB.close();
    const afterCrash = await pA.evaluate(
      ({ id }) => (globalThis as any).multitabTest.readFileText(id, "/opfs-unflushed.txt"),
      a2,
    );
    assert(afterCrash === "saved", `${engine} OPFS abrupt close failover failed: ${afterCrash}`);
    await pA.evaluate(({ id }) => (globalThis as any).multitabTest.dispose(id), a2);
  } finally {
    await Promise.allSettled([pA.close(), pB.close()]);
  }
}

async function measureLegacyOpenBenchmark(
  engine: EngineName,
  context: BrowserContext,
  origin: string,
): Promise<void> {
  if (engine !== "chromium") return;
  const page = await openTabPage(context, origin);
  try {
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const ms = await page.evaluate(
        (n) => (globalThis as any).multitabTest.measureLegacyOpen(n),
        `mt-bench-${crypto.randomUUID()}`,
      );
      samples.push(ms);
    }
    samples.sort((x, y) => x - y);
    console.log(
      `[multitab-browser] ${engine} legacy IndexedDB open median: ${samples[2]!.toFixed(1)}ms (samples: ${samples.map((s) => s.toFixed(1)).join(", ")})`,
    );
  } finally {
    await page.close();
  }
}

async function runEngine(
  lifecycle: BrowserRunnerLifecycle,
  engine: EngineName,
  origin: string,
): Promise<void> {
  const profile = await lifecycle.directory(lifecycle.scratch, `multitab-${engine}-`);
  const context = await lifecycle.persistent(engine, profile);
  try {
    const started = performance.now();
    await runIndexedDBSuite(engine, context, origin);
    await runOpfsSuite(engine, context, origin);
    await measureLegacyOpenBenchmark(engine, context, origin);
    console.log(
      `[multitab-browser] ${engine}: PASS (${((performance.now() - started) / 1000).toFixed(2)}s)`,
    );
  } finally {
    await lifecycle.closeContext(context);
  }
}

async function main(): Promise<void> {
  const lifecycle = new BrowserRunnerLifecycle(300_000);
  try {
    await lifecycle.init();
    const origin = lifecycle.serve(
      {
        "/": '<!doctype html><meta charset="utf-8"><script type="module" src="/multitab.js"></script>',
        "/multitab.js": await browserBundle(resolve(import.meta.dir, "multitab-browser.ts")),
        "/fs-worker.js": await browserBundle(resolve(import.meta.dir, "../browser/fs-worker.ts")),
        "/freeze-fs-worker.js": await browserBundle(
          resolve(import.meta.dir, "multitab-freeze-worker.ts"),
        ),
        "/fd-conformance-worker.js": await browserBundle(
          resolve(import.meta.dir, "fixtures/vfs-fd-conformance-worker.ts"),
        ),
      },
      Number(process.env.MULTITAB_TEST_PORT ?? 0),
    );
    const requested = process.argv.slice(2) as EngineName[];
    const list: EngineName[] = requested.length ? requested : ["chromium", "firefox", "webkit"];

    for (const engine of list) {
      await runEngine(lifecycle, engine, origin);
    }
  } finally {
    await lifecycle.close();
  }
}

await main();
