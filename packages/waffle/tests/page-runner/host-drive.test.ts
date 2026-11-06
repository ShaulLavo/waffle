import { expect, test, spyOn } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { HostConsumers, HostDrive } from "./host-drive.js";
import { Collector } from "./collector.js";
import { FakeDriver } from "./fake-driver.js";
import { runPageSuite, type SuiteAdapter } from "./suite-host.js";
import { record, type Body, type HostCase, type HostVerdict } from "./protocol.js";

class HostDriver extends FakeDriver {
  readonly verdicts: HostVerdict[] = [];
  phase = "ready";
  config: Record<string, unknown> = {};
  effects: number[] = [];
  dispatchGate: Promise<void> | undefined;
  completionBeforeResponse = false;
  constructor() {
    super("pass", { list: { ids: ["host"] } });
  }
  override async navigate(url: string): Promise<void> {
    await super.navigate(url);
    const html = await (await fetch(url)).text();
    const config: unknown = JSON.parse(
      /window\.__suiteConfiguration=(.+?)<\/script>/.exec(html)?.[1] ?? "null",
    );
    if (!record(config)) throw new Error("Missing control config");
    this.config = config;
  }
  protected override async run(role: unknown, request: unknown): Promise<void> {
    if (role !== "case") return super.run(role, request);
    this.phase = "ready";
    await this.send({ kind: "case-ready", caseId: "host" });
  }
  private async terminal(verdict: HostVerdict): Promise<void> {
    await this.send({ kind: "case-teardown", caseId: "host" });
    await this.send({
      kind: "case-end",
      caseId: "host",
      ...verdict,
      result: { body: verdict, teardown: { status: "pass" } },
    });
    this.phase = "terminal";
    await this.completeDocument();
  }
  override async script(source: string): Promise<unknown> {
    if (!source.startsWith("const identity = ")) return super.script(source);
    const driver = this;
    const runner = await super.script("return window.__pageRunner || null");
    const window = {
      __suiteConfiguration: this.config,
      __pageRunner: runner,
      effects: this.effects,
      __hostCase: {
        get phase() {
          return driver.phase;
        },
        set phase(phase: string) {
          driver.phase = phase;
        },
        verdict(value: HostVerdict) {
          driver.verdicts.push(value);
          driver.phase = "teardown";
          void driver.terminal(value);
        },
        task(operation: string) {
          const reporting = driver.send({
            kind: "task-end",
            caseId: "host",
            operation,
            status: "pass",
          });
          driver.dispatchGate = reporting.then(async () => {
            driver.completionBeforeResponse = true;
            await Bun.sleep(10);
          });
        },
      },
    };
    const value: unknown = new Function("window", "location", source)(window, {
      href: this.currentURL,
    });
    await this.dispatchGate;
    this.dispatchGate = undefined;
    return value;
  }
}
const budgets = {
  hello: 1000,
  heartbeat: 1000,
  case: 80,
  teardown: 1000,
  caseDocument: 2000,
  group: 2000,
  run: 5000,
};
function adapter(drive: (host: HostCase) => Promise<unknown>): SuiteAdapter<null> {
  return {
    suite: "host-unit",
    inventory: () => [{ id: "host", label: "host", request: () => null, drive }],
    policy: { listIds: () => ["host"], requireResult: true, check() {} },
    assets: async () => ({}),
    budgets: () => budgets,
  };
}
async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp("/work/tmp/hdu-");
  const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  try {
    await run(root);
  } finally {
    expect(process.listeners("SIGINT")).toEqual(before.SIGINT);
    expect(process.listeners("SIGTERM")).toEqual(before.SIGTERM);
    await rm(root, { recursive: true, force: true });
  }
}
function options(root: string) {
  return { scratchRoot: root, resultPath: join(root, "result.json"), cleanupTimeoutMs: 35 };
}

test("host admission has no page case-start and task completion may precede dispatch response", () =>
  fixture(async (root) => {
    const d = new HostDriver();
    const result = await runPageSuite(
      adapter(async (host) => {
        await host.task("await Promise.resolve()");
        return true;
      }),
      () => d,
      options(root),
    );
    expect(result.exit).toBe(0);
    expect(d.completionBeforeResponse).toBe(true);
    expect(d.verdicts).toEqual([{ status: "pass", result: true }]);
    expect(d.stopCalls).toBe(1);
  }));
for (const late of [false, true]) {
  test(`callback ${late ? "late" : "unsettled"} is revoked and retains scratch until actual host settlement`, () =>
    fixture(async (root) => {
      const release = Promise.withResolvers<void>();
      const d = new HostDriver();
      let attempted = 0,
        rejected = 0;
      const a = adapter(async (host) => {
        await release.promise;
        attempted++;
        try {
          await host.script("window.effects.push(9)");
        } catch {
          rejected++;
        }
        return true;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (late) {
        const callback = a.inventory()[0]?.drive;
        if (!callback) throw new Error("Missing callback");
        a.inventory = () => [
          {
            id: "host",
            label: "host",
            request: () => null,
            drive: (host) => {
              host.signal.addEventListener(
                "abort",
                () => {
                  timer = setTimeout(release.resolve, 300);
                },
                { once: true },
              );
              return callback(host);
            },
          },
        ];
      }
      try {
        const result = await runPageSuite(a, () => d, options(root));
        expect(result.exit).toBe(2);
        expect(result.cleanup.session.status).toBe("confirmed");
        expect(result.cleanup.scratch.status).toBe("unconfirmed");
        expect(d.verdicts).toHaveLength(1);
        expect(d.effects).toEqual([]);
        expect(result.failures.some((failure) => /Host callback/.test(failure.detail))).toBe(true);
      } finally {
        clearTimeout(timer);
        release.resolve();
        await Bun.sleep(100);
      }
      expect(attempted).toBe(1);
      expect(rejected).toBe(1);
      expect(d.effects).toEqual([]);
    }));
}
test("callback ownership precedes synchronous signal reentry and session destruction", () =>
  fixture(async (root) => {
    const controller = new AbortController(),
      release = Promise.withResolvers<void>(),
      d = new HostDriver();
    try {
      const result = await runPageSuite(
        adapter(async () => {
          controller.abort("synchronous reentry");
          await release.promise;
          return true;
        }),
        () => d,
        { ...options(root), signal: controller.signal },
      );
      expect(result.cleanup.session.status).toBe("confirmed");
      expect(result.cleanup.scratch.status).toBe("unconfirmed");
      expect(d.stopCalls).toBe(1);
    } finally {
      release.resolve();
      await release.promise;
    }
  }));
test("synchronous callback expiry cannot pass even before its timer tick", () =>
  fixture(async (root) => {
    const d = new HostDriver();
    const a = adapter(async () => {
      const until = performance.now() + 100;
      while (performance.now() < until) {
        /* Deliberately occupy one synchronous callback turn. */
      }
      return true;
    });
    const result = await runPageSuite(a, () => d, options(root));
    expect(result.exit).toBe(1);
    expect(d.verdicts[0]?.status).toBe("fail");
    expect(result.cleanup.scratch.status).toBe("confirmed");
    expect((await stat(`${options(root).resultPath}.diagnostics.json`)).isFile()).toBe(true);
  }));
test("a caught binding rejection stays infrastructure failure", () =>
  fixture(async (root) => {
    const d = new HostDriver();
    const result = await runPageSuite(
      adapter(async (host) => {
        d.currentDoc = "replacement";
        try {
          await host.script("window.effects.push(1)");
        } catch {}
        return true;
      }),
      () => d,
      options(root),
    );
    expect(result.exit).toBe(2);
    expect(result.failures.some((failure) => failure.category === "host-command")).toBe(true);
    expect(d.effects).toEqual([]);
    expect(d.verdicts).toEqual([]);
  }));
test("known expression rejection is an ordinary case failure with teardown and finish", () =>
  fixture(async (root) => {
    const d = new HostDriver();
    const result = await runPageSuite(
      adapter(async (host) => {
        await host.script("throw new Error('ORIGINAL')");
        return true;
      }),
      () => d,
      options(root),
    );
    expect(result.exit).toBe(1);
    expect(result.failures).toEqual([]);
    expect(result.runComplete).toBe(true);
    expect(JSON.stringify(result.results)).toContain("ORIGINAL");
  }));
test("callback and command registration survives synchronous throw", async () => {
  const consumers = new HostConsumers();
  await expect(
    consumers.invoke(() => {
      throw new Error("SYNC");
    }),
  ).rejects.toThrow("SYNC");
  expect(await consumers.join(30)).toBe(true);
});

function unitDrive() {
  const c = new Collector("r", ["host"], ["host"], { listIds: () => ["host"], check() {} });
  const state = c.expect(
    { id: "host", role: "case", caseIds: ["host"], execution: "host" },
    "token",
    "http://fixture/",
    "root",
  );
  let seq = 0;
  const send = (body: Body) => c.receive({ run: "r", doc: "doc", seq: seq++, ...body });
  send({ kind: "hello", token: "token", group: "host" });
  send({ kind: "case-ready", caseId: "host" });
  const d = new HostDriver(),
    consumers = new HostConsumers();
  return {
    c,
    state,
    send,
    d,
    consumers,
    host: new HostDrive(
      d,
      c,
      state,
      consumers,
      budgets,
      performance.now(),
      new AbortController().signal,
    ),
  };
}
test("host phase clock starts after admission, not case-ready receipt", () => {
  const now = spyOn(performance, "now").mockReturnValue(100);
  try {
    const f = unitDrive();
    now.mockReturnValue(1900);
    f.c.beginHost(f.state, "host");
    expect(f.c.outcomes.host).toEqual({ status: "running", startedAt: 1900 });
    expect(f.c.deadline({ ...budgets, case: 1, heartbeat: 5000 }, 0)).toBeNull();
  } finally {
    now.mockRestore();
  }
});

for (const binding of ["run", "token", "caseId", "execution", "url", "handle", "phase", "closed"]) {
  test(`same-script ${binding} guard rejects mutation without a verdict replay`, () =>
    fixture(async (root) => {
      const d = new HostDriver();
      const result = await runPageSuite(
        adapter(async (host) => {
          if (["run", "token", "caseId", "execution"].includes(binding))
            d.config[binding] = "wrong";
          if (binding === "url") d.currentURL = "http://wrong/";
          if (binding === "handle") d.handle = async () => "foreign";
          if (binding === "phase") d.phase = "terminal";
          if (binding === "closed")
            d.script = async () => {
              d.uncertain = true;
              throw new Error("Closed page");
            };
          await host.script("window.effects.push(4)");
          return true;
        }),
        () => d,
        options(root),
      );
      expect(result.exit).toBe(2);
      expect(d.effects).toEqual([]);
      expect(d.verdicts.length).toBeLessThanOrEqual(1);
    }));
}
test("a command queued before expiry cannot mutate after its handle wait settles", () =>
  fixture(async (root) => {
    const d = new HostDriver();
    const handle = d.handle.bind(d);
    const result = await runPageSuite(
      adapter(async (host) => {
        d.handle = async () => {
          await Bun.sleep(100);
          return handle();
        };
        await host.script("window.effects.push(11)");
        return true;
      }),
      () => d,
      options(root),
    );
    expect(result.exit).toBe(1);
    expect(d.effects).toEqual([]);
    expect(d.verdicts).toHaveLength(1);
  }));
test("a command with an expired waiter stays owned until its actual settlement", async () => {
  const consumers = new HostConsumers(),
    release = Promise.withResolvers<void>();
  const pending = consumers.invoke(() => release.promise);
  expect(await consumers.join(10)).toBe(false);
  release.resolve();
  await pending;
  expect(await consumers.join(10)).toBe(true);
});
