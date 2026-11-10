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
