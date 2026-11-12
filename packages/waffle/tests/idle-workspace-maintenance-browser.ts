import { openIdleWorkspace, storedWorkspaces, type IdleWorkspace } from "../index.js";
import { IndexedDBStorage } from "../fs/indexeddb.js";
import { idle, request, seed } from "./idle-workspace-fixtures.js";
import { assert, batch, rejects, type StorageContractCase } from "./storage-browser-helpers.js";
import { gatedIndexedDB } from "./gated-indexeddb.js";

async function usageAfterRemoval(before: number): Promise<number | undefined> {
  let usage = (await navigator.storage.estimate()).usage;
  for (let sample = 0; sample < 20 && usage !== undefined && usage >= before; sample++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    usage = (await navigator.storage.estimate()).usage;
  }
  return usage;
}

async function nativeUsageControl(name: string, payload: Uint8Array) {
  const opening = indexedDB.open(name);
  opening.onupgradeneeded = () => opening.result.createObjectStore("control");
  const database = await request(opening);
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction("control", "readwrite", { durability: "strict" });
      tx.objectStore("control").put(payload, "bytes");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    database.close();
  }
  const before = (await navigator.storage.estimate()).usage;
  await request(indexedDB.deleteDatabase(name));
  return { before, after: before === undefined ? undefined : await usageAfterRemoval(before) };
}

function observedOpener(name: string, factory = indexedDB) {
  const requested = Promise.withResolvers<void>();
  let opens = 0;
  let settled = false;
  const observedFactory = new Proxy(factory, {
    get(target, key) {
      if (key === "open")
        return (...args: Parameters<IDBFactory["open"]>) => {
          opens++;
          return target.open(...args);
        };
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const opened = IndexedDBStorage.open(name, {
    indexedDB: observedFactory,
    locks: {
      request(...args) {
        if (args[0] === `bun-wasm:filesystem:indexeddb-maintenance:${name}`) requested.resolve();
        return navigator.locks.request(...args);
      },
    },
  });
  void opened.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return {
    requested: requested.promise,
    opened,
    get opens() {
      return opens;
    },
    get settled() {
      return settled;
    },
  };
}

async function deletionRace(name: string, cancel: boolean): Promise<void> {
  await seed(name);
  const controller = new AbortController();
  const owner = await openIdleWorkspace({ mode: "fast", name }, { signal: controller.signal });
  assert(typeof owner !== "string", "idle view accepted");
  const blocker = await request(indexedDB.open(name));
  const nativeDelete = IDBFactory.prototype.deleteDatabase;
  const blocked = Promise.withResolvers<void>();
  let successor: ReturnType<typeof observedOpener> | undefined;
  let removed = false;
  IDBFactory.prototype.deleteDatabase = function (databaseName) {
    if (databaseName === name) successor = observedOpener(name);
    const deletion = nativeDelete.call(this, databaseName);
    deletion.addEventListener("blocked", () => blocked.resolve(), { once: true });
    deletion.addEventListener(
      "success",
      () => {
        removed = true;
      },
      { once: true },
    );
    return deletion;
  };
  let deletion: Promise<unknown> | undefined;
  try {
    deletion = owner.delete().then(
      () => undefined,
      (error: unknown) => error,
    );
    await blocked.promise;
    assert(successor, "opener started at the old final-check boundary");
    await successor.requested;
    assert(
      successor.opens === 0 && !successor.settled,
      "no connection escapes blocked maintenance",
    );
    assert(!removed, "blocked is not native success");
    if (cancel) controller.abort(new Error("cancel blocked deletion"));
    assert(owner.close() === owner.close(), "close joins the non-cancellable deletion");
    assert(!successor.settled, "cancellation does not release maintenance");
    blocker.close();
    const outcome = await deletion;
    assert(removed, "native deletion completed before maintenance release");
    if (cancel) assert(outcome === controller.signal.reason, "cancellation identity retained");
    else assert(outcome === undefined, "delete reports actual success");
    const writer = await successor.opened;
    try {
      assert((await writer.load()) === undefined, "successor sees a new tree after deletion");
      await writer.persist(batch(2, "successor source"));
    } finally {
      await writer.close();
    }
    const reopened = await idle(name);
    try {
      assert(
        new TextDecoder().decode(await reopened.readFile("/file")) === "successor source",
        "successor write survives",
      );
    } finally {
      await reopened.close();
    }
  } finally {
    IDBFactory.prototype.deleteDatabase = nativeDelete;
    blocker.close();
    await deletion;
    await owner.close().catch(() => {});
    const writer = await successor?.opened;
    await writer?.close();
  }
}

async function abortedNativeOpen(name: string): Promise<void> {
  await seed(name);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const factory = indexedDB;
  const gate = gatedIndexedDB(factory);
  const controller = new AbortController();
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: gate.factory });
  let owner: IdleWorkspace | "busy" | "missing" | undefined;
  const pending = openIdleWorkspace({ mode: "fast", name }, { signal: controller.signal });
  let successor: ReturnType<typeof observedOpener> | undefined;
  try {
    await gate.ready;
    controller.abort(new Error("cancel native idle open"));
    await rejects(pending, "cancel native idle open");
    successor = observedOpener(name, factory);
    await successor.requested;
    assert(successor.opens === 0, "cancelled pending native open keeps maintenance");
    gate.release();
    const writer = await successor.opened;
    try {
      assert((await writer.load())?.generation === 1, "late native completion preserved data");
    } finally {
      await writer.close();
    }
    assert(gate.closed === 1, "late connection closed exactly once");
  } finally {
    gate.release();
    if (descriptor) Object.defineProperty(globalThis, "indexedDB", descriptor);
    else Reflect.deleteProperty(globalThis, "indexedDB");
    owner = await pending.catch(() => undefined);
    if (owner && typeof owner !== "string") await owner.close();
    await (await successor?.opened)?.close();
  }
}

export function idleMaintenanceCases(): StorageContractCase[] {
  return [
    {
      label: "idle workspace maintenance first excludes connections until close",
      async run(name) {
        await seed(name);
        const owner = await idle(name);
        let successor: ReturnType<typeof observedOpener> | undefined;
        try {
          assert(
            (await openIdleWorkspace({ mode: "fast", name })) === "busy",
            "second idle evictor is busy",
          );
          successor = observedOpener(name);
          await successor.requested;
          assert(
            successor.opens === 0 && !successor.settled,
            "ordinary open waits before IndexedDB",
          );
          assert(
            new TextDecoder().decode(await owner.readFile("/file")) === "saved source",
            "accepted view stays readable",
          );
        } finally {
          await owner.close();
          await (await successor?.opened)?.close();
        }
      },
    },
    {
      label: "idle workspace delete wins past final check and blocked native completion",
      run: (name) => deletionRace(name, false),
    },
    {
      label: "idle workspace cancelled blocked delete retains exclusion to native success",
      run: (name) => deletionRace(name, true),
    },
    {
      label: "idle workspace cancelled native open retains exclusion until late close",
      run: abortedNativeOpen,
    },
    {
      label: "idle workspace deletion removes database and reclaims origin usage",
      async run(name, open) {
        const storage = await open();
        const payload = new Uint8Array(2 * 1024 * 1024);
        for (let start = 0; start < payload.length; start += 65536)
          crypto.getRandomValues(payload.subarray(start, start + 65536));
        const saved = batch(1);
        saved.upserts[1]!.size = payload.length;
        saved.data.set("file:1", payload);
        await storage.persist(saved);
        await storage.close();
        const before = (await navigator.storage.estimate()).usage;
        const owner = await idle(name);
        try {
          await owner.delete();
        } finally {
          await owner.close();
        }
        assert(
          !(await storedWorkspaces("fast")).includes(name),
          "deleted workspace is not enumerated",
        );
        assert(
          !(await indexedDB.databases()).some((database) => database.name === name),
          "native database gone",
        );
        const after = before === undefined ? undefined : await usageAfterRemoval(before);
        if (before === undefined || !before || after === undefined) return;
        const control = after >= before ? await nativeUsageControl(name, payload) : undefined;
        console.log(`Storage usage measurement ${JSON.stringify({ before, after, control })}`);
        if (control?.before !== undefined && control.after !== undefined) {
          assert(
            control.after >= control.before,
            "native deletion reports reclamation but Waffle did not",
          );
          assert(
            !(await indexedDB.databases()).some((database) => database.name === name),
            "native control database removed",
          );
        } else assert(after < before, `origin usage fell from ${before} to ${after}`);
      },
    },
  ];
}
