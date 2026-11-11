import type { Frame, Page, Request, Worker } from "playwright";
import type { DriverObservationBinding, DriverObservation } from "./driver.js";
import { BrowserObservation, type RequestObservation } from "./browser-observation.js";

/** The existing Page remains the sole application executor. No second browser connection. */
export function observePlaywrightPage(
  page: Page,
  binding: DriverObservationBinding,
): DriverObservation {
  let next = 0;
  let sequence = 0;
  const ids = new WeakMap<Worker, string>();
  const closers = new Map<Worker, () => void>();
  const closed = (worker: Worker) => () => {
    closers.delete(worker);
    try {
      ledger.terminated(identity(worker), "playwright-worker-close");
    } catch (error) {
      ledger.lose(error);
    }
  };
  const identity = (worker: Worker) => {
    const found = ids.get(worker);
    if (found) return found;
    const id = String(++next);
    ids.set(worker, id);
    return id;
  };
  const workerCreated = (worker: Worker) => {
    if (closers.has(worker)) return;
    try {
      const listener = closed(worker);
      closers.set(worker, listener);
      worker.once("close", listener);
      ledger.created(identity(worker), worker.url());
    } catch (error) {
      ledger.lose(error);
    }
  };
  const request = (request: Request) => {
    const event: RequestObservation = {
      sequence: ++sequence,
      kind: "request",
      requestId: String(sequence),
      frameId: "existing-page",
      loaderId: "existing-page",
      timestamp: performance.now(),
      url: request.url(),
      details: {},
    };
    try {
      ledger.requested(event);
    } catch (error) {
      ledger.lose(error);
    }
  };
  let navigated = false;
  const navigation = (frame: Frame) => {
    if (frame !== page.mainFrame()) return;
    if (!navigated && frame.url() === binding.expectedURL) {
      navigated = true;
      return;
    }
    if (ledger.closing && frame.url() === ledger.closingNavigationURL)
      return ledger.documentClosed();
    ledger.lose(new Error("Observed Playwright document generation changed"));
  };
  const lost = () => ledger.documentClosed();
  const crashed = () => ledger.lose(new Error("Observed Playwright page crashed"));
  const abort = () => ledger.lose(new Error("Observation admission aborted"));
  const ledger = new BrowserObservation("existing-playwright-page", binding.consumers, async () => {
    page.off("framenavigated", navigation);
    page.off("worker", workerCreated);
    page.off("request", request);
    page.off("close", lost);
    page.off("crash", crashed);
    binding.signal.removeEventListener("abort", abort);
    for (const [worker, listener] of closers) worker.off("close", listener);
    closers.clear();
  });
  page.on("framenavigated", navigation);
  page.on("worker", workerCreated);
  page.on("request", request);
  page.on("close", lost);
  page.on("crash", crashed);
  binding.signal.addEventListener("abort", abort, { once: true });
  for (const worker of page.workers()) workerCreated(worker);
  binding.signal.throwIfAborted();
  return ledger;
}
