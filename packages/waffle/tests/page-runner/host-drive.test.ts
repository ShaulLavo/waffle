import { PlaywrightDriver } from "./playwright-driver.js";
import { BrowserRunnerLifecycle } from "../browser-runner-lifecycle.js";
import { expect, test, spyOn } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { ownedDatabase } from "./storage-policy.js";
import { HostDrive } from "./host-drive.js";
import { HostConsumers } from "./owned-consumers.js";
import { Collector } from "./collector.js";
import { FakeDriver } from "./fake-driver.js";
import { runPageSuite, type SuiteAdapter } from "./suite-host.js";
import {
  record,
  formatHostError,
  type Body,
  type Budgets,
  type HostCase,
  type HostVerdict,
} from "./protocol.js";

class HostDriver extends FakeDriver {
  readonly verdicts: HostVerdict[] = [];
  readonly receiver = { phase: "ready" };
  get phase() {
    return this.receiver.phase;
  }
  set phase(phase: string) {
    this.receiver.phase = phase;
  }
  config: Record<string, unknown> = {};
  effects: number[] = [];
  reportFailure: string | null = null;
  retired = false;
  dispatchGate: Promise<void> | undefined;
  completionBeforeResponse = false;
  readonly allocations: string[] = [];
  taskGate: Promise<void> | undefined;
  taskCompletion: Promise<void> | undefined;
  readonly taskEntered = Promise.withResolvers<void>();
  constructor() {
    super("pass", { list: { ids: ["host"] } });
  }
  override async navigate(url: string): Promise<void> {
    await super.navigate(url);
    this.config = this.configuration;
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
    const receiver = this.receiver;
    const runner = await super.script("return window.__pageRunner || null");
    const window = {
      __suiteConfiguration: this.config,
      __pageRunner: record(runner)
        ? { ...runner, failure: this.reportFailure, retired: this.retired }
        : runner,
      effects: this.effects,
      __hostCase: {
        get phase() {
          return receiver.phase;
        },
        set phase(phase: string) {
          receiver.phase = phase;
        },
        verdict: (value: HostVerdict) => {
          this.verdicts.push(value);
          this.phase = "teardown";
          void this.terminal(value);
        },
        allocateDatabase: (operation: string, name: string) => {
          this.allocations.push(name);
          this.dispatchGate = this.send({ kind: "allocation", entry: { kind: "indexeddb", name } })
            .then(() => this.send({ kind: "task-end", caseId: "host", operation, status: "pass" }))
            .then(async () => {
              this.completionBeforeResponse = true;
              await Bun.sleep(10);
            });
        },
        task: (operation: string) => {
          this.taskEntered.resolve();
          if (this.taskGate) {
            this.taskCompletion = this.taskGate.then(() =>
              this.send({ kind: "task-end", caseId: "host", operation, status: "pass" }),
            );
            return;
          }
          const reporting = this.send({
            kind: "task-end",
            caseId: "host",
            operation,
            status: "pass",
          });
          this.dispatchGate = reporting.then(async () => {
            this.completionBeforeResponse = true;
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
  const root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "hdu-"));
  const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
    expect(process.listeners("SIGINT")).toEqual(before.SIGINT);
    expect(process.listeners("SIGTERM")).toEqual(before.SIGTERM);
  }
}
test("host fixtures use the configured scratch root", async () => {
  const previous = process.env.STORAGE_SCRATCH_ROOT;
  const parent = await mkdtemp(join(previous ?? tmpdir(), "hdu-root-"));
  process.env.STORAGE_SCRATCH_ROOT = parent;
  try {
    await fixture(async (root) => {
      expect(dirname(root)).toBe(parent);
    });
  } finally {
    if (previous === undefined) delete process.env.STORAGE_SCRATCH_ROOT;
    else process.env.STORAGE_SCRATCH_ROOT = previous;
    await rm(parent, { recursive: true, force: true });
  }
});
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
                  timer = setTimeout(release.resolve, budgets.teardown + 300);
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
        performance.now();
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

function unitDrive(limits: Budgets = budgets) {
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
      limits,
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

test("a late in-flight command cannot dispatch after checked teardown retains its scratch", () =>
  fixture(async (root) => {
    const release = Promise.withResolvers<void>(),
      d = new HostDriver();
    const delayedHandle = async () => {
      await release.promise;
      return "root";
    };
    const a = adapter(async (host) => {
      d.handle = delayedHandle;
      await host.script("window.effects.push(99)");
      return true;
    });
    a.budgets = () => ({ ...budgets, run: 300 });
    try {
      const result = await runPageSuite(a, () => d, options(root));
      const before = JSON.stringify(result);
      expect(result.exit).toBe(2);
      expect(result.cleanup.scratch.status).toBe("unconfirmed");
      expect(result.cleanup.session.status).toBe("confirmed");
      release.resolve();
      await Bun.sleep(30);
      expect(JSON.stringify(result)).toBe(before);
      expect(d.effects).toEqual([]);
      expect(d.verdicts).toEqual([]);
    } finally {
      release.resolve();
      await release.promise;
    }
  }));

test("full original matcher evidence is saved outside scratch without enlarging verdicts", () =>
  fixture(async (root) => {
    const actual = Array.from({ length: 196608 }, (_, i) => i % 251);
    actual[123456] = -1;
    const original = Object.assign(new Error("ORIGINAL_DIAGNOSTIC".repeat(2000)), { actual });
    const result = await runPageSuite(
      adapter(async () => {
        throw original;
      }),
      () => new HostDriver(),
      options(root),
    );
    expect(result.exit).toBe(1);
    expect(result.cleanup.scratch.status).toBe("confirmed");
    const evidence: unknown = await Bun.file(`${options(root).resultPath}.diagnostics.json`).json();
    if (
      !record(evidence) ||
      !Array.isArray(evidence.host) ||
      !record(evidence.host[0]) ||
      !record(evidence.host[0].body)
    )
      throw new Error("Missing original failure evidence");
    expect(evidence.host[0].body.message).toBe(String(original));
    const details = evidence.host[0].body.details;
    if (!record(details)) throw new Error("Missing matcher details");
    expect(details.actual).toEqual(actual);
  }));
test("failure to persist diagnostics retains scratch and does not replace the body cause", () =>
  fixture(async (root) => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(`${options(root).resultPath}.diagnostics.json`);
    const result = await runPageSuite(
      adapter(async () => {
        throw new Error("PRIMARY_BODY");
      }),
      () => new HostDriver(),
      options(root),
    );
    expect(result.exit).toBe(2);
    expect(result.cleanup.scratch.status).toBe("unconfirmed");
    expect(JSON.stringify(result.outcomes)).toContain("PRIMARY_BODY");
    expect(result.failures.some((failure) => failure.category === "diagnostics-write")).toBe(true);
  }));

test("escaped multibyte body and disposal errors fit both unchanged report bounds", () => {
  const original = '😀\u0000"\\'.repeat(16_384);
  const body = formatHostError(original),
    teardown = formatHostError(original);
  const result = {
    body: { status: "fail", error: body },
    teardown: { status: "fail", error: teardown },
  };
  const message = {
    run: "run",
    doc: "doc",
    seq: 1,
    kind: "case-end",
    caseId: "host",
    status: "fail",
    error: [body, teardown].join("; "),
    result,
  };
  expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(
    48 * 1024,
  );
  expect(new TextEncoder().encode(JSON.stringify(message)).byteLength).toBeLessThanOrEqual(
    64 * 1024,
  );
  expect(body.length).toBeGreaterThan(0);
});

for (const failure of ["reporter", "collector"]) {
  test(
    `known ${failure} failure synchronously revokes ordinary dispatch`,
    () =>
      fixture(async (root) => {
        const d = new HostDriver();
        const result = await runPageSuite(
          adapter(async (host) => {
            if (failure === "reporter") d.reportFailure = "Report acknowledgement lost";
            else
              await fetch(`${new URL(d.currentURL).origin}/report`, {
                method: "POST",
                body: "null",
              });
            try {
              await host.script("window.effects.push(71)");
            } catch {}
            d.reportFailure = null;
            try {
              await host.script("window.effects.push(72)");
            } catch {}
            return true;
          }),
          () => d,
          options(root),
        );
        expect(result.exit).toBe(2);
        expect(d.effects).toEqual([]);
        expect(result.failures.length).toBeGreaterThan(0);
      }),
    20_000,
  );
}
for (const deadline of ["document", "heartbeat", "run"]) {
  test(`successful admission cannot cross the ${deadline} deadline`, async () => {
    const now = spyOn(performance, "now").mockReturnValue(100);
    try {
      const f = unitDrive();
      f.d.script = async () => {
        if (deadline === "document") f.state.startedAt = -1901;
        if (deadline === "heartbeat") f.state.heartbeatAt = -901;
        if (deadline === "run") now.mockReturnValue(5101);
        return { kind: "value", value: true };
      };
      await expect(f.host.admit()).rejects.toThrow();
      expect(f.c.failures.length).toBeGreaterThan(0);
      expect(await f.consumers.join(50)).toBe(true);
    } finally {
      now.mockRestore();
    }
  });
}
test("expiration between admission and callback never enters original setup", async () => {
  const now = spyOn(performance, "now").mockReturnValue(100);
  try {
    const f = unitDrive();
    f.d.script = async () => ({ kind: "value", value: true });
    await f.host.admit();
    f.state.startedAt = -1901;
    f.d.script = async () => {
      f.c.beginHost(f.state, "host");
      f.send({ kind: "case-teardown", caseId: "host" });
      f.send({ kind: "case-end", caseId: "host", status: "fail", error: "Expired admission" });
      return { kind: "void" };
    };
    let entered = false;
    await f.host.drive(async () => {
      entered = true;
      return true;
    });
    expect(entered).toBe(false);
    expect(f.c.failures.length).toBeGreaterThan(0);
    expect(await f.consumers.join(50)).toBe(true);
  } finally {
    now.mockRestore();
  }
});

test("interruption before verdict dispatch attempts the first verdict once under cleanup", () =>
  fixture(async (root) => {
    const controller = new AbortController(),
      d = new HostDriver();
    const result = await runPageSuite(
      adapter(async () => {
        d.handle = async () => {
          d.handle = async () => "root";
          controller.abort("ABORT_BEFORE_VERDICT_DISPATCH");
          return "root";
        };
        return true;
      }),
      () => d,
      { ...options(root), signal: controller.signal },
    );
    expect(result.exit).toBe(2);
    expect(d.verdicts).toHaveLength(1);
    expect(JSON.stringify(result.results)).toContain('"teardown":{"status":"pass"}');
    expect(result.cleanup.scratch.status).toBe("confirmed");
  }));

test("allocation returns the exact policy-owned name after actual dispatch response", () =>
  fixture(async (root) => {
    const d = new HostDriver();
    let returned = "";
    const a = adapter(async (host) => {
      returned = await host.allocateDatabase("host-storage");
      expect(d.completionBeforeResponse).toBe(true);
      await host.task("await Promise.resolve()");
      return { name: returned };
    });
    a.policy = { ...a.policy, allocation: ownedDatabase("host-storage") };
    const result = await runPageSuite(a, () => d, options(root));
    expect(result.exit).toBe(0);
    expect(returned).toBe(`host-storage-${result.run}`);
    expect(d.allocations).toEqual([returned]);
    expect(result.ledger).toEqual([{ kind: "indexeddb", name: returned }]);
    expect(d.stopCalls).toBe(1);
  }));
for (const prefix of ["", "x".repeat(901)]) {
  test(`allocation rejects invalid prefix length ${prefix.length} before dispatch`, () =>
    fixture(async (root) => {
      const d = new HostDriver();
      const result = await runPageSuite(
        adapter(async (host) => {
          await expect(host.allocateDatabase(prefix)).rejects.toThrow("Invalid database prefix");
          return true;
        }),
        () => d,
        options(root),
      );
      expect(result.exit).toBe(0);
      expect(d.allocations).toEqual([]);
      expect(result.ledger).toEqual([]);
    }));
}
test("allocation retained by a callback rejects after capability revocation", () =>
  fixture(async (root) => {
    const d = new HostDriver();
    let saved: HostCase | undefined;
    const result = await runPageSuite(
      adapter(async (host) => {
        saved = host;
        return true;
      }),
      () => d,
      options(root),
    );
    if (!saved) throw new Error("Missing actual host capability");
    await expect(saved.allocateDatabase("host-storage")).rejects.toThrow();
    expect(result.exit).toBe(0);
    expect(d.allocations).toEqual([]);
  }));

for (const binding of [
  "run",
  "token",
  "doc",
  "caseId",
  "role",
  "execution",
  "url",
  "handle",
  "phase",
  "retired",
  "reporter",
  "closed",
]) {
  test(`allocation same-script ${binding} guard rejects without dispatch or constructor`, () =>
    fixture(async (root) => {
      const d = new HostDriver();
      const a = adapter(async (host) => {
        if (["run", "token", "caseId", "role", "execution"].includes(binding))
          d.config[binding] = "wrong";
        if (binding === "doc") d.currentDoc = "replacement";
        if (binding === "url") d.currentURL = "http://wrong/";
        if (binding === "handle") d.handle = async () => "foreign";
        if (binding === "phase") d.phase = "terminal";
        if (binding === "retired") d.retired = true;
        if (binding === "reporter") d.reportFailure = "REPORT_FAILURE";
        if (binding === "closed") d.uncertain = true;
        await host.allocateDatabase("host-storage");
        await host.script("window.effects.push(1)");
        return true;
      });
      a.policy = { ...a.policy, allocation: ownedDatabase("host-storage") };
      const result = await runPageSuite(a, () => d, options(root));
      expect(result.exit).toBe(2);
      expect(d.allocations).toEqual([]);
      expect(d.effects).toEqual([]);
      expect(result.ledger).toEqual([]);
      expect(d.stopCalls).toBe(1);
    }));
}
for (const policy of [undefined, ownedDatabase("other")]) {
  test(`allocation with ${policy ? "wrong" : "absent"} policy cannot return a name or ledger`, () =>
    fixture(async (root) => {
      const d = new HostDriver();
      const a = adapter(async (host) => {
        await host.allocateDatabase("host-storage");
        await host.script("window.effects.push(1)");
        return true;
      });
      a.policy = { ...a.policy, allocation: policy };
      const result = await runPageSuite(a, () => d, options(root));
      expect(result.exit).toBe(2);
      expect(result.ledger).toEqual([]);
      expect(d.effects).toEqual([]);
    }));
}
test("allocation may settle before its dispatch response but cannot return early", () =>
  fixture(async (root) => {
    const d = new HostDriver(),
      response = Promise.withResolvers<void>();
    const script = d.script.bind(d);
    let returned = false;
    d.script = async (source) => {
      const answer = await script(source);
      if (!source.includes("h.allocateDatabase(")) return answer;
      expect(d.completionBeforeResponse).toBe(true);
      expect(returned).toBe(false);
      response.resolve();
      return answer;
    };
    const a = adapter(async (host) => {
      await host.allocateDatabase("host-storage");
      returned = true;
      return true;
    });
    a.policy = { ...a.policy, allocation: ownedDatabase("host-storage") };
    const result = await runPageSuite(a, () => d, options(root));
    await response.promise;
    expect(result.exit).toBe(0);
    expect(returned).toBe(true);
  }));
test("uncertain dispatch after accepted allocation and task completion never returns its name", () =>
  fixture(async (root) => {
    const d = new HostDriver(),
      script = d.script.bind(d);
    d.script = async (source) => {
      const answer = await script(source);
      if (!source.includes("h.allocateDatabase(")) return answer;
      d.uncertain = true;
      throw new Error("ACTUAL_RESPONSE_LOST");
    };
    const a = adapter(async (host) => {
      await host.allocateDatabase("host-storage");
      await host.script("window.effects.push(1)");
      return true;
    });
    a.policy = { ...a.policy, allocation: ownedDatabase("host-storage") };
    const result = await runPageSuite(a, () => d, options(root));
    expect(result.exit).toBe(2);
    expect(result.ledger).toHaveLength(1);
    expect(d.completionBeforeResponse).toBe(true);
    expect(d.effects).toEqual([]);
    expect(result.runComplete).toBe(false);
  }));
for (const deadline of ["body", "document", "heartbeat", "run"]) {
  test(`queued allocation cannot cross ${deadline} deadline after handle wait`, () =>
    fixture(async (root) => {
      const d = new HostDriver();
      const a = adapter(async (host) => {
        const handle = d.handle.bind(d);
        d.handle = async () => {
          await Bun.sleep(deadline === "run" ? 220 : 100);
          return handle();
        };
        await host.allocateDatabase("host-storage");
        await host.script("window.effects.push(1)");
        return true;
      });
      a.policy = { ...a.policy, allocation: ownedDatabase("host-storage") };
      a.budgets = () => ({
        ...budgets,
        case: deadline === "body" ? 60 : 1000,
        caseDocument: deadline === "document" ? 60 : 2000,
        heartbeat: deadline === "heartbeat" ? 60 : 1000,
        run: deadline === "run" ? 150 : 5000,
      });
      const result = await runPageSuite(a, () => d, options(root));
      expect(result.exit).not.toBe(0);
      expect(d.allocations).toEqual([]);
      expect(result.ledger).toEqual([]);
      expect(d.effects).toEqual([]);
    }));
}
test("allocation accepts the same 900-character prefix bound as ownedDatabase", () =>
  fixture(async (root) => {
    const prefix = "x".repeat(900),
      d = new HostDriver();
    const a = adapter(async (host) => ({ name: await host.allocateDatabase(prefix) }));
    a.policy = { ...a.policy, allocation: ownedDatabase(prefix) };
    const result = await runPageSuite(a, () => d, options(root));
    expect(result.exit).toBe(0);
    expect(d.allocations).toEqual([`${prefix}-${result.run}`]);
  }));

for (const when of ["before-dispatch", "after-acceptance"]) {
  test(`interruption ${when} prevents allocation return and constructors`, () =>
    fixture(async (root) => {
      const d = new HostDriver(),
        controller = new AbortController();
      const a = adapter(async (host) => {
        if (when === "before-dispatch")
          d.handle = async () => {
            controller.abort("INTERRUPTED_BEFORE_ALLOCATION");
            return "root";
          };
        else {
          const script = d.script.bind(d);
          d.script = async (source) => {
            const answer = await script(source);
            if (source.includes("h.allocateDatabase("))
              controller.abort("INTERRUPTED_AFTER_ACCEPTANCE");
            return answer;
          };
        }
        await host.allocateDatabase("host-storage");
        await host.script("window.effects.push(1)");
        return true;
      });
      a.policy = { ...a.policy, allocation: ownedDatabase("host-storage") };
      const result = await runPageSuite(a, () => d, {
        ...options(root),
        signal: controller.signal,
      });
      expect(result.exit).toBe(2);
      expect(result.ledger).toHaveLength(when === "before-dispatch" ? 0 : 1);
      expect(d.effects).toEqual([]);
      expect(d.stopCalls).toBe(1);
    }));
}
test("aborted allocation wait retains its actual command and callback until they join", () =>
  fixture(async (root) => {
    const d = new HostDriver(),
      release = Promise.withResolvers<void>(),
      dispatched = Promise.withResolvers<void>();
    const script = d.script.bind(d);
    d.script = async (source) => {
      const answer = await script(source);
      if (!source.includes("h.allocateDatabase(")) return answer;
      dispatched.resolve();
      await release.promise;
      return answer;
    };
    const a = adapter(async (host) => {
      await host.allocateDatabase("host-storage");
      await host.script("window.effects.push(1)");
      return true;
    });
    a.policy = { ...a.policy, allocation: ownedDatabase("host-storage") };
    a.budgets = () => ({ ...budgets, run: 300 });
    try {
      const result = await runPageSuite(a, () => d, options(root));
      await dispatched.promise;
      const saved = JSON.stringify(result);
      expect(result.exit).toBe(2);
      expect(result.cleanup.session.status).toBe("confirmed");
      expect(result.cleanup.scratch.status).toBe("unconfirmed");
      release.resolve();
      await Bun.sleep(30);
      expect(JSON.stringify(result)).toBe(saved);
      expect(d.effects).toEqual([]);
      expect(d.stopCalls).toBe(1);
    } finally {
      release.resolve();
      await release.promise;
    }
  }));

test("late window selection cannot dispatch a retained user script after revocation", () =>
  fixture(async (root) => {
    const driver = new HostDriver();
    const original = driver.selectWindow.bind(driver);
    driver.selectWindow = async (handle) => {
      if (driver.phase === "driving") await Bun.sleep(130);
      await original(handle);
    };
    const result = await runPageSuite(
      adapter(async (host) => {
        await host.script("window.effects.push(17);");
        return true;
      }),
      () => driver,
      options(root),
    );
    expect(driver.effects).toEqual([]);
    expect(result.exit).toBe(1);
    expect(result.cleanup.session.status).toBe("confirmed");
  }));
test("several individually bounded operations can exceed the operation budget in total", () =>
  fixture(async (root) => {
    const driver = new HostDriver();
    const a = adapter(async (host) => {
      const started = performance.now();
      for (let index = 0; index < 12; index++) await host.task("await Promise.resolve();");
      expect(performance.now() - started).toBeGreaterThan(100);
      return true;
    });
    a.budgets = () => ({ ...budgets, case: 1000, operation: 100 });
    const result = await runPageSuite(a, () => driver, options(root));
    expect(result.exit).toBe(0);
    expect(driver.verdicts).toEqual([{ status: "pass", result: true }]);
  }));
test("one overdue operation fails within a still-valid body deadline", () =>
  fixture(async (root) => {
    const driver = new HostDriver();
    const original = driver.selectWindow.bind(driver);
    driver.selectWindow = async (handle) => {
      if (driver.phase === "driving") await Bun.sleep(80);
      await original(handle);
    };
    const a = adapter(async (host) => {
      await host.script("window.effects.push(19);");
      return true;
    });
    a.budgets = () => ({ ...budgets, case: 1000, operation: 30 });
    const result = await runPageSuite(a, () => driver, options(root));
    expect(result.exit).not.toBe(0);
    expect(driver.effects).toEqual([]);
    expect(result.outcomes.host?.status).not.toBe("pass");
  }));

function withHostFixture(run: (root: string) => Promise<void>): () => Promise<void> {
  return () => fixture(run);
}
test("original 60-second body credits two storage intervals but no setup or shell polling", async () => {
  const now = spyOn(performance, "now").mockReturnValue(100);
  try {
    const f = unitDrive({
      hello: 20_000,
      heartbeat: 200_000,
      case: 60_000,
      teardown: 60_000,
      caseDocument: 260_000,
      group: 90_000,
      run: 300_000,
    });
    f.d.script = async () => {
      f.send({ kind: "case-teardown", caseId: "host" });
      f.send({ kind: "case-end", caseId: "host", status: "pass", result: true });
      return { kind: "void" };
    };
    await f.host.drive(async (host) => {
      now.mockReturnValue(1100);
      expect(host.remainingMs()).toBe(59_000);
      host.setTimeout(120_000);
      now.mockReturnValue(60_100);
      host.setTimeout(119_000);
      expect(host.remainingMs()).toBe(59_000);
      now.mockReturnValue(65_600);
      expect(host.remainingMs()).toBe(53_500);
      host.setTimeout(179_000);
      now.mockReturnValue(85_600);
      host.setTimeout(139_000);
      expect(host.remainingMs()).toBe(53_500);
      now.mockReturnValue(90_600);
      expect(host.remainingMs()).toBe(48_500);
      return true;
    });
    expect(f.c.outcomes.host?.status).toBe("pass");
    expect(await f.consumers.join(50)).toBe(true);
  } finally {
    now.mockRestore();
  }
});

test(
  "timeout decrease expires synchronously before the monitor and cannot revive",
  withHostFixture(async (root) => {
    const d = new HostDriver();
    let checked = false;
    const result = await runPageSuite(
      adapter(async (host) => {
        const now = spyOn(performance, "now").mockReturnValue(performance.now() + 40);
        try {
          expect(() => host.setTimeout(20)).toThrow("timed out");
          expect(host.signal.aborted).toBe(true);
          expect(() => host.setTimeout(1000)).toThrow("timed out");
          checked = true;
        } finally {
          now.mockRestore();
        }
        return true;
      }),
      () => d,
      options(root),
    );
    expect(checked).toBe(true);
    expect(result.exit).toBe(1);
    expect(result.cleanup.scratch.status).toBe("confirmed");
  }),
);

for (const timeout of [0, -1, NaN, Infinity, -Infinity]) {
  test(
    `invalid timeout ${timeout} leaves the body unchanged`,
    withHostFixture(async (root) => {
      const result = await runPageSuite(
        adapter(async (host) => {
          const before = host.remainingMs();
          expect(() => host.setTimeout(timeout)).toThrow("positive and finite");
          expect(host.signal.aborted).toBe(false);
          expect(host.remainingMs()).toBeLessThanOrEqual(before);
          return true;
        }),
        () => new HostDriver(),
        options(root),
      );
      expect(result.exit).toBe(0);
    }),
  );
}

test(
  "an already expired body rejects an extension and a returned capability stays revoked",
  withHostFixture(async (root) => {
    let captured: HostCase | undefined;
    const result = await runPageSuite(
      adapter(async (host) => {
        captured = host;
        const now = spyOn(performance, "now").mockReturnValue(performance.now() + 81);
        try {
          expect(() => host.setTimeout(1000)).toThrow("timed out");
        } finally {
          now.mockRestore();
        }
        return true;
      }),
      () => new HostDriver(),
      options(root),
    );
    expect(result.exit).toBe(1);
    expect(() => captured?.setTimeout(1000)).toThrow();
  }),
);

test(
  "in-flight dispatch and sleep follow an extension instead of the old body timer",
  withHostFixture(async (root) => {
    const d = new HostDriver();
    const script = d.script.bind(d);
    const entered = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    d.script = async (source) => {
      if (source.includes("window.effects.push(23)")) {
        entered.resolve();
        await held.promise;
      }
      return script(source);
    };
    try {
      const result = await runPageSuite(
        adapter(async (host) => {
          const command = host.script("window.effects.push(23);");
          await entered.promise;
          const sleeping = host.sleep(110);
          host.setTimeout(400);
          await sleeping;
          expect(host.signal.aborted).toBe(false);
          held.resolve();
          await command;
          return true;
        }),
        () => d,
        { ...options(root), cleanupTimeoutMs: 500 },
      );
      expect(result.exit).toBe(0);
      expect(d.effects).toEqual([23]);
      expect(result.cleanup.scratch.status).toBe("confirmed");
    } finally {
      held.resolve();
    }
  }),
);

for (const end of ["extended", "decreased", "cancelled", "operation"] as const) {
  test(
    `an actual pending task is owned through ${end} body time`,
    withHostFixture(async (root) => {
      const d = new HostDriver(),
        held = Promise.withResolvers<void>();
      const controller = new AbortController();
      d.taskGate = held.promise;
      const script = d.script.bind(d);
      d.script = async (source) => {
        if (source.includes("h.verdict(")) {
          held.resolve();
          await d.taskCompletion;
        }
        return script(source);
      };
      let taskSettled = false;
      const a = adapter(async (host) => {
        const task = host.task("await actualPendingTask;");
        void task.then(
          () => {
            taskSettled = true;
          },
          () => {
            taskSettled = true;
          },
        );
        await d.taskEntered.promise;
        await host.script("return true;");
        host.setTimeout(400);
        if (end === "decreased") host.setTimeout(1);
        if (end === "cancelled") controller.abort("TASK_CANCELLED");
        if (end !== "extended") return task;
        await host.sleep(110);
        expect(taskSettled).toBe(false);
        await host.script("window.effects.push(29);");
        held.resolve();
        await task;
        return true;
      });
      if (end === "operation") a.budgets = () => ({ ...budgets, operation: 35 });
      try {
        const result = await runPageSuite(a, () => d, {
          ...options(root),
          signal: controller.signal,
        });
        expect(result.exit).toBe(end === "extended" ? 0 : 2);
        expect(d.effects).toEqual(end === "extended" ? [29] : []);
        if (end !== "extended") {
          expect(
            result.failures.some((failure) => failure.category === "page-task-unconfirmed"),
          ).toBe(true);
          expect(result.outcomes.host?.status).not.toBe("pass");
        }
      } finally {
        held.resolve();
        await d.taskCompletion?.catch(() => {});
      }
    }),
  );
}

for (const limit of ["run", "document", "heartbeat"] as const) {
  test(
    `timeout extension never changes the ${limit} clock`,
    withHostFixture(async (root) => {
      const d = new HostDriver();
      let bounded = false;
      const a = adapter(async (host) => {
        host.setTimeout(100_000);
        expect(host.remainingMs()).toBeLessThanOrEqual(
          limit === "run" ? 300 : limit === "heartbeat" ? 5000 : 2000,
        );
        const now = spyOn(performance, "now").mockReturnValue(performance.now() + 2100);
        try {
          expect(() => host.setTimeout(200_000)).toThrow();
          bounded = true;
        } finally {
          now.mockRestore();
        }
        return true;
      });
      if (limit === "run") a.budgets = () => ({ ...budgets, run: 300 });
      if (limit === "document") a.budgets = () => ({ ...budgets, heartbeat: 5000 });
      if (limit === "heartbeat") a.budgets = () => ({ ...budgets, caseDocument: 5000 });
      await runPageSuite(a, () => d, options(root));
      expect(bounded).toBe(true);
      expect(budgets.teardown).toBe(1000);
    }),
  );
}

test(
  "the host command guard retains every initial case query parameter",
  withHostFixture(async (root) => {
    const d = new HostDriver();
    const item = adapter(async (host) => {
      const changed = new URL(d.currentURL);
      changed.searchParams.set("renderer", "changed");
      d.currentURL = changed.href;
      await host.script("window.effects.push(31);");
      return true;
    });
    const inventory = item.inventory();
    item.inventory = () =>
      inventory.map((entry) => ({ ...entry, query: () => ({ test: "1", renderer: "canvas" }) }));
    const result = await runPageSuite(item, () => d, options(root));
    expect(result.exit).toBe(2);
    expect(d.effects).toEqual([]);
    expect(JSON.stringify(result.failures)).toContain("binding changed");
  }),
);

test(
  "long sleeps cannot overflow the timer into an early successful return",
  withHostFixture(async (root) => {
    let checked = false;
    const result = await runPageSuite(
      adapter(async (host) => {
        await expect(host.sleep(2_147_483_648)).rejects.toThrow("timed out");
        checked = true;
        return true;
      }),
      () => new HostDriver(),
      options(root),
    );
    expect(checked).toBe(true);
    expect(result.exit).toBe(1);
  }),
);

test(
  "public holdAsset registers before evaluation and original finally releases after body failure",
  withHostFixture(async (root) => {
    const driver = new HostDriver();
    const release = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>();
    let request: Promise<Response> | undefined;
    const a = adapter(async (host) => {
      host.holdAsset("/programs/shell-engine.wasm", async (held) => {
        entered.resolve();
        await release.promise;
        await held.continue();
      });
      try {
        request = fetch(`${driver.origin}/programs/shell-engine.wasm`, {
          headers: { Referer: driver.currentURL },
        });
        await entered.promise;
        throw new Error("ORIGINAL_BODY_ASSERTION");
      } finally {
        release.resolve();
      }
    });
    a.assets = async () => ({
      "/programs/shell-engine.wasm": new Blob(["original"], { type: "application/wasm" }),
    });
    try {
      const result = await runPageSuite(a, () => driver, options(root));
      expect(result.exit).toBe(1);
      expect(JSON.stringify(result.results)).toContain("ORIGINAL_BODY_ASSERTION");
      expect(request).toBeDefined();
      expect(await (await request)?.text()).toBe("original");
      expect(driver.navigations).toBe(3);
      expect(result.cleanup.scratch.status).toBe("confirmed");
    } finally {
      release.resolve();
      await request?.catch(() => {});
    }
  }),
);

for (const interrupted of [false, true]) {
  test(
    `actual asset callback debt forbids next case and finish after ${interrupted ? "interruption" : "response handoff"}`,
    withHostFixture(async (root) => {
      const driver = new HostDriver(),
        controller = new AbortController();
      const release = Promise.withResolvers<void>(),
        entered = Promise.withResolvers<void>();
      let request: Promise<Response> | undefined;
      const a = adapter(async (host) => {
        host.holdAsset("/programs/test-guest.wasm", async (held) => {
          await held.continue();
          entered.resolve();
          await release.promise;
        });
        request = fetch(`${driver.origin}/programs/test-guest.wasm`, {
          headers: { Referer: driver.currentURL },
        });
        expect(await (await request).text()).toBe("guest");
        await entered.promise;
        if (interrupted) controller.abort("original interruption");
        return true;
      });
      a.assets = async () => ({
        "/programs/test-guest.wasm": new Blob(["guest"], { type: "application/wasm" }),
      });
      a.budgets = () => ({ ...budgets, teardown: 80 });
      try {
        const result = await runPageSuite(a, () => driver, {
          ...options(root),
          signal: controller.signal,
        });
        expect(result.exit).toBe(2);
        expect(driver.navigations).toBe(2);
        expect(result.runComplete).toBe(false);
        expect(result.cleanup.scratch.status).toBe("unconfirmed");
        expect(
          result.failures.some((failure) => failure.category === "host-work-unconfirmed"),
        ).toBe(true);
      } finally {
        release.resolve();
        await request?.catch(() => {});
      }
    }),
  );
}

test(
  "verdict delivery and actual body join share the deadline from synchronous revocation",
  withHostFixture(async (root) => {
    const driver = new HostDriver(),
      controller = new AbortController();
    const release = Promise.withResolvers<void>();
    let deadline = 0,
      revokedAt = 0;
    const script = driver.script.bind(driver);
    driver.script = async (source) => {
      if (source.includes("h.verdict(")) {
        await Bun.sleep(70);
        const match = /h\.verdict\(.+, ([\d.]+)\);/.exec(source);
        deadline = Number(match?.[1]);
      }
      return script(source);
    };
    const a = adapter(async () => {
      revokedAt = performance.timeOrigin + performance.now();
      controller.abort("body cancellation");
      await release.promise;
      return true;
    });
    a.budgets = () => ({ ...budgets, teardown: 110 });
    const started = performance.now();
    try {
      const result = await runPageSuite(a, () => driver, {
        ...options(root),
        signal: controller.signal,
      });
      expect(deadline - revokedAt).toBeGreaterThan(100);
      expect(deadline - revokedAt).toBeLessThan(125);
      expect(performance.now() - started).toBeLessThan(450);
      expect(result.cleanup.scratch.status).toBe("unconfirmed");
      expect(driver.navigations).toBe(2);
    } finally {
      release.resolve();
    }
  }),
);

test("heartbeat liveness probe shares the teardown deadline and joins its command", async () => {
  const limits = {
    hello: 1000,
    heartbeat: 70,
    case: 6000,
    caseDocument: 8000,
    group: 8000,
    teardown: 90,
    run: 10_000,
  };
  const f = unitDrive(limits);
  let revokedAt = 0;
  let probeAbortedAt = 0;
  f.d.handles = async (signal?: AbortSignal) => {
    if (!signal) throw new Error("Missing probe signal");
    const stopped = Promise.withResolvers<never>();
    const abort = () => {
      probeAbortedAt = performance.now();
      stopped.reject(signal.reason);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    return stopped.promise;
  };
  try {
    await f.host
      .drive(async (host) => {
        const revoked = Promise.withResolvers<void>();
        const abort = () => {
          revokedAt = performance.now();
          revoked.resolve();
        };
        host.signal.addEventListener("abort", abort, { once: true });
        await revoked.promise;
        return null;
      })
      .catch(() => {});
    expect(revokedAt).toBeGreaterThan(0);
    expect(probeAbortedAt).toBeGreaterThanOrEqual(revokedAt);
    expect(probeAbortedAt - f.host.teardownDeadline()).toBeLessThan(150);
    expect(performance.now() - revokedAt).toBeLessThan(500);
    expect(await f.consumers.join(50)).toBe(true);
    expect(f.c.failures.some((failure) => failure.category === "heartbeat-lost")).toBe(true);
  } finally {
    f.consumers.revoke();
    await f.d.stop();
    expect(await f.consumers.join(100)).toBe(true);
  }
}, 10_000);

test(
  "settled asset work permits final cleanup without erasing its teardown failure",
  withHostFixture(async (root) => {
    const driver = new HostDriver();
    const entered = Promise.withResolvers<void>();
    let request: Promise<Response> | undefined;
    const a = adapter(async (host) => {
      host.holdAsset("/programs/test-guest.wasm", async (held) => {
        await held.continue();
        entered.resolve();
        await Bun.sleep(200);
      });
      request = fetch(`${driver.origin}/programs/test-guest.wasm`, {
        headers: { Referer: driver.currentURL },
      });
      expect(await (await request).text()).toBe("guest");
      await entered.promise;
      return true;
    });
    a.assets = async () => ({
      "/programs/test-guest.wasm": new Blob(["guest"], { type: "application/wasm" }),
    });
    a.budgets = () => ({ ...budgets, teardown: 40 });
    try {
      const result = await runPageSuite(a, () => driver, {
        ...options(root),
        cleanupTimeoutMs: 1000,
      });
      expect(result.exit).toBe(2);
      expect(result.runComplete).toBe(false);
      expect(result.failures.some((failure) => failure.category === "host-work-unconfirmed")).toBe(
        true,
      );
      expect(driver.navigations).toBe(2);
      expect(result.cleanup.server.status).toBe("confirmed");
      expect(result.cleanup.scratch.status).toBe("confirmed");
    } finally {
      await request?.catch(() => {});
    }
  }),
);

function keyUnit(limits: Budgets = { ...budgets, case: 500, teardown: 30 }) {
  const f = unitDrive(limits);
  f.d.config = { run: "r", token: "token", caseId: "host", role: "case", execution: "host" };
  f.d.currentURL = "http://fixture/";
  f.d.currentDoc = "doc";
  f.d.phase = "driving";
  const script = f.d.script.bind(f.d);
  f.d.script = async (source) => {
    if (!source.includes("h.verdict(")) return script(source);
    f.send({ kind: "case-teardown", caseId: "host" });
    const result = f.c.results.host;
    const passed = record(result) && record(result.body) && result.body.status === "pass";
    f.send(
      passed
        ? { kind: "case-end", caseId: "host", status: "pass", result: true }
        : { kind: "case-end", caseId: "host", status: "fail", error: "host body failed" },
    );
    return { kind: "void" };
  };
  return f;
}
async function keyBody(
  f: ReturnType<typeof keyUnit>,
  callback: (host: HostCase) => Promise<unknown>,
): Promise<void> {
  try {
    await f.host.drive(callback);
  } catch {}
}
for (const key of ["Home", "ArrowUp", "ArrowRight", "Enter"] as const) {
  test(`host press ${key} uses the existing queue and guarded script afterward`, async () => {
    const f = keyUnit();
    const effects: string[] = [];
    f.d.press = async (actual, control) => {
      await control.dispatch(async () => {
        effects.push(actual);
      });
    };
    await keyBody(f, async (host) => {
      await host.script("window.effects.push(1)");
      await host.press(key);
      await host.script("window.effects.push(2)");
      return true;
    });
    expect(effects).toEqual([key]);
    expect(f.d.effects).toEqual([1, 2]);
    expect(await f.consumers.join(100)).toBe(true);
    expect(f.c.outcomes.host?.status).toBe("pass");
    expect("press" in f.host.transport).toBe(false);
  });
}
test("malformed runtime keys and extra press arguments reject before remote work", async () => {
  const f = keyUnit();
  const selecting = spyOn(f.d, "selectWindow");
  let checked = false;
  await keyBody(f, async (host) => {
    const before = selecting.mock.calls.length;
    for (const key of [
      undefined,
      null,
      1,
      {},
      [],
      "",
      "Control+c",
      "NumpadEnter",
      "text",
      "\uE006",
    ]) {
      expect(() => Reflect.apply(host.press, host, [key])).toThrow("Unsupported host key");
    }
    expect(() => Reflect.apply(host.press, host, ["Enter", {}])).toThrow("only a key");
    expect(selecting.mock.calls.length).toBe(before);
    checked = true;
    return true;
  });
  expect(checked).toBe(true);
  selecting.mockRestore();
});
for (const binding of [
  "run",
  "token",
  "caseId",
  "role",
  "execution",
  "url",
  "doc",
  "phase",
  "retired",
  "reporter",
  "cutoff",
  "physical",
  "handle",
] as const) {
  test(`press rejects changed ${binding} before input`, async () => {
    const f = keyUnit();
    let sent = 0;
    f.d.press = async (_key, control) => {
      await control.dispatch(async () => {
        sent++;
      });
    };
    await keyBody(f, async (host) => {
      if (["run", "token", "caseId", "role", "execution"].includes(binding))
        f.d.config[binding] = "wrong";
      if (binding === "url") f.d.currentURL = "http://wrong/";
      if (binding === "doc") f.d.currentDoc = "replacement";
      if (binding === "phase") f.d.phase = "terminal";
      if (binding === "retired") f.d.retired = true;
      if (binding === "reporter") f.d.reportFailure = "report failed";
      if (binding === "cutoff") f.state.cutoff = 0;
      if (binding === "physical") f.state.physical = "closed";
      if (binding === "handle") f.d.handle = async () => "foreign";
      await host.press("Home");
      return true;
    });
    expect(sent).toBe(0);
    expect(f.c.outcomes.host?.status).not.toBe("pass");
    expect(await f.consumers.join(100)).toBe(true);
  });
}
for (const boundary of ["select", "handle", "preflight", "first-request"] as const) {
  for (const reason of ["operation", "body", "run", "document", "collector", "reporter"] as const) {
    test(`press checks ${reason} synchronously after ${boundary} before another send`, async () => {
      const now = spyOn(performance, "now").mockReturnValue(100);
      const f = keyUnit({ ...budgets, case: 300, operation: 200, run: 1500, caseDocument: 1000 });
      let sends = 0;
      const expire = () => {
        if (reason === "operation") now.mockReturnValue(301);
        if (reason === "body") now.mockReturnValue(401);
        if (reason === "run") now.mockReturnValue(1601);
        if (reason === "document") now.mockReturnValue(1101);
        if (reason === "collector") f.c.fail("control", "sticky", f.state);
        if (reason === "reporter") f.d.reportFailure = "reporter revoked";
      };
      const select = f.d.selectWindow.bind(f.d),
        handle = f.d.handle.bind(f.d),
        script = f.d.script.bind(f.d);
      if (boundary === "select")
        f.d.selectWindow = async (value) => {
          await select(value);
          expire();
        };
      if (boundary === "handle")
        f.d.handle = async () => {
          const value = await handle();
          expire();
          return value;
        };
      if (boundary === "preflight")
        f.d.script = async (source) => {
          if (reason === "reporter") expire();
          const value = await script(source);
          if (reason !== "reporter") expire();
          return value;
        };
      f.d.press = async (_key, control) => {
        await control.dispatch(async () => {
          sends++;
          if (boundary === "first-request") expire();
        });
        await control.dispatch(async () => {
          sends++;
        });
      };
      try {
        await keyBody(f, async (host) => {
          await host.press("Home");
          return true;
        });
        expect(sends).toBe(boundary === "first-request" ? 1 : 0);
        expect(f.c.outcomes.host?.status).not.toBe("pass");
        expect(await f.consumers.join(100)).toBe(true);
      } finally {
        now.mockRestore();
      }
    });
  }
}
test("overlap reserves busy synchronously and sends no second preparation", async () => {
  const f = keyUnit();
  const held = Promise.withResolvers<void>();
  let selects = 0,
    inputs = 0;
  f.d.selectWindow = async () => {
    selects++;
    await held.promise;
  };
  f.d.press = async (_key, control) => {
    const first = control.dispatch(async () => {
      inputs++;
    });
    await expect(
      control.dispatch(async () => {
        inputs++;
      }),
    ).rejects.toThrow("Overlapping");
    expect(selects).toBe(1);
    held.resolve();
    await first;
  };
  try {
    await keyBody(f, async (host) => {
      await host.press("Enter");
      return true;
    });
    expect(inputs).toBe(0);
    expect(selects).toBe(1);
  } finally {
    held.resolve();
    expect(await f.consumers.join(100)).toBe(true);
  }
});
test("a retained dispatch rejects after normal press return while body is still active", async () => {
  const f = keyUnit();
  let retained: import("./driver.js").DriverPressControl | undefined;
  let sends = 0;
  f.d.press = async (_key, control) => {
    retained = control;
    await control.dispatch(async () => {
      sends++;
    });
  };
  await keyBody(f, async (host) => {
    await host.press("Home");
    const selects = spyOn(f.d, "selectWindow");
    try {
      await expect(
        retained?.dispatch(async () => {
          sends++;
        }),
      ).rejects.toThrow("lease closed");
      expect(selects).not.toHaveBeenCalled();
      expect(host.signal.aborted).toBe(false);
    } finally {
      selects.mockRestore();
    }
    return true;
  });
  expect(sends).toBe(1);
  expect(f.c.outcomes.host?.status).toBe("pass");
});
for (const stage of ["preflight", "input"] as const) {
  for (const driverEnd of ["return", "throw"] as const) {
    for (const requestEnd of ["fulfill", "reject", "pending"] as const) {
      test(`early driver ${driverEnd} during ${stage}, request ${requestEnd}, holds the queue through real drainage`, async () => {
        const f = keyUnit({ ...budgets, case: 250, teardown: 30 });
        const held = Promise.withResolvers<void>(),
          entered = Promise.withResolvers<void>();
        let sends = 0,
          laterWork = 0,
          postflight = 0;
        const select = f.d.selectWindow.bind(f.d);
        f.d.selectWindow = async (value) => {
          postflight++;
          await select(value);
          if (stage === "preflight") {
            entered.resolve();
            await held.promise;
          }
        };
        let dispatch: Promise<void> | undefined;
        f.d.press = async (_key, control) => {
          dispatch = control.dispatch(async () => {
            sends++;
            entered.resolve();
            await held.promise;
          });
          void dispatch.catch(() => {});
          await entered.promise;
          if (driverEnd === "throw") throw new Error("early driver throw");
        };
        try {
          await keyBody(f, async (host) => {
            const pressing = host.press("Enter");
            const next = host.script("window.effects.push(55)").then(
              () => {
                laterWork++;
              },
              () => {},
            );
            await expect(pressing).rejects.toThrow();
            expect(await f.consumers.join(1)).toBe(false);
            if (requestEnd === "fulfill") held.resolve();
            if (requestEnd === "reject") held.reject(new Error("late request rejection"));
            await next;
            return true;
          });
          expect(laterWork).toBe(0);
          expect(f.d.effects).toEqual([]);
          expect(sends).toBe(stage === "input" ? 1 : 0);
          expect(postflight).toBe(1);
          expect(f.c.outcomes.host?.status).not.toBe("pass");
          expect(await f.consumers.join(1)).toBe(requestEnd !== "pending");
        } finally {
          held.resolve();
          await dispatch?.catch(() => {});
          expect(await f.consumers.join(100)).toBe(true);
        }
      });
    }
  }
}

for (const end of ["fulfill", "reject"] as const) {
  test(
    `real Playwright preflight timeout retains run scratch until raw ${end}, even after context close`,
    () =>
      fixture(async (root) => {
        const raw = Promise.withResolvers<unknown>();
        const local = new PlaywrightDriver("chromium", "/unused/raw-preflight");
        let evaluations = 0;
        Reflect.set(local, "page", {
          evaluate() {
            evaluations++;
            return raw.promise;
          },
        });
        const closed = spyOn(BrowserRunnerLifecycle.prototype, "close").mockResolvedValue();
        const driver = new HostDriver();
        const originalScript = driver.script.bind(driver),
          originalStop = driver.stop.bind(driver);
        let hold = false,
          inputs = 0,
          later = 0;
        Object.defineProperty(driver, "uncertain", { get: () => local.uncertain });
        driver.script = (source, signal?: AbortSignal) => {
          if (!hold || driver.phase !== "driving") return originalScript(source);
          hold = false;
          return local.script(source, signal ?? new AbortController().signal);
        };
        driver.press = async (_key, control) => {
          await control.dispatch(async () => {
            inputs++;
          });
        };
        driver.stop = () => {
          void originalStop();
          return local.stop();
        };
        const a = adapter(async (host) => {
          hold = true;
          try {
            await host.press("Home");
          } catch {}
          try {
            await host.press("Enter");
            later++;
          } catch {}
          try {
            await host.script("window.effects.push(91)");
            later++;
          } catch {}
          return true;
        });
        a.budgets = () => ({
          ...budgets,
          case: 8000,
          heartbeat: 10_000,
          operation: 5000,
          teardown: 40,
          caseDocument: 12_000,
          group: 12_000,
          run: 15_000,
        });
        try {
          const result = await runPageSuite(a, () => driver, options(root));
          expect(result.exit).toBe(2);
          expect(result.cleanup.session.status).toBe("unconfirmed");
          expect(result.cleanup.scratch.status).toBe("unconfirmed");
          expect(closed).toHaveBeenCalledTimes(1);
          expect(JSON.stringify(result)).toContain("script timeout");
          expect(inputs).toBe(0);
          expect(later).toBe(0);
          expect(evaluations).toBe(1);
          expect(driver.effects).toEqual([]);
          const saved = JSON.stringify(result);
          if (end === "fulfill") raw.resolve({ kind: "void" });
          else raw.reject(new Error("late raw evaluation rejection"));
          expect((await local.stop()).session.status).toBe("confirmed");
          expect(JSON.stringify(result)).toBe(saved);
          expect(driver.stopCalls).toBe(1);
        } finally {
          raw.resolve(null);
          await local.stop();
          closed.mockRestore();
        }
      }),
    10_000,
  );
}
for (const end of ["fulfill", "reject", "pending"] as const) {
  test(`admitted opaque action ${end} is not rolled back, owns scratch, and blocks next task`, () =>
    fixture(async (root) => {
      const driver = new HostDriver();
      const held = Promise.withResolvers<void>();
      const edges: string[] = [];
      let dispatch: Promise<void> | undefined;
      driver.press = async (_key, control) => {
        dispatch = control.dispatch(async () => {
          edges.push("down");
          await held.promise;
          edges.push("up");
        });
        await dispatch;
      };
      let queued: Promise<void> | undefined;
      let taskEntered = false;
      void driver.taskEntered.promise.then(function markTaskEntered() {
        taskEntered = true;
      });
      const a = adapter(async (host) => {
        const pressing = host.press("Home");
        queued = host.task("await laterTask;").catch(ignoreKeyRejection);
        await expect(pressing).rejects.toThrow();
        if (end === "fulfill") held.resolve();
        if (end === "reject") held.reject(new Error("late native failure, key release unknown"));
        await queued;
        return true;
      });
      a.budgets = () => ({ ...budgets, teardown: 35 });
      try {
        const result = await runPageSuite(a, () => driver, options(root));
        expect(result.exit).toBe(2);
        expect(edges).toEqual(end === "fulfill" ? ["down", "up"] : ["down"]);
        expect(taskEntered).toBe(false);
        expect(result.runComplete).toBe(false);
        expect(driver.navigations).toBe(2);
        expect(result.cleanup.scratch.status).toBe(end === "pending" ? "unconfirmed" : "confirmed");
        if (end === "pending") expect(result.cleanup.scratch.detail).toContain("Retained");
      } finally {
        held.resolve();
        await dispatch?.catch(() => {});
        await queued;
      }
    }));
}

function ignoreKeyRejection(): void {}

for (const expired of [false, true]) {
  test(`press queued behind a live script preserves ${expired ? "original admission deadline" : "ordering"}`, async () => {
    const now = spyOn(performance, "now").mockReturnValue(100);
    const f = keyUnit({ ...budgets, case: 1000, operation: 200, heartbeat: 5000 });
    const held = Promise.withResolvers<void>(),
      entered = Promise.withResolvers<void>();
    const original = f.d.script.bind(f.d);
    const order: string[] = [];
    f.d.script = async (source) => {
      if (source.includes("FIRST_QUEUED_COMMAND")) {
        entered.resolve();
        await held.promise;
        order.push("script");
      }
      return original(source);
    };
    f.d.press = async (key, control) => {
      await control.dispatch(async () => {
        order.push(key);
      });
    };
    try {
      await keyBody(f, async (host) => {
        const first = host.script("return 'FIRST_QUEUED_COMMAND';");
        await entered.promise;
        const next = host.press("Home");
        if (expired) now.mockReturnValue(301);
        held.resolve();
        await Promise.allSettled([first, next]);
        return true;
      });
      expect(order).toEqual(expired ? ["script"] : ["script", "Home"]);
      expect(await f.consumers.join(100)).toBe(true);
    } finally {
      held.resolve();
      now.mockRestore();
    }
  });
}

for (const kind of ["throw", "reject"] as const) {
  test(`synchronous send ${kind} stays sticky even if the driver catches it`, async () => {
    const f = keyUnit();
    let sends = 0;
    f.d.press = async (_key, control) => {
      await control
        .dispatch(() => {
          sends++;
          if (kind === "throw") throw new Error("synchronous send failed");
          return Promise.reject(new Error("rejected native action"));
        })
        .catch(ignoreKeyRejection);
    };
    await keyBody(f, async (host) => {
      await expect(host.press("Enter")).rejects.toThrow();
      await expect(host.task("await forbiddenTask;")).rejects.toThrow();
      return true;
    });
    expect(sends).toBe(1);
    expect(f.c.outcomes.host?.status).not.toBe("pass");
    expect(await f.consumers.join(100)).toBe(true);
  });
}

for (const stage of ["preflight", "input"] as const) {
  test(`early driver return with ${stage} still pending retains actual suite scratch`, () =>
    fixture(async (root) => {
      const driver = new HostDriver();
      const held = Promise.withResolvers<void>(),
        entered = Promise.withResolvers<void>();
      let dispatch: Promise<void> | undefined;
      let inputs = 0,
        next = false;
      const select = driver.selectWindow.bind(driver);
      driver.selectWindow = async (handle) => {
        await select(handle);
        if (stage === "preflight" && driver.phase === "driving") {
          entered.resolve();
          await held.promise;
        }
      };
      driver.press = async (_key, control) => {
        dispatch = control.dispatch(async () => {
          inputs++;
          entered.resolve();
          await held.promise;
        });
        void dispatch.catch(ignoreKeyRejection);
        await entered.promise;
      };
      const markNext = () => {
        next = true;
      };
      const a = adapter(async (host) => {
        const pressing = host.press("Enter");
        const later = host.task("await forbiddenTask;").then(markNext, ignoreKeyRejection);
        await expect(pressing).rejects.toThrow("active dispatch");
        await later;
        return true;
      });
      a.budgets = () => ({ ...budgets, teardown: 35 });
      try {
        const result = await runPageSuite(a, () => driver, options(root));
        expect(result.exit).toBe(2);
        expect(result.cleanup.session.status).toBe("confirmed");
        expect(result.cleanup.scratch.status).toBe("unconfirmed");
        expect(result.runComplete).toBe(false);
        expect(driver.navigations).toBe(2);
        expect(inputs).toBe(stage === "input" ? 1 : 0);
        expect(next).toBe(false);
        const retained = result.cleanup.scratch.detail.match(/^Retained (.*), consumers/);
        if (!retained?.[1]) throw new Error("Missing retained scratch location");
        expect((await stat(retained[1])).isDirectory()).toBe(true);
      } finally {
        held.resolve();
        await dispatch?.catch(ignoreKeyRejection);
      }
    }));
}
