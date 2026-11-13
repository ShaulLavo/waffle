import { expect, test } from "bun:test";
import { BrowserObservation } from "./browser-observation.js";
import { HostConsumers } from "./owned-consumers.js";
import { PlaywrightDriver } from "./playwright-driver.js";
import { SafariDriver } from "./safari-driver.js";
import { record } from "./protocol.js";

async function wrapper(engine: "safari" | "playwright", consoleDeclared: boolean): Promise<void> {
  const consumers = new HostConsumers();
  let stops = 0;
  const ledger = new BrowserObservation("owned", consumers, async () => {
    stops++;
  });
  const driver =
    engine === "safari"
      ? new SafariDriver("cpu-device", "unused-no-native-start")
      : new PlaywrightDriver("chromium", "unused-no-browser-start");
  const binding = {
    window: "owned-window",
    bootstrapURL: "https://owned.test/bootstrap?token=owned",
    expectedURL: "https://owned.test/case",
    signal: new AbortController().signal,
    consumers,
    console: consoleDeclared,
  };
  const observations: unknown = Reflect.get(driver, "observations");
  const windows: unknown = Reflect.get(driver, "observedWindows");
  if (!(observations instanceof Map) || !(windows instanceof Map))
    throw Error("Missing actual owner maps");
  observations.set(binding.expectedURL, ledger);
  windows.set(binding.window, binding.expectedURL);
  let closed: Promise<unknown> | undefined;
  try {
    const factory: unknown = Reflect.get(driver, "ownObservation");
    if (typeof factory !== "function") throw Error("Missing actual owned-wrapper factory");
    const owned: unknown = Reflect.apply(factory, driver, [ledger, binding]);
    if (!record(owned)) throw Error("Invalid owned wrapper");
    const {
      diagnosticSnapshot,
      workerOrdinal,
      waitForWorkerClose,
      beginDocumentClose,
      documentRetirement,
      stop,
    } = owned;
    if (
      typeof diagnosticSnapshot !== "function" ||
      typeof workerOrdinal !== "function" ||
      typeof waitForWorkerClose !== "function" ||
      typeof beginDocumentClose !== "function" ||
      typeof documentRetirement !== "function" ||
      typeof stop !== "function"
    )
      throw Error("Owned wrapper dropped observation methods");
    expect(Object.hasOwn(owned, "console")).toBe(consoleDeclared);
    ledger.created("worker", "https://owned.test/resident-guest.js");
    const worker = ledger.workers()[0];
    if (!worker) throw Error("Missing actual worker");
    closed = Promise.resolve(waitForWorkerClose(worker));
    void closed.catch(() => {});
    expect(workerOrdinal(worker)).toBe(1);
    expect(workerOrdinal(worker.url)).toBe(1);
    expect(diagnosticSnapshot()).toMatchObject({ workers: { active: [{ facts: { worker: 1 } }] } });
    ledger.initialized("worker", true);
    ledger.terminated(
      "worker",
      engine === "safari" ? "safari-worker-terminated" : "playwright-worker-close",
    );
    await closed;
    expect(workerOrdinal(worker)).toBe(1);
    expect(diagnosticSnapshot()).toMatchObject({
      workers: { unavailable: 0, active: [], completed: [{ facts: { worker: 1 } }] },
    });
    expect(Object.hasOwn(owned, "documentClosed")).toBe(false);
    beginDocumentClose();
    ledger.documentClosed("playwright-page-close");
    expect(await documentRetirement()).toBe(await ledger.documentRetirement());
    const retirement: unknown = stop();
    expect(stop()).toBe(retirement);
    await retirement;
    expect(stops).toBe(1);
    expect(observations.size).toBe(0);
    expect(windows.size).toBe(0);
  } finally {
    await ledger.stop();
    await closed?.catch(() => {});
    expect(await consumers.join(100)).toBe(true);
  }
}
for (const engine of ["safari", "playwright"] as const)
  for (const consoleDeclared of [false, true])
    test(`${engine} actual owned wrapper retains diagnostics and worker identity with Console ${consoleDeclared}`, () =>
      wrapper(engine, consoleDeclared));
