import { resolve } from "node:path";
import type { SuiteAdapter } from "waffle/testing/page-runner";
import { runtimeNativeSources, runtimeFixture } from "../threads-runtime-safari-packet.js";
import {
  runtimeThreadCases,
  stockThreadCase,
  type RuntimeThreadCase,
} from "../threads-runtime-cases.js";
import { record, strings } from "./protocol.js";

export type ThreadRuntimeRequest = { selected: RuntimeThreadCase; fixtureSha256: string };
export const threadRuntimeId = (selected: RuntimeThreadCase): string =>
  `threads-runtime: ${selected}`;
const ids = runtimeThreadCases.map(threadRuntimeId);

function checkCaseIdentity(
  value: unknown,
  selected: RuntimeThreadCase,
): asserts value is Record<string, unknown> {
  if (
    !record(value) ||
    value.selected !== selected ||
    value.isolated !== true ||
    !record(value.document) ||
    typeof value.document.url !== "string" ||
    typeof value.document.timeOrigin !== "number" ||
    !Number.isFinite(value.document.timeOrigin) ||
    value.document.timeOrigin <= 0 ||
    !record(value.siblingExit) ||
    value.siblingExit.kind !== "exited" ||
    value.siblingExit.code !== 0 ||
    typeof value.workers !== "number" ||
    value.workers < 4 ||
    value.stopped !== value.workers
  )
    throw new Error("Incomplete Runtime case, document, isolation or Worker cleanup");
}

export function checkThreadRuntimeResult(
  selected: RuntimeThreadCase,
  fixtureSha256: string,
  value: unknown,
): void {
  checkCaseIdentity(value, selected);
  if (!record(value.exit)) throw new Error("Missing Runtime outcome");
  const killed = ["kill-start", "cpu", "wait32", "wait64"].includes(selected);
  if (
    killed
      ? value.exit.kind !== "signaled" || value.exit.code !== 9 || value.fenceBlocked !== true
      : value.exit.kind !== "exited" || value.exit.code !== 0
  )
    throw new Error("Wrong Runtime outcome or filesystem fence");
  const stock = stockThreadCase(selected);
  const expectedOutput = stock
    ? `threads-ok mode=${selected} main-static=1369948382 main-tls=901\n`
    : selected === "join"
      ? "c"
      : "";
  if (value.output !== expectedOutput || (stock && value.fixtureSha256 !== fixtureSha256))
    throw new Error("Wrong Runtime output or verified producer artifact");
  if (!Array.isArray(value.sharedGuests) || value.sharedGuests.length !== 1)
    throw new Error("Expected one retired process backing");
  checkBacking(value.sharedGuests[0], stock);
  if (
    stock &&
    (!record(value.backingObservation) ||
      typeof value.backingObservation.peakAliases !== "number" ||
      value.backingObservation.peakAliases < 3)
  )
    throw new Error("Missing concurrent stock backing aliases");
  if (
    !Array.isArray(value.controlDebts) ||
    !value.controlDebts.every(
      (debt) => typeof debt === "number" && Number.isSafeInteger(debt) && debt >= 0,
    ) ||
    value.controlDebts.reduce((total, debt) => total + debt, 0) !== value.debtBytes
  )
    throw new Error("Runtime debt must be separate consumed controls");
}

function checkBacking(value: unknown, stock: boolean): void {
  if (
    !record(value) ||
    value.phase !== "awaiting-collection" ||
    value.fence !== "passed" ||
    value.chargedBytes !== 33554432 ||
    value.actualMaximumPages !== 512 ||
    (stock && (value.initialPages !== 17 || value.sourceMaximumPages !== 16384)) ||
    !record(value.aliases) ||
    value.aliases.reserved !== 0 ||
    value.aliases.transferred !== 0 ||
    value.aliases.retained !== 0 ||
    !record(value.continuations) ||
    value.continuations.active !== 0 ||
    value.continuations.retained !== 0
  )
    throw new Error("Runtime backing declaration or aggregate retirement changed");
}

export function threadsRuntimeAdapter(
  directory: string,
  prepared?: { fixtureSha256: string; assets: Record<string, Blob | string> },
): SuiteAdapter<ThreadRuntimeRequest> {
  let fixtureSha256 = prepared?.fixtureSha256 ?? "";
  const documents = new Set<string>();
  const timeOrigins = new Set<unknown>();
  return {
    suite: "threads-runtime",
    inventory: () =>
      runtimeThreadCases.map((selected) => ({
        id: threadRuntimeId(selected),
        label: selected,
        request: () => ({ selected, fixtureSha256 }),
      })),
    policy: {
      requireResult: true,
      listIds(value) {
        if (
          !record(value) ||
          !strings(value.ids) ||
          value.ids.length !== ids.length ||
          value.ids.some((id, index) => id !== ids[index])
        )
          throw new Error("Wrong complete Runtime thread inventory or order");
        return value.ids;
      },
      check(id, value) {
        const selected = runtimeThreadCases.find((selected) => threadRuntimeId(selected) === id);
        if (!selected) throw new Error("Unknown Runtime thread result");
        checkThreadRuntimeResult(selected, fixtureSha256, value);
        if (!record(value) || !record(value.document)) throw new Error("Missing thread document");
        const identity = String(value.document.url);
        if (documents.has(identity) || timeOrigins.has(value.document.timeOrigin))
          throw new Error("Runtime thread document reused");
        documents.add(identity);
        timeOrigins.add(value.document.timeOrigin);
      },
    },
    async assets({ signal }) {
      signal.throwIfAborted();
      if (prepared) return prepared.assets;
      const fixture = await runtimeFixture(directory);
      fixtureSha256 = fixture.fixtureSha256;
      const assets: Record<string, Blob | string> = { "/threads.wasm": new Blob([fixture.wasm]) };
      for (const [route, source] of Object.entries(runtimeNativeSources)) {
        signal.throwIfAborted();
        const built = await Bun.build({ entrypoints: [resolve(source)], target: "browser" });
        if (!built.success || !built.outputs[0])
          throw new AggregateError(built.logs, `Thread bundle ${source}`);
        assets[route] = built.outputs[0];
      }
      return assets;
    },
    budgets: () => ({
      hello: 20_000,
      heartbeat: 10_000,
      case: 120_000,
      group: 120_000,
      run: 600_000,
    }),
  };
}
