import { expect, spyOn, test } from "bun:test";
import { BrowserRunnerLifecycle } from "../browser-runner-lifecycle.js";
import { BrowserObservation, requestEvent } from "./browser-observation.js";
import { HostConsumers } from "./owned-consumers.js";
import { PlaywrightDriver } from "./playwright-driver.js";
import { SafariDriver } from "./safari-driver.js";

async function failedObservation(reason: unknown): Promise<BrowserObservation> {
  const ledger = new BrowserObservation("page", new HostConsumers(), async () => {});
  ledger.onRequest(() => Promise.reject(reason));
  ledger.requested(
    requestEvent(
      "Network.requestWillBeSent",
      {
        timestamp: 1,
        requestId: "request",
        frameId: "frame",
        loaderId: "loader",
        request: { url: "https://owned.test/request" },
      },
      1,
    ),
  );
  await ledger.failure;
  return ledger;
}

for (const reason of [undefined, null, false, 0, ""]) {
  test(`local cleanup retains falsy callback rejection ${String(reason)} and contains the browser`, async () => {
    const ledger = await failedObservation(reason);
    const driver = new PlaywrightDriver("chromium", "/unused/no-browser");
    const close = spyOn(BrowserRunnerLifecycle.prototype, "close").mockResolvedValue();
    Reflect.set(driver, "browserObservation", ledger);
    try {
      const result = await driver.stop();
      expect(close).toHaveBeenCalledTimes(1);
      expect(result.session.status).toBe("unconfirmed");
      expect(result.launcher.status).toBe("unconfirmed");
      expect(driver.stop()).toBe(driver.stop());
    } finally {
      await driver.stop();
      close.mockRestore();
    }
  });

  test(`Safari cleanup retains falsy callback rejection ${String(reason)} and deletes its session`, async () => {
    const ledger = await failedObservation(reason);
    const driver = new SafariDriver("10128D70-92A7-4626-9CE5-1537CF27BE84", "/unused/no-native");
    const commands: string[] = [];
    Reflect.set(driver, "observation", ledger);
    Reflect.set(driver, "session", "cpu-owned-session");
    Reflect.set(driver, "request", async (method: string, path: string) => {
      commands.push(`${method} ${path}`);
      return null;
    });
    const result = await driver.stop();
    expect(commands).toEqual(["DELETE /session/cpu-owned-session"]);
    expect(result.session.status).toBe("unconfirmed");
    expect(result.session.detail).toContain("Inspector observation cleanup unconfirmed:");
    expect(result.launcher.status).toBe("not-created");
    expect(driver.stop()).toBe(driver.stop());
  });
}
