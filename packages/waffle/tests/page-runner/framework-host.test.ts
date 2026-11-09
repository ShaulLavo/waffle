import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createFrameworkHost,
  createFrameworkControl,
  type FrameworkOptions,
} from "waffle/testing/page-runner/framework";
const options = (resultPath: string): FrameworkOptions => ({
  suite: "framework-unit",
  native: { udid: "not-launched" },
  expected: [
    {
      file: "original.ts",
      fullName: "required",
      sourceKey: "original:1",
      timeoutMs: 15000,
      retries: 0,
    },
  ],
  scope: { kind: "root-selection", command: "test:browser", files: ["original.ts"] },
  resultPath,
});
async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(
    join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "waffle-framework-unit-"),
  );
  const prior = process.env.STORAGE_SCRATCH_ROOT;
  process.env.STORAGE_SCRATCH_ROOT = root;
  try {
    await run(root);
  } finally {
    if (prior === undefined) delete process.env.STORAGE_SCRATCH_ROOT;
    else process.env.STORAGE_SCRATCH_ROOT = prior;
    await rm(root, { recursive: true, force: true });
  }
}
test("framework options and reserved mounts reject before a native session can exist", () => {
  expect(() =>
    createFrameworkHost({ ...options("/result.json"), resultPath: "relative" }),
  ).toThrow();
  const host = createFrameworkHost(options("/unused.json"));
  let mounted = 0;
  expect(() =>
    host.mount({
      stack: [{ route: "/report", handle: () => {} }],
      use() {
        mounted++;
      },
    }),
  ).toThrow("conflicts");
  const stack = {
    stack: [],
    use() {
      mounted++;
    },
  };
  host.mount(stack);
  expect(() => host.mount(stack)).toThrow("conflicts");
  expect(() => createFrameworkHost(options("/unused-other.json")).mount(stack)).toThrow(
    "conflicts",
  );
  expect(mounted).toBe(1);
});
test("an already expired creation clock calls no framework callback and allocates no scratch", () =>
  fixture(async (root) => {
    const host = createFrameworkHost(options(join(root, "result.json")));
    const now = performance.now();
    const clock = spyOn(performance, "now").mockReturnValue(now + 900001);
    let calls = 0;
    try {
      const result = await host.run(async () => {
        calls++;
        return { status: "passed" };
      });
      expect(result.exit).toBe(2);
      expect(calls).toBe(0);
      expect(result.cleanup.session.status).toBe("not-created");
      expect(await readdir(root)).toEqual(["result.json"]);
    } finally {
      clock.mockRestore();
    }
  }));
async function abortControl(root: string): Promise<void> {
  const host = createFrameworkHost(options(join(root, "result.json")));
  const started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let closes = 0;
  const running = host.run(async (registerClose) => {
    registerClose(async () => {
      closes++;
      void host.abort("synchronous close reentry");
      release.resolve();
    });
    started.resolve();
    await release.promise;
    return { status: "interrupted", errors: ["expected abort"] };
  });
  await started.promise;
  const result = await host.abort("first abort");
  expect(await running).toBe(result);
  expect(closes).toBe(1);
  expect(result.cleanup.callbacks.status).toBe("confirmed");
  expect(result.cleanup.context.status).toBe("confirmed");
  expect(result.framework?.status).toBe("interrupted");
  expect(result.cleanup.scratch.status).toBe("confirmed");
}
test("abort closes the actual context before joining its callback exactly once", () =>
  fixture(abortControl));
async function unjoinedControl(root: string): Promise<void> {
  const host = createFrameworkHost(options(join(root, "result.json")));
  const started = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    settled = Promise.withResolvers<void>();
  const running = host.run(async (registerClose) => {
    registerClose(async () => {});
    started.resolve();
    await release.promise;
    settled.resolve();
    return { status: "interrupted", errors: ["late settlement"] };
  });
  await started.promise;
  try {
    const result = await host.abort("ignored abort");
    expect(result.exit).toBe(2);
    expect(result.cleanup.callbacks.status).toBe("unconfirmed");
    expect(result.cleanup.scratch.status).toBe("unconfirmed");
    expect((await readdir(root)).some((name) => name.startsWith("waffle-framework-"))).toBe(true);
    const persisted = JSON.parse(await readFile(join(root, "result.json"), "utf8"));
    expect(persisted.cleanup.scratch.status).toBe("unconfirmed");
    expect(await running).toBe(result);
  } finally {
    release.resolve();
    await settled.promise;
  }
}
test(
  "an unjoined callback retains owned scratch without a native session",
  () => fixture(unjoinedControl),
  18000,
);

async function startupWatchdog(root: string, occupied: boolean): Promise<void> {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let closed = false,
    deletes = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      await request.text();
      if (request.method === "DELETE") deletes++;
      const value =
        path === "/session"
          ? {
              sessionId: "owned",
              capabilities: {
                browserName: "Safari",
                browserVersion: "control",
                platformName: "iOS",
                "safari:useSimulator": true,
                "safari:deviceUDID": "not-launched",
              },
            }
          : path.endsWith("/window")
            ? "owned-window"
            : null;
      return Response.json({ value });
    },
  });
  const host = createFrameworkControl(
    options(join(root, "result.json")),
    `http://127.0.0.1:${server.port}/`,
  );
  host.mount({ stack: [], use() {} });
  const running = host.run(async (registerClose) => {
    registerClose(async () => {
      closed = true;
      release.resolve();
    });
    await host.attach({
      connect: async () => ({}),
      detach: () => host.detach(),
      frames: { isTestFrame: () => false, main: async () => {}, tester: async () => {} },
    });
    if (occupied)
      await host.provider("test-frame", async () => {
        entered.resolve();
        await release.promise;
      });
    else entered.resolve();
    await release.promise;
    return { status: "interrupted", errors: ["owned watchdog control"] };
  });
  let detected = false;
  try {
    await entered.promise;
    await Bun.sleep(60);
    const clock = spyOn(performance, "now").mockReturnValue(performance.now() + 61000);
    try {
      await Bun.sleep(75);
      detected = closed;
    } finally {
      clock.mockRestore();
    }
  } finally {
    release.resolve();
    try {
      const result = await host.abort("watchdog control cleanup");
      await running;
      expect(result.cleanup.callbacks.status).toBe("confirmed");
      expect(result.cleanup.context.status).toBe("confirmed");
      expect(result.cleanup.scratch.status).toBe("confirmed");
      expect(deletes).toBe(1);
      expect(result.failures.some((failure) => failure.category === "startup")).toBe(true);
    } finally {
      await server.stop(true);
    }
  }
  expect(detected).toBe(true);
}
for (const occupied of [false, true]) {
  test(`startup watchdog enforces its bound with ${occupied ? "occupied" : "available"} queue`, () =>
    fixture((root) => startupWatchdog(root, occupied)));
}

const containedFrames = {
  isTestFrame: () => false,
  main: () => Promise.resolve(),
  tester: () => Promise.resolve(),
};
const closeNothing = () => Promise.resolve();
async function deletionDependentClose(root: string): Promise<void> {
  const entered = Promise.withResolvers<void>(),
    deleted = Promise.withResolvers<void>();
  const executionSettled = Promise.withResolvers<void>();
  let deletes = 0;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/retirement-waiter") {
      response.writeHead(409);
      response.write("Owned session ");
      entered.resolve();
      void deleted.promise.then(() => response.end("ended"));
      return;
    }
    if (request.method === "DELETE") {
      deletes++;
      deleted.resolve();
    }
    const value =
      path === "/session"
        ? {
            sessionId: "owned",
            capabilities: {
              browserName: "Safari",
              browserVersion: "control",
              platformName: "iOS",
              "safari:useSimulator": true,
              "safari:deviceUDID": "not-launched",
            },
          }
        : path.endsWith("/window")
          ? "owned-window"
          : null;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ value }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No owned HTTP listener");
  const endpoint = `http://127.0.0.1:${address.port}/`;
  const host = createFrameworkControl(options(join(root, "result.json")), endpoint);
  host.mount({ stack: [], use() {} });
  const running = host.run(async (registerClose) => {
    registerClose(() => executionSettled.promise);
    try {
      await host.attach({
        connect: async () => ({}),
        detach: () => host.detach(),
        frames: containedFrames,
      });
      const response = await fetch(`${endpoint}retirement-waiter`);
      expect(response.status).toBe(409);
      await response.text();
      return { status: "interrupted", errors: ["owned session deleted"] };
    } finally {
      executionSettled.resolve();
    }
  });
  try {
    await entered.promise;
    const result = await host.abort("observation control fault");
    expect(await running).toBe(result);
    expect(result.cleanup.context.status).toBe("confirmed");
    expect(result.cleanup.callbacks.status).toBe("confirmed");
    expect(result.cleanup.session.status).toBe("confirmed");
    expect(result.cleanup.scratch.status).toBe("confirmed");
    expect(result.fileComplete).toBe(false);
    expect(deletes).toBe(1);
  } finally {
    deleted.resolve();
    await running;
    await executionSettled.promise;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
test(
  "fault teardown deletes its session before joining execution-dependent context close",
  () => fixture(deletionDependentClose),
  30000,
);

async function commandFailureResult(root: string): Promise<void> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      Response.json(
        { value: { error: "session not created", message: "control rejection" } },
        { status: 500 },
      ),
  });
  const host = createFrameworkControl(
    options(join(root, "result.json")),
    `http://127.0.0.1:${server.port}/`,
  );
  host.mount({ stack: [], use() {} });
  try {
    const result = await host.run(async (registerClose) => {
      registerClose(closeNothing);
      await host.attach({
        connect: async () => ({}),
        detach: () => host.detach(),
        frames: containedFrames,
      });
      return { status: "passed" };
    });
    expect(result.commandFailures[0]).toMatchObject({
      client: "direct",
      phase: "attach",
      method: "POST",
      path: "/session",
      stage: "envelope",
      status: 500,
      abort: null,
    });
    expect(result.commandFailures[0]?.operation).toBeString();
    expect(JSON.stringify(result.commandFailures)).not.toContain("control rejection");
    const saved = JSON.parse(await readFile(join(root, "result.json"), "utf8"));
    expect(saved.commandFailures).toEqual(result.commandFailures);
  } finally {
    await server.stop(true);
  }
}
test("public framework results persist command failure facts", () => fixture(commandFailureResult));

async function requestBoundary(
  root: string,
  width: number,
  height: number,
  valid: boolean,
): Promise<void> {
  const host = createFrameworkHost(options(join(root, "result.json")));
  let reason: unknown;
  await host.run(async (registerClose) => {
    registerClose(closeNothing);
    reason = await host
      .provider({ kind: "viewport", width, height })
      .catch((error: unknown) => error);
    return { status: "interrupted", errors: ["request boundary only"] };
  });
  expect(reason).toBeInstanceOf(Error);
  expect(String(reason)).toContain(valid ? "not live and admitted" : "finite positive");
}
for (const [width, height, valid] of [
  [800.5, 600.5, true],
  [800, 600, true],
  [0, 600, false],
  [-1, 600, false],
  [NaN, 600, false],
  [Infinity, 600, false],
  [800, -Infinity, false],
] as const) {
  test(`viewport boundary preserves ${width} by ${height} without integer narrowing`, () =>
    fixture((root) => requestBoundary(root, width, height, valid)));
}

async function immediateFaultCancellation(root: string): Promise<void> {
  const host = createFrameworkHost(options(join(root, "result.json")));
  const release = Promise.withResolvers<void>();
  let canceled = false,
    callbackSettled = false;
  const result = await host.run(async (registerClose) => {
    registerClose(async () => {
      release.resolve();
    });
    await host
      .provider("framework-cleanup", async () => {
        const request = host.guardRequest<RequestInit>({});
        host.requestSettled({ kind: "transport-fault", detail: "Control host fault" });
        canceled = request.signal?.aborted === true;
        expect(callbackSettled).toBe(false);
        await release.promise;
        host.observeResponse({ statusCode: 200, body: { value: null } }, request);
        callbackSettled = true;
      })
      .catch(() => {});
    return { status: "interrupted", errors: ["control host fault"] };
  });
  expect(canceled).toBe(true);
  expect(callbackSettled).toBe(true);
  expect(result.cleanup.callbacks.status).toBe("confirmed");
  expect(result.cleanup.scratch.status).toBe("confirmed");
}
test("a host fault immediately cancels an owned request before its callback returns", () =>
  fixture(immediateFaultCancellation));

// check:tooling checks these overloads; the invalid calls never execute.
function providerSignatures(host: import("./framework-types.js").FrameworkHost): void {
  const viewport: Promise<void> = host.provider({ kind: "viewport", width: 800.5, height: 600 });
  const value = Object.freeze({ path: "fixture.png", buffer: new Uint8Array(0) });
  const screenshot: Promise<typeof value> = host.provider(
    { kind: "screenshot", file: "original.ts" },
    async () => value,
  );
  void viewport;
  void screenshot;
  // @ts-expect-error viewport is callback-free
  host.provider({ kind: "viewport", width: 800, height: 600 }, async () => {});
  // @ts-expect-error screenshot requires the original callback
  host.provider({ kind: "screenshot", file: "original.ts" });
  // @ts-expect-error lifecycle strings still require their callbacks
  host.provider("test-frame");
}
void providerSignatures;
