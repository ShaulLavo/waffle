import { resolve } from "node:path";
import { safeStagingLabels } from "../safe-staging-browser.js";
import { browserBundle } from "../browser-runner-lifecycle.js";
import { stagingPrefixes } from "./safe-staging-allocation.js";
import { record, strings } from "./protocol.js";
import type { CollectorPolicy } from "./collector.js";
import type { SuiteAdapter } from "./suite-host.js";

export type SafeStagingRequest = { run: string; selected?: string };
export const safeStagingId = "safe-staging: safeStagingNative";
function sameLabels(actual: unknown, expected: readonly string[]): boolean {
  return (
    strings(actual) &&
    actual.length === expected.length &&
    actual.every((label, index) => label === expected[index])
  );
}
export function safeStagingAdapter(selected?: string): SuiteAdapter<SafeStagingRequest> {
  const labels = safeStagingLabels();
  if (selected !== undefined && !labels.includes(selected))
    throw new Error(`Unknown staged control ${selected}`);
  const policy: CollectorPolicy = {
    requireResult: true,
    listIds(value) {
      if (!record(value) || Object.keys(value).length !== 1 || !sameLabels(value.labels, labels))
        throw new Error("Wrong complete staging inventory or order");
      return [safeStagingId];
    },
    check(_id, result) {
      if (!sameLabels(result, selected === undefined ? labels : [selected]))
        throw new Error("Wrong completed staging labels or order");
    },
    allocation(entry, running, run) {
      if (running.length !== 1 || running[0] !== safeStagingId || entry.kind !== "indexeddb")
        throw new Error("Staging allocation outside its running command");
      const prefix = stagingPrefixes.find((value) => entry.name.startsWith(`${value}-${run}-`));
      const suffix = prefix && entry.name.slice(`${prefix}-${run}-`.length);
      if (
        !suffix ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(suffix)
      )
        throw new Error("Staging allocation is not an exact run-owned database");
    },
  };
  return {
    suite: "safe-staging",
    inventory: () => [
      {
        id: safeStagingId,
        label: "safeStagingNative",
        request: (run) => ({ run, selected }),
      },
    ],
    policy,
    async assets({ signal }) {
      signal.throwIfAborted();
      const page = await browserBundle(resolve(import.meta.dir, "safe-staging-page.ts"));
      signal.throwIfAborted();
      return { "/page.js": page };
    },
    // The original runner owns one 180-second command, not 180 seconds per label.
    budgets: () => ({
      hello: 20_000,
      heartbeat: 10_000,
      case: 180_000,
      group: 180_000,
      run: 180_000,
    }),
  };
}
