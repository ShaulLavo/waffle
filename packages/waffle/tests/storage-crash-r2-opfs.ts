import { OpfsStorage } from "../fs/opfs.js";
import { identityOpfsFixture } from "./fixtures/durable-identity-opfs.js";
import {
  type FaultScheduler,
  type FaultSchedule,
  runFaultSchedules,
  withCellCleanup,
  causedBy,
} from "./storage-crash-r2-scheduler.js";
import {
  checkReopen,
  closeCells,
  modeDelta,
  equal,
  invariant,
  opened,
  recoveredState,
  replaceAndRename,
  seedChange,
} from "./storage-crash-r2-state.js";

interface Cell {
  id: string;
  schedule: FaultSchedule | null;
  outcome: "old-complete" | "new-complete";
  flush: "rejected" | "fulfilled";
}
function fault(
  operation: string,
  target: string,
  occurrence: number,
  outcome: Cell["outcome"],
  flush: Cell["flush"],
): Cell {
  const id = `opfs-${operation}-${target}-${occurrence}`;
  return {
    id,
    outcome,
    flush,
    schedule: { id, occurrence, at: { adapter: "opfs", operation, target } },
  };
}
const cells: Cell[] = [
  fault("create", "snapshot", 1, "old-complete", "rejected"),
  fault("open", "snapshot", 1, "old-complete", "rejected"),
  fault("flush", "snapshot", 1, "old-complete", "rejected"),
  fault("flush", "payload", 1, "new-complete", "rejected"),
  fault("flush", "snapshot", 2, "new-complete", "rejected"),
  fault("remove", "snapshot", 1, "new-complete", "fulfilled"),
  fault("removed", "snapshot", 1, "new-complete", "fulfilled"),
  fault("remove", "payload", 1, "new-complete", "fulfilled"),
  { id: "opfs-control", schedule: null, outcome: "new-complete", flush: "fulfilled" },
];
function installFault(fixture: ReturnType<typeof identityOpfsFixture>, scheduler: FaultScheduler) {
  const thrown: Error[] = [];
  fixture.fault((operation, name) => {
    const target = name.startsWith("snapshot-")
      ? "snapshot"
      : name.startsWith("p-")
        ? "payload"
        : "identity";
    try {
      scheduler.inject({ adapter: "opfs", operation, target, resource: name });
    } catch (error) {
      invariant(error === scheduler.reason, "fixture hook throws the exact scheduled error");
      thrown.push(scheduler.reason);
      throw error;
    }
  });
  return thrown;
}
function cleanupEffect(
  scheduler: FaultScheduler,
  inventory: ReturnType<ReturnType<typeof identityOpfsFixture>["inventory"]>,
) {
  const event = scheduler.events.find((event) => event.injected);
  if (!event || !["remove", "removed"].includes(event.operation)) return null;
  const names = event.target === "snapshot" ? inventory.snapshots : inventory.data;
  const present = names.includes(event.resource);
  equal(
    present,
    event.operation === "remove",
    "cleanup fault has its exact before-unlink or after-unlink effect",
  );
  return { resource: event.resource, operation: event.operation, target: event.target, present };
}
async function runCell(cell: Cell, scheduler: FaultScheduler) {
  const fixture = identityOpfsFixture();
  const owners: OpfsStorage[] = [];
  const backends: Awaited<ReturnType<typeof opened>>[] = [];
  const open = async () => {
    const storage = await OpfsStorage.open("storage-crash-r2", fixture);
    owners.push(storage);
    const backend = await opened(storage);
    backends.push(backend);
    return { storage, backend };
  };
  return withCellCleanup(
    () => performCell(cell, scheduler, open, fixture),
    async () => {
      fixture.fault();
      await closeCells(backends, owners);
    },
  );
}
async function performCell(
  cell: Cell,
  scheduler: FaultScheduler,
  open: () => Promise<{ storage: OpfsStorage; backend: Awaited<ReturnType<typeof opened>> }>,
  fixture: ReturnType<typeof identityOpfsFixture>,
) {
  const first = await open();
  for (let generation = 1; generation <= 2; generation++) {
    seedChange(first.backend, generation);
    await first.backend.flush();
  }
  const before = await recoveredState(first.backend);
  const oldGeneration = (await first.storage.load())?.generation;
  replaceAndRename(first.backend);
  const after = await recoveredState(first.backend);
  const changedMode = modeDelta(before, after);
  const inventoryBefore = fixture.inventory();
  const ids = before.metadata
    .concat(after.metadata)
    .flatMap((entry) => (entry.id ? [entry.id] : []));
  const thrown = installFault(fixture, scheduler);
  let failure: unknown;
  try {
    await first.backend.flush();
  } catch (error) {
    failure = error;
  } finally {
    fixture.fault();
  }
  const inventoryAfter = fixture.inventory();
  scheduler.assertReached();
  equal(thrown.length, cell.schedule ? 1 : 0, "exactly the selected fixture hook throws");
  if (cell.flush === "rejected")
    invariant(
      causedBy(failure, scheduler.reason),
      "rejected flush preserves the injected OPFS error identity through cause",
    );
  if (cell.outcome === "old-complete")
    equal(
      inventoryAfter,
      inventoryBefore,
      "failed save preserves exact data and snapshot inventories before reopen",
    );
  const cleanup = cleanupEffect(scheduler, inventoryAfter);
  invariant(
    (failure !== undefined) === (cell.flush === "rejected"),
    "only publication or explicit flush failure rejects; cleanup cannot uncommit",
  );
  first.backend.dispose();
  await first.storage.close();
  const expected = cell.outcome === "old-complete" ? before : after;
  const second = await open();
  const firstReopen = await checkReopen(second.backend, expected, ids);
  const recoveredGeneration = (await second.storage.load())?.generation;
  equal(
    recoveredGeneration,
    cell.outcome === "old-complete" ? oldGeneration : (oldGeneration ?? 0) + 1,
    "OPFS recovered generation matches publication boundary",
  );
  second.backend.dispose();
  await second.storage.close();
  const third = await open();
  const secondReopen = await checkReopen(third.backend, expected, ids);
  invariant(
    firstReopen.freshId !== secondReopen.freshId,
    "an abandoned allocation from the first reopen is never reused",
  );
  let inventoryAfterRetry = null;
  if (cleanup) {
    seedChange(third.backend, 3);
    await third.backend.flush();
    inventoryAfterRetry = fixture.inventory();
    const names =
      cleanup.target === "snapshot" ? inventoryAfterRetry.snapshots : inventoryAfterRetry.data;
    invariant(
      !names.includes(cleanup.resource),
      "later checkpoint collects the selected obsolete resource",
    );
  }
  return {
    id: cell.id,
    ok: true,
    schedule: cell.schedule,
    events: scheduler.events,
    oldGeneration,
    recoveredGeneration,
    changedMode,
    inventoryBefore,
    inventoryAfter,
    cleanup,
    inventoryAfterRetry,
    firstReopen,
    secondReopen,
    outcome: cell.outcome,
    flush: cell.flush,
    model:
      "existing in-memory OPFS fixture with real OpfsStorage; write/flush API failures only, not physical durability or process death",
    invariants: [
      "namespace",
      "mode",
      "bytes",
      "FileId",
      "revision",
      "no-reuse",
      "generation",
      "checked-mutations",
      "target-mode-delta-600-to-400",
      "second-reopen",
    ].concat(
      cell.outcome === "old-complete" ? ["exact-failed-save-data-and-snapshot-inventories"] : [],
      cell.flush === "rejected" ? ["injected-error-cause-identity"] : [],
      cleanup ? ["exact-cleanup-unlink-effect", "later-checkpoint-collection"] : [],
    ),
  };
}

export async function opfsCrashMatrix() {
  return runFaultSchedules(cells, runCell);
}
