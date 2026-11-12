import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPageSuite, type SuiteAdapter, type FixtureRoute } from "waffle/testing/page-runner";
import { FakeDriver } from "./fake-driver.js";

const id = "fixture";
function adapter(routes: readonly FixtureRoute[], close = async () => {}): SuiteAdapter<object> {
  return {
    suite: id,
    inventory: () => [{ id, label: id, request: () => ({}) }],
    policy: { listIds: () => [id], check() {} },
    assets: async () => ({ "/page.js": "" }),
    fixture: { caseId: id, create: () => ({ start: async () => routes, close }) },
    budgets: () => ({ hello: 1000, heartbeat: 1000, case: 1000, group: 2000, run: 5000 }),
  };
}
async function withRoot(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "fixture-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
class RouteDriver extends FakeDriver {
  constructor(readonly callback: (driver: RouteDriver) => Promise<void>) {
    super("pass", { list: [id], result: true });
  }
  protected override async run(role: unknown, request: unknown): Promise<void> {
    if (role !== "case") return super.run(role, request);
    await this.send({ kind: "case-start", caseId: id });
    await this.callback(this);
    await this.send({ kind: "case-end", caseId: id, status: "pass", result: true });
    await this.completeDocument();
  }
  headers() {
    return {
      "X-Waffle-Fixture": new URL(this.currentURL).searchParams.get("token") ?? "",
      "X-Waffle-Document": this.currentDoc,
    };
  }
}
for (const path of [
  "/report",
  "/heartbeat",
  "/retire",
  "/favicon.ico",
  "/",
  "/page.js",
  "/_waffle_owned/x/",
  "/../idle",
  "/idle?x",
  "/idle#x",
]) {
  test(`fixture route ${path} cannot shadow host or assets`, () =>
    withRoot(async (root) => {
      let starts = 0,
        closes = 0;
      const result = await runPageSuite(
        adapter([{ path, get: async () => 1 }], async () => {
          closes++;
        }),
        () => {
          starts++;
          return new FakeDriver("pass");
        },
        { scratchRoot: root, resultPath: join(root, "result.json"), port: "ephemeral" },
      );
      expect(result.exit).toBe(2);
      expect(starts).toBe(0);
      expect(closes).toBe(1);
      expect(result.cleanup.fixture.status).toBe("confirmed");
    }));
}
test("duplicate JSON routes fail before driver allocation", () =>
  withRoot(async (root) => {
    const route = { path: "/idle", get: async () => 1 };
    const result = await runPageSuite(
      adapter([route, route]),
      () => {
        throw new Error("Unexpected driver");
      },
      { scratchRoot: root, resultPath: join(root, "r.json"), port: "ephemeral" },
    );
    expect(result.failures.some((failure) => failure.detail.includes("conflicts"))).toBe(true);
  }));
test("fixture starts on the actual bound origin and protected methods never invoke it", () =>
  withRoot(async (root) => {
    let calls = 0,
      bound = "",
      closed = 0;
    const a = adapter(
      [
        {
          path: "/idle",
          get: async () => {
            calls++;
            return { value: 7 };
          },
        },
      ],
      async () => {
        closed++;
      },
    );
    const declaration = a.fixture!;
    a.fixture = {
      ...declaration,
      create: () => {
        const f = declaration.create();
        return {
          close: () => f.close(),
          start: async (context) => {
            bound = context.origin;
            expect((await fetch(context.origin + "/page.js")).status).toBe(200);
            return f.start(context);
          },
        };
      },
    };
    const d = new RouteDriver(async (driver) => {
      expect(driver.origin).toBe(bound);
      for (const method of ["HEAD", "POST", "OPTIONS", "PUT", "DELETE", "PATCH"]) {
        const response = await fetch(bound + "/idle", { method, headers: driver.headers() });
        expect(response.status).toBe(405);
        expect(response.headers.get("Allow")).toBe("GET");
      }
      expect((await fetch(bound + "/idle")).status).toBe(410);
      expect(
        (
          await fetch(bound + "/idle", {
            headers: { ...driver.headers(), "X-Waffle-Document": "foreign" },
          })
        ).status,
      ).toBe(410);
      expect(calls).toBe(0);
      const value = await fetch(bound + "/idle", { headers: driver.headers() });
      expect(await value.json()).toEqual({ value: 7 });
      expect(calls).toBe(1);
      for (const path of ["/report", "/heartbeat", "/retire"]) {
        expect(
          (await fetch(bound + path, { method: "OPTIONS", headers: driver.headers() })).status,
        ).toBe(405);
      }
    });
    const result = await runPageSuite(a, () => d, {
      scratchRoot: root,
      resultPath: join(root, "r.json"),
      port: "ephemeral",
    });
    expect(result.exit).toBe(0);
    expect(closed).toBe(1);
  }));
for (const value of [
  undefined,
  "x".repeat(48 * 1024),
  {
    toJSON() {
      throw new Error("SERIALIZATION_FAILURE");
    },
  },
]) {
  test("fixture serialization failure is sticky and never a successful empty observation", () =>
    withRoot(async (root) => {
      const d = new RouteDriver(async (driver) => {
        expect((await fetch(driver.origin + "/idle", { headers: driver.headers() })).status).toBe(
          409,
        );
      });
      const result = await runPageSuite(
        adapter([{ path: "/idle", get: async () => value }]),
        () => d,
        { scratchRoot: root, resultPath: join(root, "r.json"), port: "ephemeral" },
      );
      expect(result.exit).toBe(2);
      expect(result.failures.some((failure) => failure.category === "fixture")).toBe(true);
      expect(result.cleanup.fixture.status).toBe("confirmed");
    }));
}
for (const failure of ["start", "close"]) {
  test(`actual fixture ${failure} rejection is visible`, () =>
    withRoot(async (root) => {
      let closes = 0;
      const a = adapter([], async () => {
        closes++;
        if (failure === "close") throw new Error("CLOSE_FAILURE");
      });
      if (failure === "start")
        a.fixture = {
          caseId: id,
          create: () => ({
            start: async () => {
              throw new Error("START_FAILURE");
            },
            close: async () => {
              closes++;
            },
          }),
        };
      const result = await runPageSuite(
        a,
        () => new FakeDriver("pass", { list: [id], result: true }),
        { scratchRoot: root, resultPath: join(root, "r.json"), port: "ephemeral" },
      );
      expect(result.exit).toBe(2);
      expect(closes).toBe(1);
      expect(
        failure === "close" ? result.cleanup.fixture.detail : JSON.stringify(result.failures),
      ).toContain(failure.toUpperCase() + "_FAILURE");
    }));
}
test("noncooperative callback keeps immutable debt and scratch until test-owned release, with one late close", () =>
  withRoot(async (root) => {
    const entered = Promise.withResolvers<void>(),
      latch = Promise.withResolvers<void>(),
      closed = Promise.withResolvers<void>();
    const controller = new AbortController();
    let closeCalls = 0,
      scratch = "",
      response: Promise<Response> | undefined;
    const a = adapter(
      [
        {
          path: "/idle",
          get: async () => {
            entered.resolve();
            await latch.promise;
            return { sockets: 0 };
          },
        },
      ],
      async () => {
        closeCalls++;
        closed.resolve();
      },
    );
    const original = a.assets;
    a.assets = async (context) => {
      scratch = context.scratch;
      return original(context);
    };
    const d = new RouteDriver(async (driver) => {
      response = fetch(driver.origin + "/idle", { headers: driver.headers() });
      void response.catch(() => {});
      await entered.promise;
      controller.abort("held callback");
    });
    try {
      const result = await runPageSuite(a, () => d, {
        scratchRoot: root,
        resultPath: join(root, "r.json"),
        port: "ephemeral",
        signal: controller.signal,
        cleanupTimeoutMs: 25,
      });
      expect(result.exit).toBe(2);
      expect(result.cleanup.callbacks.status).toBe("unconfirmed");
      expect(result.cleanup.fixture.status).toBe("unconfirmed");
      expect(result.cleanup.scratch.status).toBe("unconfirmed");
      expect((await stat(scratch)).isDirectory()).toBe(true);
      const frozen = JSON.stringify(result);
      expect(closeCalls).toBe(0);
      latch.resolve();
      await closed.promise;
      await response?.catch(() => {});
      expect(closeCalls).toBe(1);
      expect(JSON.stringify(result)).toBe(frozen);
    } finally {
      latch.resolve();
      await closed.promise;
      await response?.catch(() => {});
    }
  }));

test("saved fixture diagnostics preserve simultaneous startup and close aggregate causes", () =>
  withRoot(async (root) => {
    let closes = 0;
    const a = adapter([]);
    a.fixture = {
      caseId: id,
      create: () => ({
        start: async () => {
          throw new AggregateError(
            [new Error("PRIMARY_START"), new Error("START_CLEANUP")],
            "START_AGGREGATE",
          );
        },
        close: async () => {
          closes++;
          throw new AggregateError(
            [new Error("CLOSE_LISTENER"), new Error("CLOSE_SOCKET")],
            "CLOSE_AGGREGATE",
          );
        },
      }),
    };
    const path = join(root, "causes.json");
    const result = await runPageSuite(
      a,
      () => {
        throw new Error("Unexpected driver");
      },
      { scratchRoot: root, resultPath: path, port: "ephemeral" },
    );
    expect(result.exit).toBe(2);
    expect(closes).toBe(1);
    const saved = await Bun.file(path).text();
    for (const cause of ["PRIMARY_START", "START_CLEANUP", "CLOSE_LISTENER", "CLOSE_SOCKET"])
      expect(saved).toContain(cause);
  }));

for (const stage of ["callback", "serialization"]) {
  test(`saved fixture ${stage} diagnostics preserve aggregate causes`, () =>
    withRoot(async (root) => {
      const fail = () => {
        throw new AggregateError([new Error("INNER_PRIMARY"), false], "OBSERVATION_FAILURE");
      };
      const route = {
        path: "/idle",
        get: async () => (stage === "callback" ? fail() : { toJSON: fail }),
      };
      const d = new RouteDriver(async (driver) => {
        expect((await fetch(driver.origin + "/idle", { headers: driver.headers() })).status).toBe(
          409,
        );
      });
      const path = join(root, "observation.json");
      const result = await runPageSuite(adapter([route]), () => d, {
        scratchRoot: root,
        resultPath: path,
        port: "ephemeral",
      });
      expect(result.exit).toBe(2);
      const saved = await Bun.file(path).text();
      expect(saved).toContain("INNER_PRIMARY");
      expect(saved).toContain("false");
    }));
}

class PostPassDriver extends RouteDriver {
  protected override async run(role: unknown, request: unknown): Promise<void> {
    if (role !== "case") return super.run(role, request);
    await this.send({ kind: "case-start", caseId: id });
    await this.callback(this);
  }
  async passBody(): Promise<void> {
    await this.send({ kind: "case-end", caseId: id, status: "pass", result: true });
    await this.completeDocument();
  }
  async failAfterPass(): Promise<void> {
    await this.send({ kind: "error", message: "POST_PASS_FAILURE" });
  }
}
test("already admitted fixture serializes and completes after pass and document completion; new request is refused", () =>
  withRoot(async (root) => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let calls = 0,
      closes = 0;
    const a = adapter(
      [
        {
          path: "/idle",
          get: async () => {
            calls++;
            entered.resolve();
            await release.promise;
            return { after: "pass" };
          },
        },
      ],
      async () => {
        closes++;
      },
    );
    const d = new PostPassDriver(async (driver) => {
      const pending = fetch(driver.origin + "/idle", { headers: driver.headers() });
      try {
        await entered.promise;
        expect(driver instanceof PostPassDriver).toBe(true);
        await d.passBody();
        const refused = await fetch(driver.origin + "/idle", { headers: driver.headers() });
        expect(refused.status).toBe(410);
        expect(calls).toBe(1);
        release.resolve();
        const response = await pending;
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ after: "pass" });
      } finally {
        release.resolve();
        await pending.catch(() => {});
      }
    });
    const result = await runPageSuite(a, () => d, {
      scratchRoot: root,
      resultPath: join(root, "r.json"),
      port: "ephemeral",
    });
    expect(result.exit).toBe(0);
    expect(closes).toBe(1);
    expect(result.cleanup.fixture.status).toBe("confirmed");
    expect(result.cleanup.callbacks.status).toBe("confirmed");
  }));
for (const edge of ["deadline", "interrupt", "failure", "retire"] as const) {
  test(`pending post-pass ${edge} aborts real handler, joins serialization and closes once`, () =>
    withRoot(async (root) => {
      const entered = Promise.withResolvers<void>(),
        aborted = Promise.withResolvers<void>();
      const controller = new AbortController();
      const order: string[] = [];
      let pending: Promise<Response> | undefined;
      let reason: unknown;
      const a = adapter(
        [
          {
            path: "/idle",
            get: async ({ signal, deadline }) => {
              expect(deadline).toBeGreaterThan(performance.now());
              entered.resolve();
              try {
                await new Promise<never>((_resolve, reject) => {
                  signal.addEventListener(
                    "abort",
                    () => {
                      reason = signal.reason;
                      order.push("abort");
                      aborted.resolve();
                      reject(signal.reason);
                    },
                    { once: true },
                  );
                });
              } finally {
                order.push("joined");
              }
            },
          },
        ],
        async () => {
          order.push("close");
        },
      );
      const d = new PostPassDriver(async (driver) => {
        pending = fetch(driver.origin + "/idle", { headers: driver.headers() });
        void pending.catch(() => {});
        await entered.promise;
        await d.passBody();
        order.push("pass");
        if (edge === "interrupt") controller.abort("post-pass interruption");
        if (edge === "failure") await d.failAfterPass();
        if (edge === "deadline" || edge === "interrupt") await aborted.promise;
      });
      try {
        const result = await runPageSuite(a, () => d, {
          scratchRoot: root,
          resultPath: join(root, "r.json"),
          port: "ephemeral",
          signal: controller.signal,
          budgets: {
            hello: 1000,
            heartbeat: 1000,
            case: edge === "deadline" ? 300 : 1000,
            group: 2000,
            run: 5000,
          },
        });
        await aborted.promise;
        expect(result.exit).toBe(2);
        expect(order).toEqual(["pass", "abort", "joined", "close"]);
        expect(result.cleanup.callbacks.status).toBe("confirmed");
        expect(result.cleanup.fixture.status).toBe("confirmed");
        expect(result.cleanup.server.status).toBe("confirmed");
        if (edge === "deadline") expect(reason).toBeInstanceOf(DOMException);
        if (edge === "deadline")
          expect(reason instanceof DOMException && reason.name).toBe("TimeoutError");
        if (edge !== "interrupt")
          expect(result.failures.some((failure) => failure.category === "fixture")).toBe(true);
        const status = await pending?.then(
          (response) => response.status,
          () => 0,
        );
        expect(status).not.toBe(200);
      } finally {
        controller.abort("test teardown");
        await pending?.catch(() => {});
      }
    }));
}

test("fixture run deadline retains a caller's original same-process native startedAt", () =>
  withRoot(async (root) => {
    const startedAt = performance.now() - 1000;
    const expected = startedAt + 5000;
    let observed = 0;
    const a = adapter([
      {
        path: "/idle",
        get: async ({ deadline }) => {
          observed = deadline;
          return true;
        },
      },
    ]);
    const d = new RouteDriver(async (driver) => {
      expect((await fetch(driver.origin + "/idle", { headers: driver.headers() })).status).toBe(
        200,
      );
    });
    const result = await runPageSuite(a, () => d, {
      scratchRoot: root,
      resultPath: join(root, "r.json"),
      port: "ephemeral",
      startedAt,
      budgets: { hello: 1000, heartbeat: 1000, case: 5000, group: 5000, run: 5000 },
    });
    expect(observed).toBe(expected);
    expect(result.exit).toBe(0);
  }));
