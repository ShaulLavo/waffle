import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  runPageSuite,
  ownedDatabase,
  type SuiteAdapter,
  type RunOptions,
  type HostCase,
  type HostKey,
  type Driver,
  type DriverPressControl,
  type AssetHoldCallback,
  type HeldAssetRequest,
  type HostPeer,
  type HostVerdict,
  type SuiteCase,
} from "waffle/testing/page-runner";
import { isHostedPage, type HostPageRun, type PageSuite } from "waffle/testing/page-runner/page";
import { Collector, type CollectorPolicy } from "./collector.js";
import { FakeDriver } from "./fake-driver.js";
import { serveCollector } from "./suite-host.js";
import type { Body } from "./protocol.js";

const id = "consumer: default";
const policy: CollectorPolicy = {
  listIds: () => [id],
  requireResult: true,
  allocation: ownedDatabase("consumer"),
  check(_id, result) {
    if (result !== true) throw new Error("Wrong consumer result");
  },
};
function adapter(): SuiteAdapter<{ databaseName: string }> {
  return {
    suite: "consumer",
    policy,
    inventory: () => [
      { id, label: "default", request: (run) => ({ databaseName: `consumer-${run}` }) },
    ],
    assets: async () => ({}),
    budgets: () => ({ hello: 2000, heartbeat: 2000, case: 3000, group: 4000, run: 10_000 }),
  };
}
async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "w1-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function options(root: string, extra: Partial<RunOptions> = {}): RunOptions {
  return {
    scratchRoot: root,
    resultPath: join(root, "result.json"),
    cleanupTimeoutMs: 40,
    ...extra,
  };
}
function driver(): FakeDriver {
  return new FakeDriver("pass", { list: { ids: [id] }, result: true });
}
const root = resolve(import.meta.dir, "../..");
for (const [entry, target] of [
  ["consumer.ts", "bun"],
  ["consumer-page.ts", "browser"],
] as const) {
  test(`${entry} contains only test host dependencies`, async () => {
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, entry)],
      target,
      metafile: true,
    });
    expect(built.success).toBe(true);
    if (!built.metafile) throw new Error("Missing consumer graph");
    const inputs = Object.keys(built.metafile.inputs);
    expect(
      inputs.filter((path) =>
        /playwright|network-relay|native-peer|browser-runner-lifecycle|storage-browser|host-storage-control|(?:^|\/)(index|runtime)\.ts$|\/(core|fs|proc|browser|network)\//.test(
          path,
        ),
      ),
    ).toEqual([]);
    if (target === "browser") expect(inputs.filter((path) => path.startsWith("node:"))).toEqual([]);
  });
}
for (const entry of ["index.ts", "runtime.ts", "browser/worker.ts"]) {
  test(`${entry} never includes test delivery code`, async () => {
    const built = await Bun.build({
      entrypoints: [join(root, entry)],
      target: "browser",
      metafile: true,
    });
    expect(built.success).toBe(true);
    if (!built.metafile) throw new Error("Missing runtime graph");
    expect(Object.keys(built.metafile.inputs).filter((path) => path.includes("/tests/"))).toEqual(
      [],
    );
  });
}
test("page import and hosted accessor need no window", () => {
  expect(isHostedPage()).toBe(false);
});
for (const role of ["list", "case", "finish"] as const) {
  test(`exact database policy rejects unauthorized allocations during ${role} before ACK`, () => {
    const c = new Collector("r", [id], [id], policy);
    const state = c.expect(
      { id, role, caseIds: role === "case" ? [id] : [] },
      "t",
      "http://test/",
      "h",
    );
    let seq = 0;
    const send = (body: Body) => c.receive({ run: "r", doc: "d", seq: seq++, ...body });
    send({ kind: "hello", token: "t", group: id });
    if (role === "case") send({ kind: "case-start", caseId: id });
    const before = state.messages.length;
    expect(() =>
      send({
        kind: "allocation",
        entry: { kind: "indexeddb", name: role === "case" ? "consumer-r-1" : "consumer-r" },
      }),
    ).toThrow();
    expect(c.ledger).toEqual([]);
    expect(state.messages).toHaveLength(before);
  });
}
for (const entry of [
  { kind: "indexeddb", name: "consumer-other" },
  { kind: "indexeddb", name: "consumer-r-suffix" },
  { kind: "indexeddb", name: "waffle-workspace" },
  { kind: "opfs-directory", name: "consumer-r" },
] as const) {
  test(`exact policy rejects ${entry.kind} ${entry.name}`, () => {
    expect(() => ownedDatabase("consumer")(entry, [id], "r")).toThrow();
  });
}
test("sequential exact-name reuse keeps one ledger entry", () => {
  const c = new Collector("r", [id], [id], policy);
  c.expect({ id, role: "case", caseIds: [id] }, "t", "http://test/", "h");
  const bodies: Body[] = [
    { kind: "hello", token: "t", group: id },
    { kind: "case-start", caseId: id },
  ];
  const allocations = Array.from({ length: 2 }, (): Body => ({
    kind: "allocation",
    entry: { kind: "indexeddb", name: "consumer-r" },
  }));
  bodies
    .concat(allocations)
    .forEach((body, seq) => c.receive({ run: "r", doc: "d", seq, ...body }));
  expect(c.ledger).toEqual([{ kind: "indexeddb", name: "consumer-r" }]);
});
for (const startedAt of [NaN, Infinity, -Infinity, performance.now() + 1e9]) {
  test(`rejects invalid monotonic start ${startedAt}`, () =>
    fixture(async (root) => {
      let calls = 0;
      await expect(
        runPageSuite(
          adapter(),
          () => {
            calls++;
            return driver();
          },
          options(root, { startedAt }),
        ),
      ).rejects.toThrow("monotonic");
      expect(calls).toBe(0);
      expect(await readdir(root)).toEqual([]);
    }));
}
for (const port of [0, 80, 65536, NaN, 4186.5]) {
  test(`rejects invalid explicit port ${port} before preparation`, () =>
    fixture(async (root) => {
      const a = adapter();
      a.assets = () => {
        throw new Error("Unexpected producer");
      };
      await expect(runPageSuite(a, driver, options(root, { port }))).rejects.toThrow("port");
      expect(await readdir(root)).toEqual([]);
    }));
}
test("occupied explicit port never starts producer or driver", () =>
  fixture(async (root) => {
    const occupied = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("foreign"),
    });
    let produced = 0,
      allocated = 0;
    const a = adapter();
    a.assets = async () => {
      produced++;
      return {};
    };
    try {
      const result = await runPageSuite(
        a,
        () => {
          allocated++;
          return driver();
        },
        options(root, { port: occupied.port }),
      );
      expect(result.exit).toBe(2);
      expect([produced, allocated]).toEqual([0, 0]);
      expect(await (await fetch(`http://127.0.0.1:${occupied.port}`)).text()).toBe("foreign");
    } finally {
      await occupied.stop(true);
    }
  }));
test("later exact bind conflict fails without port fallback", () =>
  fixture(async (root) => {
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    let occupied: ReturnType<typeof Bun.serve> | undefined;
    const a = adapter();
    a.assets = async () => {
      occupied = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("foreign") });
      return {};
    };
    try {
      const result = await runPageSuite(
        a,
        () => {
          throw new Error("Unexpected driver");
        },
        options(root, { port }),
      );
      expect(result.exit).toBe(2);
      expect(result.cleanup.server.status).toBe("not-created");
    } finally {
      await occupied?.stop(true);
    }
  }));
test("omitted port retains the storage environment binding", async () => {
  const previous = process.env.STORAGE_TEST_PORT;
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  process.env.STORAGE_TEST_PORT = String(port);
  const f = serveCollector(new Collector("r", [], [], policy), {});
  try {
    expect(f.server.port).toBe(port);
  } finally {
    await f.server.stop(true);
    if (previous === undefined) delete process.env.STORAGE_TEST_PORT;
    else process.env.STORAGE_TEST_PORT = previous;
  }
});
test("expired entry calls no producer or driver", () =>
  fixture(async (root) => {
    const a = adapter();
    let produced = 0,
      allocated = 0;
    a.assets = async () => {
      produced++;
      return {};
    };
    const result = await runPageSuite(
      a,
      () => {
        allocated++;
        return driver();
      },
      options(root, { startedAt: performance.now() - 120_001 }),
    );
    expect(result.exit).toBe(2);
    expect(result.failures.some((f) => f.category === "run-timeout")).toBe(true);
    expect([produced, allocated]).toEqual([0, 0]);
    expect(result.documents).toEqual([]);
  }));
async function expiredBoundary(root: string, phase: "preparation" | "factory"): Promise<void> {
  const a = adapter(),
    d = driver(),
    clock = { now: 1_000_000 };
  d.uncertain = true;
  const now = spyOn(performance, "now").mockImplementation(() => clock.now),
    serving = spyOn(Bun, "serve"),
    starting = spyOn(d, "start");
  let factories = 0;
  a.budgets = () => ({ hello: 1000, heartbeat: 1000, case: 1000, group: 1000, run: 100 });
  a.assets = async () => {
    if (phase === "preparation") clock.now += 101;
    return {};
  };
  const factory = () => {
    factories++;
    if (phase === "factory") clock.now += 101;
    return d;
  };
  try {
    const result = await runPageSuite(a, factory, options(root));
    expect(result.exit).toBe(2);
    expect(result.failures.some((failure) => failure.category === "run-timeout")).toBe(true);
    expect(serving.mock.calls).toHaveLength(phase === "preparation" ? 0 : 1);
    expect(factories).toBe(phase === "preparation" ? 0 : 1);
    expect(starting.mock.calls).toHaveLength(0);
    expect(result.documents).toEqual([]);
    expect(result.cleanup.scratch.status).toBe("confirmed");
  } finally {
    now.mockRestore();
    serving.mockRestore();
    starting.mockRestore();
  }
}
for (const phase of ["preparation", "factory"] as const) {
  test(`synchronous ${phase} expiry stops later allocations before the watchdog runs`, () =>
    fixture((root) => expiredBoundary(root, phase)));
}
test("119-second-old setup expires under the original 120-second clock", () =>
  fixture(async (root) => {
    const a = adapter();
    a.budgets = () => ({
      hello: 20_000,
      heartbeat: 10_000,
      case: 120_000,
      group: 120_000,
      run: 120_000,
    });
    let scratch = "",
      allocated = 0;
    a.assets = async (context) => {
      scratch = context.scratch;
      await new Promise<void>((resolve) =>
        context.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return {};
    };
    const before = performance.now();
    const result = await runPageSuite(
      a,
      () => {
        allocated++;
        return driver();
      },
      options(root, { startedAt: before - 119_000 }),
    );
    expect(performance.now() - before).toBeLessThan(2000);
    expect(result.failures.some((f) => f.category === "run-timeout")).toBe(true);
    expect(result.cleanup.scratch.status).toBe("confirmed");
    expect(allocated).toBe(0);
    expect(await Bun.file(scratch).exists()).toBe(false);
  }));
for (const settles of [true, false]) {
  test(`interrupt joins producer or retains its scratch, settles=${settles}`, () =>
    fixture(async (root) => {
      const a = adapter(),
        controller = new AbortController();
      const { promise, resolve } = Promise.withResolvers<Record<string, Blob | string>>();
      let scratch = "",
        allocated = 0,
        calls = 0;
      a.assets = (context) => {
        scratch = context.scratch;
        calls++;
        context.signal.addEventListener(
          "abort",
          () => {
            if (settles) setTimeout(resolve, 10, {});
          },
          { once: true },
        );
        controller.abort("interrupt while producing");
        return promise;
      };
      const result = await runPageSuite(
        a,
        () => {
          allocated++;
          return driver();
        },
        options(root, { signal: controller.signal }),
      );
      expect(result.exit).toBe(2);
      expect([allocated, calls]).toEqual([0, 1]);
      expect(result.documents).toEqual([]);
      expect(result.cleanup.scratch.status).toBe(settles ? "confirmed" : "unconfirmed");
      if (!settles) expect((await stat(scratch)).isDirectory()).toBe(true);
      resolve({});
      await promise;
      await Bun.sleep(30);
      expect(allocated).toBe(0);
    }));
}
test("a completed run stops its execution watchdog before slow bounded teardown", () =>
  fixture(async (root) => {
    const d = driver(),
      a = adapter();
    a.policy = { ...policy, allocation: undefined };
    const original = d.stop.bind(d);
    d.stop = async () => {
      await Bun.sleep(150);
      return original();
    };
    const result = await runPageSuite(
      a,
      () => d,
      options(root, {
        cleanupTimeoutMs: 1000,
        budgets: { hello: 2000, heartbeat: 2000, case: 2000, group: 2000, run: 220 },
      }),
    );
    expect(result.exit).toBe(0);
    expect(result.failures).toEqual([]);
    expect(d.stopCalls).toBe(1);
  }));
class ClockDriver extends FakeDriver {
  pending: Promise<void> | undefined;
  constructor(
    readonly clock: { now: number },
    readonly navigation: number,
    readonly resultDelay: number,
  ) {
    super("pass", { list: { ids: [id] }, result: true });
  }
  protected override async run(role: unknown, request: unknown): Promise<void> {
    if (role !== "case") return super.run(role, request);
    await this.send({ kind: "case-start", caseId: id });
    this.clock.now += this.navigation;
    this.pending = this.publish();
  }
  private async publish(): Promise<void> {
    await Bun.sleep(35);
    this.clock.now += this.resultDelay;
    await this.send({ kind: "case-end", caseId: id, status: "pass", result: true });
    await this.completeDocument();
  }
  override async stop() {
    await this.pending;
    return super.stop();
  }
}
for (const [navigation, resultDelay, exit] of [
  [20_000, 85_000, 0],
  [20_000, 91_000, 2],
  [40_000, 85_000, 2],
] as const) {
  test(`post-navigation result clock ${navigation} + ${resultDelay} remains under absolute 120 s`, () =>
    fixture(async (root) => {
      const clock = { now: 1_000_000 };
      const now = spyOn(performance, "now").mockImplementation(() => clock.now);
      const a = adapter();
      a.resultWaitMs = 90_000;
      a.budgets = () => ({
        hello: 20_000,
        heartbeat: 120_000,
        case: 120_000,
        group: 120_000,
        run: 120_000,
      });
      const d = new ClockDriver(clock, navigation ?? 0, resultDelay ?? 0);
      try {
        const result = await runPageSuite(a, () => d, options(root, { cleanupTimeoutMs: 1000 }));
        expect(result.exit).toBe(exit);
        if (exit === 2)
          expect(result.failures.some((f) => /result-timeout|run-timeout/.test(f.category))).toBe(
            true,
          );
      } finally {
        now.mockRestore();
      }
    }));
}

for (const path of [
  "https://foreign/page",
  "//foreign/page",
  "/../page",
  "/current/?query",
  "/current/#fragment",
  '/x" onload="bad',
  "/report",
]) {
  test(`rejects nonlocal or reserved document path ${path}`, () =>
    fixture(async (root) => {
      const a = adapter();
      a.page = { path, script: "/page.js" };
      await expect(runPageSuite(a, driver, options(root))).rejects.toThrow();
      expect(await readdir(root)).toEqual([]);
    }));
}
test("producer expiry retains unjoined scratch and never resumes dispatch after late resolution", () =>
  fixture(async (root) => {
    const a = adapter();
    const { promise, resolve } = Promise.withResolvers<Record<string, Blob | string>>();
    let allocated = 0,
      scratch = "";
    a.assets = async (context) => {
      scratch = context.scratch;
      return promise;
    };
    a.budgets = () => ({ hello: 100, heartbeat: 100, case: 100, group: 100, run: 80 });
    const result = await runPageSuite(
      a,
      () => {
        allocated++;
        return driver();
      },
      options(root),
    );
    expect(result.exit).toBe(2);
    expect(result.cleanup.scratch.status).toBe("unconfirmed");
    expect((await stat(scratch)).isDirectory()).toBe(true);
    expect(result.failures.some((failure) => failure.category === "run-timeout")).toBe(true);
    resolve({});
    await promise;
    await Bun.sleep(30);
    expect(allocated).toBe(0);
  }));
for (const failure of ["reject", "hang"] as const) {
  test(`failed driver teardown ${failure} prevents success and retains owned scratch`, () =>
    fixture(async (root) => {
      const a = adapter(),
        d = driver();
      d.stop = () =>
        failure === "hang" ? new Promise(() => {}) : Promise.reject(new Error("STOP_FAILURE"));
      const result = await runPageSuite(a, () => d, options(root));
      expect(result.exit).toBe(2);
      expect(result.runComplete).toBe(true);
      expect(result.cleanup.session.status).toBe("unconfirmed");
      expect(result.cleanup.scratch.status).toBe("unconfirmed");
    }));
}
function interruptAdded<T>(
  before: readonly T[],
  current: readonly T[],
  invoke: (listener: T) => void,
): number {
  let called = 0;
  for (const listener of current) {
    if (before.includes(listener)) continue;
    invoke(listener);
    called++;
  }
  return called;
}
test("signals during bounded teardown neither resurrect dispatch nor invent execution expiry", () =>
  fixture(async (root) => {
    const d = driver(),
      a = adapter(),
      controller = new AbortController();
    const original = d.stop.bind(d);
    const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
    d.stop = async () => {
      controller.abort("during teardown");
      expect(interruptAdded(before.SIGINT, process.listeners("SIGINT"), (fn) => fn("SIGINT"))).toBe(
        1,
      );
      expect(
        interruptAdded(before.SIGTERM, process.listeners("SIGTERM"), (fn) => fn("SIGTERM")),
      ).toBe(1);
      await Bun.sleep(40);
      return original();
    };
    const result = await runPageSuite(
      a,
      () => d,
      options(root, { signal: controller.signal, cleanupTimeoutMs: 1000 }),
    );
    expect(result.exit).toBe(0);
    expect(result.failures).toEqual([]);
    expect(d.stopCalls).toBe(1);
    expect(d.navigations).toBe(3);
  }));
test("expiry immediately before finish retirement stays a genuine execution failure", () =>
  fixture(async (root) => {
    const clock = { now: 1_000_000 },
      d = driver(),
      a = adapter();
    const now = spyOn(performance, "now").mockImplementation(() => clock.now);
    const script = d.script.bind(d);
    d.script = async (source) => {
      if (d.navigations === 3 && source.includes("r.retired = true")) clock.now += 120_001;
      return script(source);
    };
    a.budgets = () => ({
      hello: 20_000,
      heartbeat: 10_000,
      case: 120_000,
      group: 120_000,
      run: 120_000,
    });
    try {
      const result = await runPageSuite(a, () => d, options(root));
      expect(result.exit).toBe(2);
      expect(result.failures.some((failure) => failure.category === "run-timeout")).toBe(true);
      expect(d.stopCalls).toBe(1);
    } finally {
      now.mockRestore();
    }
  }));

test("unconfirmed collector stop prevents a successful result", () =>
  fixture(async (root) => {
    const serve = spyOn(Bun, "serve");
    let close: (() => void | Promise<void>) | undefined;
    let restore = () => {};
    try {
      const result = await runPageSuite(
        adapter(),
        () => {
          const call = serve.mock.results[0];
          if (!call || call.type !== "return") throw new Error("Missing owned collector");
          const server = call.value;
          close = server.stop.bind(server, true);
          const stop = spyOn(server, "stop").mockRejectedValue(new Error("COLLECTOR_STOP_FAILURE"));
          restore = stop.mockRestore.bind(stop);
          return driver();
        },
        options(root),
      );
      expect(result.exit).toBe(2);
      expect(result.cleanup.server.status).toBe("unconfirmed");
      expect(result.cleanup.server.detail).toContain("COLLECTOR_STOP_FAILURE");
    } finally {
      restore();
      serve.mockRestore();
      await close?.();
    }
  }));
test("scratch deletion failure remains unconfirmed after consumers stop", () =>
  fixture(async (root) => {
    const { mkdir, chmod } = await import("node:fs/promises");
    const a = adapter();
    let locked = "";
    a.assets = async ({ scratch }) => {
      locked = join(scratch, "locked");
      await mkdir(locked);
      await Bun.write(join(locked, "fixture"), "owned");
      await chmod(locked, 0);
      return {};
    };
    try {
      const result = await runPageSuite(a, driver, options(root));
      expect(result.exit).toBe(2);
      expect(result.cleanup.session.status).toBe("confirmed");
      expect(result.cleanup.scratch.status).toBe("unconfirmed");
    } finally {
      if (locked) await chmod(locked, 0o700);
    }
  }));

test("public entries expose authoritative host domain types without widening driver access", async () => {
  const item: SuiteCase<null> = {
    query: (run) => ({ test: "1", renderer: "canvas", workspace: `typed-${run}` }),
    id: "typed-host",
    label: "typed",
    request: () => null,
    drive: async (host: HostCase) => {
      host.signal.throwIfAborted();
      const callback: AssetHoldCallback = async (request: HeldAssetRequest) => {
        const continued: Promise<void> = request.continue();
        await continued;
        // @ts-expect-error ordinary requests cannot be replaced
        request.continue({ body: "replacement" });
        // @ts-expect-error private HTTP authority never enters the callback
        void request.headers;
      };
      host.holdAsset("/programs/shell-engine.wasm", callback);
      // @ts-expect-error a response-valued callback cannot replace the ordinary response
      host.holdAsset("/programs/test-guest.wasm", async () => new Response("replacement"));
      // @ts-expect-error synchronous replacements are not held callbacks
      host.holdAsset("/programs/test-guest.wasm", () => {});
      const updated: void = host.setTimeout(60_000);
      void updated;
      const key: HostKey = "Enter";
      const pressed: Promise<void> = host.press(key);
      await pressed;
      await host.press("Home");
      await host.press("ArrowUp");
      await host.press("ArrowRight");
      // @ts-expect-error shortcuts are unsupported
      host.press("Control+c");
      // @ts-expect-error arbitrary actions are unsupported
      host.press({ actions: [] });
      // @ts-expect-error whole-text insertion is separate
      host.insertText("text");
      // @ts-expect-error no optional modifiers or target
      host.press("Enter", { target: "textarea" });
      await host.script("return null");
      await host.task("await Promise.resolve()");
      const peer = await host.openPeer();
      await peer.script("return null");
      await peer.task("await Promise.resolve()");
      // @ts-expect-error raw browser authority is not a callback capability
      void host.driver;
      // @ts-expect-error peer identities are host assigned
      peer.generation = 4;
      // @ts-expect-error peer selection is private to the queue
      peer.selectWindow("raw");
      // @ts-expect-error caller IDs cannot construct a generation capability
      const forged: HostPeer = { peer: "caller", generation: 0 };
      void forged;
      const successor = await peer.reload();
      await successor.close();
      const database: Promise<string> = host.allocateDatabase("consumer");
      await database;
      await host.sleep(0);
      return { remaining: host.remainingMs() };
    },
  };
  const run: HostPageRun<null> = {
    kind: "host",
    peer: async (_request, allocate) => {
      await allocate({ kind: "indexeddb", name: "typed" });
    },
    teardown: async (_request, body: HostVerdict) => body.status,
  };
  const suite: PageSuite<null> = {
    list: async () => [item.id],
    run,
    finish: async (ledger) => ledger.slice(),
  };
  expect(await suite.list()).toEqual(["typed-host"]);
  expect(typeof item.drive).toBe("function");
});

test("public declarations and page context carry domain capabilities only", () => {
  const a: SuiteAdapter<null> = {
    ...adapter(),
    inventory: () => [{ id, label: id, request: () => null }],
    serviceWorker: { caseId: id, script: "/sw.js" },
    fixture: {
      caseId: id,
      create: () => ({
        start: async ({ origin, signal }) => [
          {
            path: "/config",
            get: async ({ signal: requestSignal }) => {
              signal.throwIfAborted();
              requestSignal.throwIfAborted();
              return { origin };
            },
          },
        ],
        close: async () => {},
      }),
    },
  };
  const page: PageSuite<null> = {
    list: async () => [id],
    finish: async (ledger) => ledger.slice(),
    run: async (_request, allocate, context) => {
      if (context.serviceWorker) {
        const registration = await context.serviceWorker.register();
        context.serviceWorker.controls(registration, navigator.serviceWorker.controller);
        await context.serviceWorker.unregister(registration);
      }
      await context.fetchFixture("/config");
      await allocate({
        kind: "service-worker",
        name: "http://localhost/scope/",
        clientURL: "http://localhost/scope/client",
        scriptURL: "http://localhost/sw.js",
      });
      return null;
    },
  };
  expect(a.serviceWorker?.caseId).toBe(id);
  expect(typeof page.run).toBe("function");
});

test("explicit ephemeral port does not inherit the storage environment port", () =>
  fixture(async (root) => {
    const previous = process.env.STORAGE_TEST_PORT;
    const occupied = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("foreign"),
    });
    process.env.STORAGE_TEST_PORT = String(occupied.port);
    const d = driver();
    try {
      const result = await runPageSuite(
        adapter(),
        () => d,
        options(root, { port: "ephemeral", cleanupTimeoutMs: 1000 }),
      );
      expect(result.exit).toBe(0);
      expect(new URL(d.origin).port).not.toBe(String(occupied.port));
      expect(await (await fetch(`http://127.0.0.1:${occupied.port}`)).text()).toBe("foreign");
    } finally {
      await occupied.stop(true);
      if (previous === undefined) delete process.env.STORAGE_TEST_PORT;
      else process.env.STORAGE_TEST_PORT = previous;
    }
  }));
test("document tokens and generated worker queries are bound to their exact host URL", async () => {
  const c = new Collector("r", [id], [id], policy);
  const f = serveCollector(c, { "/page.js": "", "/sw.js": "" }, undefined, 0);
  const entry = {
    kind: "service-worker",
    name: `${f.origin}/_waffle_owned/r/`,
    clientURL: `${f.origin}/_waffle_owned/r/client.html?token=t`,
    scriptURL: `${f.origin}/sw.js?waffle-run=r`,
  } as const;
  c.declareWorker(id, entry);
  c.expect({ id, role: "case", caseIds: [id] }, "t", entry.clientURL, "h");
  f.configurations.set("t", {});
  try {
    expect((await fetch(entry.clientURL)).status).toBe(200);
    expect((await fetch(`${f.origin}/?token=t`)).status).toBe(404);
    expect((await fetch(entry.clientURL.replace("token=t", "token=wrong"))).status).toBe(404);
    expect((await fetch(entry.scriptURL)).status).toBe(200);
    expect(
      (await fetch(entry.scriptURL.replace("waffle-run=r", "waffle-run=foreign"))).status,
    ).toBe(404);
    expect((await fetch(entry.scriptURL + "&extra=1")).status).toBe(404);
  } finally {
    await f.server.stop(true);
  }
});

test("public custom drivers require the authoritative press control", () => {
  const press: Driver["press"] = async (key: HostKey, control: DriverPressControl) => {
    control.signal.throwIfAborted();
    const value: string = await control.dispatch(async () => key);
    expect(value).toBe("Enter");
  };
  function withoutPress(driver: Omit<Driver, "press">): Driver {
    // @ts-expect-error all matching drivers must implement press
    return driver;
  }
  void withoutPress;
  expect(typeof press).toBe("function");
});

test("the tiny native key control loads no Playwright driver or guest suites", async () => {
  const built = await Bun.build({
    entrypoints: [join(import.meta.dir, "key-press-controls-native.ts")],
    target: "bun",
    metafile: true,
  });
  expect(built.success).toBe(true);
  if (!built.metafile) throw new Error("Missing native control graph");
  const inputs = Object.keys(built.metafile.inputs);
  expect(
    inputs.filter((path) =>
      /playwright|browser-runner-lifecycle|storage-browser|network-relay|\/(core|fs|proc|browser|network)\//.test(
        path,
      ),
    ),
  ).toEqual([]);
  expect(inputs.some((path) => path.endsWith("/native.ts"))).toBe(true);
  expect(inputs.some((path) => path.endsWith("/host-drive.ts"))).toBe(true);
  expect(inputs.some((path) => path.endsWith("/safari-driver.ts"))).toBe(true);
});
