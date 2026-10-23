import { OpfsStorage } from "../fs/opfs.js";
import { identityOpfsFixture } from "./fixtures/durable-identity-opfs.js";
import {
  type FaultScheduler,
  type FaultSchedule,
  runFaultSchedules,
} from "./storage-crash-r2-scheduler.js";
import {
  checkReopen,
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
  try {
    const first = await open();
    for (let generation = 1; generation <= 2; generation++) {
      seedChange(first.backend, generation);
      await first.backend.flush();
    }
    const before = await recoveredState(first.backend);
    const oldGeneration = (await first.storage.load())?.generation;
    replaceAndRename(first.backend);
    const after = await recoveredState(first.backend);
    const ids = before.metadata
      .concat(after.metadata)
      .flatMap((entry) => (entry.id ? [entry.id] : []));
    fixture.fault((operation, name) => {
      const target = name.startsWith("snapshot-")
        ? "snapshot"
        : name.startsWith("p-")
          ? "payload"
          : "identity";
      if (scheduler.visit({ adapter: "opfs", operation, target })) throw scheduler.reason;
    });
    let failure: unknown;
    try {
      await first.backend.flush();
    } catch (error) {
      failure = error;
    } finally {
      fixture.fault();
    }
    scheduler.assertReached();
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
    return {
      id: cell.id,
      ok: true,
      schedule: cell.schedule,
      events: scheduler.events,
      oldGeneration,
      recoveredGeneration,
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
        "second-reopen",
      ],
    };
  } finally {
    fixture.fault();
    for (const backend of backends) backend.dispose();
    await Promise.all(owners.map((storage) => storage.close()));
  }
}
export async function opfsCrashMatrix() {
  return runFaultSchedules(cells, runCell);
}
