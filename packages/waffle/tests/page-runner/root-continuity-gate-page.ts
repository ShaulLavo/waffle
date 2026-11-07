import { IndexedDBStorage } from "../../fs/indexeddb.js";
import { selectedRootComposition, startupFenceComposition } from "../root-continuity-browser.js";
import { rootContinuityOpenPaths, type RootContinuityControl } from "../root-continuity-command.js";
import type { StorageEntry } from "../storage-allocation.js";
import { cleanupStorage } from "./storage-cleanup.js";
import { rootContinuityStorage } from "./root-continuity-allocation.js";
import { startPage } from "./page-main.js";

async function gate(
  control: RootContinuityControl,
  target: number,
  late: boolean,
  run: string,
  allocate: (entry: StorageEntry) => Promise<void>,
): Promise<string> {
  const original = IndexedDBStorage.open;
  const native = IDBFactory.prototype.open;
  const entered = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<void>();
  void reply.promise.catch(() => {});
  let current = true;
  let acknowledgements = 0;
  let attempts = 0;
  let opens = 0;
  let nativeOpens = 0;
  IndexedDBStorage.open = function (...args: Parameters<typeof original>) {
    attempts++;
    if (attempts > acknowledgements)
      throw new Error("Storage constructor ran before allocation ACK");
    opens++;
    return Reflect.apply(original, this, args);
  };
  IDBFactory.prototype.open = function (...args: Parameters<typeof native>) {
    nativeOpens++;
    return Reflect.apply(native, this, args);
  };
  const storage = rootContinuityStorage(
    { run: `${run}-${target}-${late ? "late" : "rejected"}`, control },
    async (entry) => {
      await allocate(entry);
      if (acknowledgements + 1 === target) {
        entered.resolve();
        await reply.promise;
      }
      acknowledgements++;
    },
    () => current,
  );
  const running =
    control === "selected"
      ? selectedRootComposition(storage)
      : startupFenceComposition(control, storage);
  const outcome = running.then(() => "unexpected fulfilment", String);
  try {
    const first = await Promise.race([entered.promise.then(() => "entered"), outcome]);
    if (first !== "entered") throw new Error(`Allocation hook was bypassed: ${first}`);
    if (attempts !== target - 1 || opens !== target - 1 || nativeOpens !== target - 1)
      throw new Error(`Constructor ran before held ACK: ${attempts}/${opens}/${nativeOpens}`);
    if (late) {
      current = false;
      reply.resolve();
    } else reply.reject(new Error("allocation rejected control"));
    const error = await outcome;
    const expected = late ? "acknowledgement is no longer current" : "allocation rejected control";
    if (!error.includes(expected) || attempts !== target - 1 || nativeOpens !== target - 1)
      throw new Error(`Rejected ACK admitted a constructor: ${error}, ${attempts}/${nativeOpens}`);
    return `${control}:${target}:${late ? "late" : "rejected"}`;
  } finally {
    current = false;
    reply.reject(new Error("control cleanup"));
    await outcome;
    IndexedDBStorage.open = original;
    IDBFactory.prototype.open = native;
    const deletion = indexedDB.deleteDatabase(storage.name());
    await new Promise<void>((resolve, reject) => {
      deletion.onsuccess = () => resolve();
      deletion.onerror = () => reject(deletion.error);
      deletion.onblocked = () => reject(new Error("Gate control database remains open"));
    });
  }
}

startPage<{ run: string }>({
  list: () => Promise.resolve({ ids: ["root-continuity-allocation"] }),
  async run(request, allocate) {
    const observations: string[] = [];
    for (const { control, target } of rootContinuityOpenPaths) {
      for (const late of [false, true])
        observations.push(await gate(control, target, late, request.run, allocate));
    }
    return observations;
  },
  finish: cleanupStorage,
});
