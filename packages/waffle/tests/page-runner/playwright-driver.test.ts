import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeResult } from "./result-file.js";
import { swiftShaderArgs } from "../gpu-browser-qualification.js";
import { expect, spyOn, test } from "bun:test";
import { BrowserRunnerLifecycle } from "../browser-runner-lifecycle.js";
import { PlaywrightDriver } from "./playwright-driver.js";

test("browser temporary roots are siblings of host scratch under a CI supervisor", async () => {
  const root = "/home/runner/work/_temp/wb-123456";
  let requested: string | undefined;
  const init = spyOn(BrowserRunnerLifecycle.prototype, "init").mockImplementation(async (value) => {
    requested = value;
    throw new Error("Stopped at the owned allocation boundary");
  });
  const driver = new PlaywrightDriver("chromium", `${root}/w-pr-123456`);
  try {
    await expect(driver.start(AbortSignal.timeout(1000))).rejects.toThrow("allocation boundary");
    expect(requested).toBe(root);
  } finally {
    await driver.stop();
    init.mockRestore();
  }
});

for (const args of [undefined, swiftShaderArgs] as const) {
  test(`local driver forwards readonly launch args ${args ? "when supplied" : "only when supplied"}`, async () => {
    const root = "/work/tmp/gpu-async-driver";
    const init = spyOn(BrowserRunnerLifecycle.prototype, "init").mockImplementation(async function (
      this: BrowserRunnerLifecycle,
    ) {
      this.scratch = root;
    });
    const directory = spyOn(BrowserRunnerLifecycle.prototype, "directory").mockResolvedValue(
      `${root}/p-profile`,
    );
    const persistent = spyOn(BrowserRunnerLifecycle.prototype, "persistent").mockRejectedValue(
      new Error("launch boundary"),
    );
    const driver = new PlaywrightDriver("chromium", `${root}/host`, args);
    try {
      await expect(driver.start(AbortSignal.timeout(1000))).rejects.toThrow("launch boundary");
      expect(persistent.mock.calls[0]).toEqual(
        args === undefined
          ? ["chromium", `${root}/p-profile`]
          : ["chromium", `${root}/p-profile`, args],
      );
    } finally {
      await driver.stop();
      persistent.mockRestore();
      directory.mockRestore();
      init.mockRestore();
    }
  });
}

test("GPU controls retain the exact stock SwiftShader flags and order", () => {
  expect(swiftShaderArgs).toEqual([
    "--enable-unsafe-webgpu",
    "--enable-features=Vulkan",
    "--use-vulkan=swiftshader",
    "--use-webgpu-adapter=swiftshader",
    "--use-angle=swiftshader",
    "--disable-vulkan-surface",
  ]);
});

test("embedded driver construction and repeated stop never acquire process interruption", async () => {
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  for (let index = 0; index < 5; index++) {
    const driver = new PlaywrightDriver("chromium", "/unused/host");
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
    await driver.stop();
    await driver.stop();
  }
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
});

for (const outcome of ["fulfill", "reject"] as const) {
  test(`raw evaluation survives its bounded timeout and context close until late ${outcome}`, async () => {
    const raw = Promise.withResolvers<unknown>();
    const driver = new PlaywrightDriver("chromium", "/unused/key-control");
    let evaluations = 0;
    Reflect.set(driver, "page", {
      evaluate() {
        evaluations++;
        return raw.promise;
      },
    });
    const close = spyOn(BrowserRunnerLifecycle.prototype, "close").mockResolvedValue();
    let stopped = false;
    try {
      await expect(
        driver.script("return true;", new AbortController().signal),
      ).rejects.toMatchObject({ name: "WebDriverError", code: "script timeout" });
      expect(driver.uncertain).toBe(true);
      const stopping = driver.stop();
      void stopping.then(() => {
        stopped = true;
      });
      await Bun.sleep(10);
      expect(close).toHaveBeenCalledTimes(1);
      expect(stopped).toBe(false);
      if (outcome === "fulfill") raw.resolve(true);
      else raw.reject(new Error("late raw rejection"));
      expect((await stopping).session.status).toBe("confirmed");
      expect(stopped).toBe(true);
      expect(evaluations).toBe(1);
      expect(driver.stop()).toBe(stopping);
    } finally {
      raw.resolve(null);
      await driver.stop();
      close.mockRestore();
    }
  }, 8000);
}

test("observer failure does not skip the existing browser owner's containment", async () => {
  const driver = new PlaywrightDriver("chromium", "/unused/observer-control");
  const closed = spyOn(BrowserRunnerLifecycle.prototype, "close").mockResolvedValue();
  Reflect.set(
    driver,
    "observations",
    new Map([
      [
        "owned",
        {
          stop: () => Promise.reject(new Error("observer lost")),
        },
      ],
    ]),
  );
  try {
    const result = await driver.stop();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(result.session.status).toBe("unconfirmed");
    expect(result.session.detail).toContain("observer lost");
  } finally {
    await driver.stop();
    closed.mockRestore();
  }
});

test("driver cleanup and final result file preserve every nested close error", async () => {
  const root = await mkdtemp(join(tmpdir(), "waffle-error-json-"));
  const leaf = new Error("Firefox transport closed");
  const child = new Error("context close failed", { cause: leaf });
  const nested = new AggregateError([child], "nested close", { cause: new Error("nested cause") });
  const failure = new AggregateError([nested, new Error("browser close failed")], "cleanup failed");
  const close = spyOn(BrowserRunnerLifecycle.prototype, "close").mockRejectedValue(failure);
  try {
    const driver = new PlaywrightDriver("firefox", root);
    const cleanup = await driver.stop();
    expect(cleanup.session.status).toBe("unconfirmed");
    expect(cleanup.launcher).toEqual(cleanup.session);
    expect(close).toHaveBeenCalledTimes(1);
    const tree: unknown = JSON.parse(cleanup.session.detail.split("; browser root ")[0]!);
    expect(tree).toMatchObject({
      errors: [
        {
          message: "nested close",
          cause: { message: "nested cause" },
          errors: [
            {
              message: child.message,
              stack: child.stack,
              cause: {
                name: leaf.name,
                message: leaf.message,
                stack: leaf.stack,
              },
            },
          ],
        },
        { message: "browser close failed" },
      ],
    });
    const path = join(root, "result.json");
    await writeResult(path, { cleanup, failure });
    expect(await Bun.file(path).json()).toEqual({ cleanup, failure: tree });
    expect(await readdir(root)).toEqual(["result.json"]);
  } finally {
    close.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["confirmed", "failed"])(
  "every observation failure survives the final JSON when lifecycle closure is %s",
  async (outcome) => {
    const root = await mkdtemp(join(tmpdir(), "waffle-error-json-"));
    const first = new Error("first observer", { cause: new Error("first cause") });
    const second = new AggregateError(
      [new Error("second child", { cause: new Error("second cause") })],
      "second observer",
    );
    const lifecycle = new AggregateError(
      [new Error("context close", { cause: new Error("transport close") })],
      "lifecycle failed",
      { cause: new Error("lifecycle cause") },
    );
    const close = spyOn(BrowserRunnerLifecycle.prototype, "close").mockImplementation(() =>
      outcome === "failed" ? Promise.reject(lifecycle) : Promise.resolve(),
    );
    const driver = new PlaywrightDriver("firefox", root);
    const stopped: string[] = [];
    const observations = new Map<string, { stop(): Promise<void> }>([
      [
        "first",
        {
          stop: () => {
            stopped.push("first");
            return Promise.reject(first);
          },
        },
      ],
      [
        "second",
        {
          stop: () => {
            stopped.push("second");
            return Promise.reject(second);
          },
        },
      ],
      [
        "successful",
        {
          stop: () => {
            stopped.push("successful");
            return Promise.resolve();
          },
        },
      ],
    ]);
    Reflect.set(driver, "observations", observations);
    try {
      const stopping = driver.stop();
      expect(driver.stop()).toBe(stopping);
      const cleanup = await stopping;
      expect(stopped).toEqual(["first", "second", "successful"]);
      expect(close).toHaveBeenCalledTimes(1);
      expect(cleanup.session.status).toBe("unconfirmed");
      expect(cleanup.launcher).toEqual(cleanup.session);
      const errors: unknown[] = [
        { message: "first observer", cause: { message: "first cause" } },
        {
          message: "second observer",
          errors: [{ message: "second child", cause: { message: "second cause" } }],
        },
      ];
      if (outcome === "failed")
        errors.push({
          message: "lifecycle failed",
          cause: { message: "lifecycle cause" },
          errors: [{ message: "context close", cause: { message: "transport close" } }],
        });
      const tree: unknown = JSON.parse(cleanup.session.detail.split("; browser root ")[0]!);
      expect(tree).toMatchObject({ name: "AggregateError", errors });
      const path = join(root, "result.json");
      // Match suite-host's final structured clone before writing the JSON result.
      await writeResult(path, structuredClone({ cleanup }));
      expect(await Bun.file(path).json()).toEqual({ cleanup });
    } finally {
      close.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
);
