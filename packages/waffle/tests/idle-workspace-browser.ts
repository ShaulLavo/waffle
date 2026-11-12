import { idle, request, seed } from "./idle-workspace-fixtures.js";
import { idleMaintenanceCases } from "./idle-workspace-maintenance-browser.js";
import { idleMetadataCases } from "./idle-workspace-metadata-browser.js";
import { idleCancellationCases } from "./idle-workspace-cancellation-browser.js";
import { storageQuotaControl } from "./storage-quota-control.js";
import type { StorageAllocationHooks } from "./storage-allocation.js";
import { INDEXEDDB_FORMAT } from "../fs/vfs-format.js";
import {
  createRuntime,
  openIdleWorkspace,
  storedWorkspaces,
  type IdleWorkspace,
} from "../index.js";
import {
  assert,
  batch,
  bytes,
  rejects,
  type StorageContractCase,
} from "./storage-browser-helpers.js";

async function readonlyAccess(name: string, legacy = false): Promise<void> {
  const transaction = IDBDatabase.prototype.transaction;
  const get = IDBObjectStore.prototype.get;
  let payloadReads = 0;
  IDBDatabase.prototype.transaction = function (stores, mode, options) {
    assert(mode === undefined || mode === "readonly", `Unexpected ${mode} transaction`);
    return transaction.call(this, stores, mode, options);
  };
  IDBObjectStore.prototype.get = function (key) {
    if (this.name === "data" && (Array.isArray(key) || (legacy && key === "file:1")))
      payloadReads++;
    return get.call(this, key);
  };
  let owner: IdleWorkspace | undefined;
  try {
    owner = await idle(name);
    assert(payloadReads === 0, "opening loads no payload chunks");
    assert(JSON.stringify(await owner.listFiles("/")) === '["/file"]', "saved paths");
    assert(payloadReads === 0, "listing loads no payload chunks");
    assert(
      new TextDecoder().decode(await owner.readFile("/file")) === "saved source",
      "saved bytes",
    );
    assert(payloadReads > 0, "reading loads the selected payload");
  } finally {
    const closing = owner?.close();
    IDBDatabase.prototype.transaction = transaction;
    IDBObjectStore.prototype.get = get;
    await closing;
  }
}

async function quotaWriteFails(name: string): Promise<void> {
  const payload = new Uint8Array(16 * 1024 * 1024);
  for (let offset = 0; offset < payload.length; offset += 65536)
    crypto.getRandomValues(payload.subarray(offset, offset + 65536));
  const database = await request(indexedDB.open(name));
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction("data", "readwrite");
      tx.objectStore("data").put(payload, "quota-probe");
      tx.oncomplete = () => reject(new Error("Quota override allowed a large write"));
      tx.onabort = () => {
        if (tx.error?.name === "QuotaExceededError") resolve();
        else reject(tx.error);
      };
    });
  } finally {
    database.close();
  }
}

async function modify(name: string, work: (tx: IDBTransaction) => void): Promise<void> {
  const database = await request(indexedDB.open(name));
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(["metadata", "data"], "readwrite");
      work(tx);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    database.close();
  }
}

export function idleWorkspaceCases(
  workerURL?: string | URL,
  allocation?: StorageAllocationHooks,
): StorageContractCase[] {
  const cases: StorageContractCase[] = [];
  const test = (label: string, run: StorageContractCase["run"]) =>
    cases.push({ label: `idle workspace ${label}`, run });
  test("missing creates nothing and abort is respected", async (name) => {
    const before = await indexedDB.databases();
    assert((await openIdleWorkspace({ mode: "fast", name })) === "missing", "missing workspace");
    assert(
      JSON.stringify(await indexedDB.databases()) === JSON.stringify(before),
      "no database created",
    );
    const signal = AbortSignal.abort(new Error("cancel idle opening"));
    await rejects(openIdleWorkspace({ mode: "fast", name }, { signal }), "cancel idle opening");
  });
  test("lists exact names and leaves unrelated databases unchanged", async (name) => {
    const unrelated = `${name}-unrelated`;
    await allocation?.allocate({ kind: "indexeddb", name: unrelated });
    const foreign = indexedDB.open(unrelated, 7);
    foreign.onupgradeneeded = () => foreign.result.createObjectStore("foreign");
    const database = await request(foreign);
    database.close();
    try {
      const before = await storedWorkspaces("fast");
      await seed(name);
      const names = await storedWorkspaces("fast");
      assert(
        JSON.stringify(names.sort()) === JSON.stringify(before.concat([name]).sort()),
        "exact unprefixed names",
      );
      assert(
        (await openIdleWorkspace({ mode: "fast", name: unrelated })) === "missing",
        "foreign is not a workspace",
      );
      const unchanged = await request(indexedDB.open(unrelated));
      assert(
        unchanged.version === 7 && unchanged.objectStoreNames.contains("foreign"),
        "foreign layout unchanged",
      );
      unchanged.close();
    } finally {
      await request(indexedDB.deleteDatabase(unrelated));
    }
  });
  test("colliding unrelated schema and explicit corrupt schema remain unchanged", async (name) => {
    const foreign = indexedDB.open(name, 1);
    foreign.onupgradeneeded = () => {
      for (const store of ["metadata", "journal", "data"]) foreign.result.createObjectStore(store);
    };
    const database = await request(foreign);
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction("metadata", "readwrite");
      tx.objectStore("metadata").put(42, "epoch");
      tx.objectStore("metadata").put("untouched", "foreign-layout");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    database.close();
    assert(!(await storedWorkspaces("fast")).includes(name), "colliding schema is unrelated");
    assert(
      (await openIdleWorkspace({ mode: "fast", name })) === "missing",
      "unrelated schema is missing",
    );
    await modify(name, (tx) => {
      tx.objectStore("metadata").put(INDEXEDDB_FORMAT, "format");
    });
    await rejects(openIdleWorkspace({ mode: "fast", name }), "metadata layout");
    assert(!(await storedWorkspaces("fast")).includes(name), "invalid FAST schema is omitted");
    const unchanged = await request(indexedDB.open(name));
    try {
      assert(
        (await request(
          unchanged.transaction("metadata").objectStore("metadata").get("foreign-layout"),
        )) === "untouched",
        "foreign content unchanged",
      );
    } finally {
      unchanged.close();
    }
  });
  test("disappearing enumerated database is never recreated", async (name) => {
    await seed(name);
    const nativeOpen = IDBFactory.prototype.open;
    const removed = Promise.withResolvers<void>();
    let disappeared = false;
    IDBFactory.prototype.open = function (databaseName, version) {
      if (databaseName === name && !disappeared) {
        disappeared = true;
        void request(indexedDB.deleteDatabase(name)).then(() => removed.resolve(), removed.reject);
      }
      return version === undefined
        ? nativeOpen.call(this, databaseName)
        : nativeOpen.call(this, databaseName, version);
    };
    try {
      assert(!(await storedWorkspaces("fast")).includes(name), "disappeared candidate skipped");
      await removed.promise;
      assert(
        !(await indexedDB.databases()).some((database) => database.name === name),
        "upgrade transaction rolled back creation",
      );
    } finally {
      IDBFactory.prototype.open = nativeOpen;
    }
  });
  test("open, list and read are lazy and never write", async (name) => {
    await seed(name);
    await readonlyAccess(name);
    const owner = await idle(name);
    const closed = owner.close();
    assert(owner.close() === closed, "close is idempotent");
    await closed;
    await rejects(owner.readFile("/file"), "closed");
  });
  test("legacy reads never migrate or reserve identities", async (name) => {
    await seed(name);
    await modify(name, (tx) => {
      tx.objectStore("metadata").delete("format");
      tx.objectStore("data").put(bytes("saved source"), "file:1");
      tx.objectStore("data").delete(["file:1", 0]);
    });
    await readonlyAccess(name, true);
  });
  test("recovered view reads without committing recovery", async (name, open) => {
    const storage = await open();
    await storage.persist(batch(1, "saved source"));
    await storage.persist(batch(2, "abandoned source"));
    await storage.close();
    await modify(name, (tx) => {
      tx.objectStore("data").delete(["file:2", 0]);
    });
    await readonlyAccess(name);
  });
  test("corrupt storage rejects without writing", async (name) => {
    await seed(name);
    await modify(name, (tx) => {
      tx.objectStore("data").delete(["file:1", 0]);
    });
    await rejects(openIdleWorkspace({ mode: "fast", name }), "corrupt");
    assert(!(await storedWorkspaces("fast")).includes(name), "enumeration skips corrupt workspace");
    assert(
      (await indexedDB.databases()).some((database) => database.name === name),
      "corrupt database remains untouched",
    );
    await modify(name, (tx) => {
      tx.objectStore("metadata").put("another-format-v9", "format");
    });
    await rejects(openIdleWorkspace({ mode: "fast", name }), "format identity");
    assert(!(await storedWorkspaces("fast")).includes(name), "unknown format is omitted");
  });
  test("full origin open and read", async (name) => {
    await seed(name);
    await modify(name, (tx) => {
      tx.objectStore("metadata").delete("format");
      tx.objectStore("data").put(bytes("saved source"), "file:1");
      tx.objectStore("data").delete(["file:1", 0]);
    });
    const fillerName = `${name}-quota`;
    await allocation?.allocate({ kind: "indexeddb", name: fillerName });
    const opening = indexedDB.open(fillerName);
    opening.onupgradeneeded = () => opening.result.createObjectStore("data");
    (await request(opening)).close();
    const capped = await storageQuotaControl("cap");
    try {
      if (capped) await quotaWriteFails(fillerName);
      await readonlyAccess(name, true);
    } finally {
      await storageQuotaControl("reset");
      await request(indexedDB.deleteDatabase(fillerName));
    }
  });
  test("runtime first is busy and ordinary takeover still works", async (name, open) => {
    await seed(name);
    const first = await open();
    const successor = await open();
    try {
      assert(
        (await openIdleWorkspace({ mode: "fast", name })) === "busy",
        "runtime wins maintenance race",
      );
      await successor.persist(batch(2, "newer source"));
      await rejects(first.load(), "opened in another tab");
    } finally {
      await successor.close();
      await first.close();
    }
    const owner = await idle(name);
    try {
      assert(
        new TextDecoder().decode(await owner.readFile("/file")) === "newer source",
        "newer saved source survives",
      );
    } finally {
      await owner.close();
    }
  });
  if (workerURL !== undefined)
    test("runtime ownership is busy and reads match", async (name) => {
      const runtime = createRuntime({
        filesystem: { mode: "fast", name, workerURL: new URL(workerURL, location.href) },
      });
      let expected: string[] = [];
      let expectedBytes: Uint8Array | undefined;
      try {
        await runtime.filesystem.writeFile("/dir/source", bytes("source bytes"));
        await runtime.filesystem.writeFile("/other", new Uint8Array([0, 255, 3]));
        await runtime.filesystem.flush();
        expected = await runtime.filesystem.listFiles("/");
        expectedBytes = await runtime.filesystem.readFile("/dir/source");
        assert(
          (await openIdleWorkspace({ mode: "fast", name })) === "busy",
          "runtime owns workspace",
        );
      } finally {
        await runtime.dispose();
      }
      const owner = await idle(name);
      try {
        assert(
          JSON.stringify(await owner.listFiles("/")) === JSON.stringify(expected),
          "same recursive paths",
        );
        assert(
          JSON.stringify(await owner.readFile("/dir/source")) === JSON.stringify(expectedBytes),
          "same bytes",
        );
        assert((await owner.readFile("/missing")) === undefined, "missing file");
        assert((await owner.readFile("/dir")) === undefined, "directory is not a file");
      } finally {
        await owner.close();
      }
    });
  if (workerURL !== undefined)
    test("works beside the page runtime", async (name) => {
      await seed(name);
      const runtime = createRuntime({
        filesystem: { mode: "memory", workerURL: new URL(workerURL, location.href) },
      });
      let owner: IdleWorkspace | undefined;
      try {
        await runtime.filesystem.writeFile("/live", "independent");
        owner = await idle(name);
        assert(
          new TextDecoder().decode(await owner.readFile("/file")) === "saved source",
          "idle source",
        );
        assert(
          new TextDecoder().decode(await runtime.filesystem.readFile("/live")) === "independent",
          "live tree",
        );
      } finally {
        await owner?.close();
        await runtime.dispose();
      }
    });
  return cases.concat(idleMaintenanceCases(), idleMetadataCases(), idleCancellationCases());
}
