import { swiftShaderArgs } from "./gpu-browser-qualification.js";
import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { engines, BrowserRunnerLifecycle } from "./browser-runner-lifecycle.ts";
import type { BrowserResourceOwner } from "./process-recycling-browser-runner-control.ts";

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("cleanup aggregation retains all original failures and nested causes in ordinary JSON", async () => {
  const contextFailure = new Error("context failed", { cause: new Error("context cause") });
  const browserFailure = new AggregateError(
    [new Error("browser child", { cause: new Error("browser cause") })],
    "browser failed",
    { cause: { code: "TRANSPORT_CLOSED" } },
  );
  const lifecycle = new BrowserRunnerLifecycle(60000, 50, undefined, "caller");
  const ledger = lifecycle as unknown as {
    contexts: Set<BrowserResourceOwner>;
    browsers: Set<BrowserResourceOwner>;
  };
  ledger.contexts.add({
    creation: Promise.resolve({ close: () => Promise.reject(contextFailure) }),
    stopped: false,
  });
  ledger.browsers.add({
    creation: Promise.resolve({ close: () => Promise.reject(browserFailure) }),
    stopped: false,
  });
  const failure: unknown = await lifecycle.close().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError)) throw new Error("Expected cleanup aggregation");
  expect(failure.errors).toEqual([contextFailure, browserFailure]);
  expect(failure.errors[0]).toBe(contextFailure);
  expect(failure.errors[1]).toBe(browserFailure);
  expect(JSON.parse(JSON.stringify(failure))).toMatchObject({
    name: "AggregateError",
    message: "Browser runner cleanup failed",
    stack: expect.any(String),
    errors: [
      { message: "context failed", cause: { message: "context cause" } },
      {
        message: "browser failed",
        cause: { code: "TRANSPORT_CLOSED" },
        errors: [{ message: "browser child", cause: { message: "browser cause" } }],
      },
    ],
  });
});
for (const phase of ["creation", "closure"] as const)
  test(`persistent ${phase} timeout cannot erase independent ownership`, async () => {
    const root = await mkdtemp(resolve(tmpdir(), "vfs-owner-"));
    const profile = resolve(root, "profile");
    await mkdir(profile);
    const lifecycle = new BrowserRunnerLifecycle(60000, 5);
    // Deliberately fault-inject the ownership ledger, with no actual browser or
    // enclosing Browser. An initially empty browser set is not shutdown evidence.
    const ledger = lifecycle as unknown as {
      contexts: Set<BrowserResourceOwner>;
      directories: Set<Promise<string>>;
    };
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const resource = {
      close: () => (phase === "closure" ? gate : Promise.resolve()),
      browser: () => null,
    };
    const creation = phase === "creation" ? gate.then(() => resource) : Promise.resolve(resource);
    const owner: BrowserResourceOwner = { creation, stopped: false };
    ledger.contexts.add(owner);
    ledger.directories.add(Promise.resolve(profile));
    try {
      await expect(lifecycle.close()).rejects.toThrow("cleanup failed");
      expect(ledger.contexts.has(owner)).toBe(true);
      expect((await stat(profile)).isDirectory()).toBe(true);
    } finally {
      finish();
      await creation;
      await gate;
      // Late closure is still attached to the original owner, not abandoned.
      await nextTurn();
      expect(owner.stopped).toBe(true);
      await rm(root, { recursive: true, force: true });
    }
  });

test("ordinary browser closure failure is not a controller interruption", async () => {
  const lifecycle = new BrowserRunnerLifecycle(60000, 5);
  const context = {
    close: () => Promise.reject(new Error("Target page, context or browser has been closed")),
    browser: () => null,
  };
  const owner = { creation: Promise.resolve(context), stopped: false };
  (lifecycle as unknown as { contexts: Set<BrowserResourceOwner> }).contexts.add(owner);
  await expect(
    lifecycle.closeContext(context as unknown as Parameters<typeof lifecycle.closeContext>[0]),
  ).rejects.toThrow("has been closed");
  expect(lifecycle.controllerInterrupted).toBe(false);
  await expect(lifecycle.close()).rejects.toThrow("cleanup failed");
});

test("controller deadline marks interruption before closing owned resources", () => {
  const script = `import { BrowserRunnerLifecycle } from ${JSON.stringify(resolve(import.meta.dir, "browser-runner-lifecycle.ts"))};
    const lifecycle = new BrowserRunnerLifecycle(5);
    (lifecycle as unknown as { contexts: Set<unknown> }).contexts.add({ creation: Promise.resolve({ close: async () => console.log("controller-interrupted=" + lifecycle.controllerInterrupted) }), stopped: false });`;
  const result = Bun.spawnSync([process.execPath, "--eval", script], { timeout: 5000 });
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toContain("controller-interrupted=true");
  expect(result.stderr.toString()).toContain("Browser runner timed out");
});

for (const engine of ["chromium", "firefox", "webkit"] as const) {
  for (const args of [undefined, swiftShaderArgs] as const) {
    test(`persistent ${engine} preserves profile and owned paths with ${args ? "explicit" : "default"} args`, async () => {
      const lifecycle = new BrowserRunnerLifecycle();
      lifecycle.scratch = "/work/tmp/gpu-async-launch";
      const launch = spyOn(engines[engine], "launchPersistentContext").mockRejectedValue(
        new Error("launch boundary"),
      );
      try {
        await expect(lifecycle.persistent(engine, "/work/tmp/exact-profile", args)).rejects.toThrow(
          "launch boundary",
        );
        const options = {
          headless: true,
          downloadsPath: lifecycle.scratch,
          tracesDir: lifecycle.scratch,
        };
        expect(launch.mock.calls[0]).toEqual([
          "/work/tmp/exact-profile",
          args === undefined ? options : { ...options, args: Array.from(args) },
        ]);
        if (args) expect(launch.mock.calls[0]?.[1]?.args).not.toBe(args);
      } finally {
        await lifecycle.close();
        launch.mockRestore();
      }
    });
  }
}

test("embedded ownership leaves signal listeners and both process fences to the caller", async () => {
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const timer = spyOn(globalThis, "setTimeout");
  const lifecycle = new BrowserRunnerLifecycle(600_000, 5000, undefined, "caller");
  try {
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
    await lifecycle.close();
    expect(timer.mock.calls.filter((call) => call[1] === 600_000 || call[1] === 60_000)).toEqual(
      [],
    );
  } finally {
    await lifecycle.close();
    timer.mockRestore();
  }
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
});

test("standalone lifecycle retains its default execution and cleanup fences", async () => {
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  const timer = spyOn(globalThis, "setTimeout");
  const lifecycle = new BrowserRunnerLifecycle();
  try {
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(
      before.map((count) => count + 1),
    );
    await lifecycle.close();
    expect(timer.mock.calls.filter((call) => call[1] === 600_000)).toHaveLength(1);
    expect(timer.mock.calls.filter((call) => call[1] === 60_000)).toHaveLength(1);
  } finally {
    await lifecycle.close();
    timer.mockRestore();
  }
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
});

test("embedded browser launch disables Playwright's own process signal handlers", async () => {
  const lifecycle = new BrowserRunnerLifecycle(600_000, 5000, undefined, "caller");
  const launch = spyOn(engines.chromium, "launchPersistentContext").mockRejectedValue(
    new Error("launch boundary"),
  );
  try {
    await expect(lifecycle.persistent("chromium", "/unused/profile")).rejects.toThrow(
      "launch boundary",
    );
    expect(launch.mock.calls[0]?.[1]).toMatchObject({
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
    });
  } finally {
    await lifecycle.close();
    launch.mockRestore();
  }
});
