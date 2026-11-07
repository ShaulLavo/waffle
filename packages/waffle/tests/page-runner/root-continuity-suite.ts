import { resolve } from "node:path";
import { browserBundle } from "../browser-runner-lifecycle.js";
import { rootContinuityControls, type RootContinuityRequest } from "../root-continuity-command.js";
import { record, strings } from "./protocol.js";
import type { SuiteAdapter } from "./suite-host.js";

export const rootContinuityIds = rootContinuityControls.map(
  (control) => `root-continuity: ${control}`,
);
function checkRootContinuityResult(id: string, value: unknown): void {
  if (!record(value)) throw new Error("Missing root continuity evidence");
  if (id === rootContinuityIds[0]) {
    if (
      typeof value.history !== "string" ||
      !value.history ||
      !Number.isSafeInteger(value.session) ||
      !Number.isSafeInteger(value.frontier) ||
      value.activations !== 1 ||
      typeof value.durabilityMs !== "number" ||
      !Number.isFinite(value.durabilityMs) ||
      value.durabilityMs < 0 ||
      !record(value.receiptCounts) ||
      !Number.isSafeInteger(value.receiptCounts.recovered) ||
      typeof value.receiptCounts.recovered !== "number" ||
      value.receiptCounts.recovered < 0 ||
      value.receiptCounts.settled !== value.receiptCounts.recovered + 1 ||
      !record(value.ledger) ||
      typeof value.ledger.allocated !== "number" ||
      value.ledger.allocated <= 0 ||
      value.ledger.obligations !== 0 ||
      typeof value.ledger.changed !== "string" ||
      !/^\d+$/.test(value.ledger.changed)
    )
      throw new Error("Missing selected root evidence");
    return;
  }
  const control = rootContinuityControls.find((name) => `root-continuity: ${name}` === id);
  if (
    !control ||
    value.mode !== control ||
    value.activations !== 0 ||
    value.readyPublished !== false ||
    typeof value.retainedBytes !== "number" ||
    value.retainedBytes <= 0 ||
    value.stopped !== true
  )
    throw new Error("Missing startup fence evidence");
}

export const rootContinuityAdapter: SuiteAdapter<RootContinuityRequest> = {
  suite: "root-continuity",
  inventory: () =>
    rootContinuityControls.map((control, index) => ({
      id: rootContinuityIds[index]!,
      label: control,
      request: (run) => ({ run, control }),
    })),
  policy: {
    requireResult: true,
    listIds(value) {
      if (
        !record(value) ||
        Object.keys(value).length !== 1 ||
        !strings(value.ids) ||
        value.ids.length !== rootContinuityIds.length ||
        value.ids.some((id, index) => id !== rootContinuityIds[index])
      )
        throw new Error("Wrong complete root continuity inventory or order");
      return value.ids;
    },
    allocation(entry, running, run) {
      const control = rootContinuityControls.find(
        (name) => running[0] === `root-continuity: ${name}`,
      );
      if (
        running.length !== 1 ||
        !control ||
        entry.kind !== "indexeddb" ||
        entry.name !== `root-continuity-${control}-${run}`
      )
        throw new Error("Allocation is not the exact running root continuity database");
    },
    check: checkRootContinuityResult,
  },
  async assets({ signal }) {
    signal.throwIfAborted();
    const page = await browserBundle(resolve(import.meta.dir, "root-continuity-page.ts"));
    signal.throwIfAborted();
    const composition = await browserBundle(
      resolve(import.meta.dir, "../root-continuity-browser.ts"),
    );
    signal.throwIfAborted();
    return { "/page.js": page, "/composition.js": composition };
  },
  budgets: () => ({
    hello: 20_000,
    heartbeat: 10_000,
    case: 150_000,
    group: 150_000,
    run: 150_000,
  }),
};
