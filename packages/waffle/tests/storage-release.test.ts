import { expect, spyOn, test } from "bun:test";
import { maintenanceLock, type StorageLockManager } from "../fs/storage-maintenance";
import { acquirePublicationGuard } from "../fs/publication-attachment";
import { openIdle } from "../fs/idle-owner";
import { storedNames } from "../fs/idle-database";
import { IndexedDBStorage } from "../fs/indexeddb";
import { INDEXEDDB_FORMAT } from "../fs/vfs-format";

const turns = async () => {
  for (let turn = 0; turn < 24; turn++) await Promise.resolve();
};
class BrokerModel implements StorageLockManager {
  readonly events: string[] = [];
  readonly broker = new Set<string>();
  private readonly closing = new Set<string>();
  requestGate: Promise<void> = Promise.resolve();
  requestFailure: { value: unknown } | undefined;
  writerLoss: Promise<never> | undefined;
  writerRequestFailure: { kind: "throw" | "reject"; value: unknown } | undefined;
  queryResult: () => Promise<unknown> = () => Promise.resolve({ held: ["unrelated-owner"] });
  query(): Promise<unknown> {
    this.events.push("query");
    for (const name of this.closing) this.broker.delete(name);
    this.closing.clear();
    return this.queryResult();
  }
  request<T>(
    name: string,
    options: Parameters<StorageLockManager["request"]>[1],
    callback: (lock: unknown | null) => Promise<T>,
  ): Promise<T> {
    if (name.startsWith("bun-wasm:filesystem:indexeddb:") && this.writerRequestFailure) {
      if (this.writerRequestFailure.kind === "throw") throw this.writerRequestFailure.value;
      return Promise.reject(this.writerRequestFailure.value);
    }
    const busy = options.mode === "exclusive" && this.broker.has(name);
    if (!busy) this.broker.add(name);
    const result = Promise.resolve()
      .then(() => callback(busy ? null : {}))
      .then(async (value) => {
        this.events.push(`callback:${name}`);
        if (!busy) this.closing.add(name);
        await this.requestGate;
        this.events.push(`request:${name}`);
        if (this.requestFailure) throw this.requestFailure.value;
        return value;
      });
    return this.writerLoss && name.startsWith("bun-wasm:filesystem:indexeddb:")
      ? Promise.race([result, this.writerLoss])
      : result;
  }
}
function environment(values: Record<string, unknown>): () => void {
  const original = Object.entries(values).map(
    ([key]) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  return () => {
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}
async function lease(locks: BrokerModel) {
  const owned = await maintenanceLock(locks, "ordering", "shared");
  if (owned === "busy") throw new Error("missing real maintenance lease");
  return owned;
}
async function rejected(promise: Promise<unknown>): Promise<unknown> {
  const outcome = await promise.then(
    (value) => ({ kind: "value" as const, value }),
    (error) => ({ kind: "error" as const, error }),
  );
  expect(outcome.kind).toBe("error");
  if (outcome.kind !== "error") throw new Error("unexpected success");
  return outcome.error;
}
function combined(value: unknown, errors: unknown[]): void {
  expect(value).toBeInstanceOf(AggregateError);
  if (!(value instanceof AggregateError)) throw new Error("missing independent failures");
  expect(value.errors).toEqual(errors);
  expect(value.cause).toBe(errors[0]);
}

test("real maintenance lease joins callback, renderer request and broker query in order", async () => {
  const locks = new BrokerModel();
  const request = Promise.withResolvers<void>(),
    query = Promise.withResolvers<unknown>();
  locks.requestGate = request.promise;
  locks.queryResult = () => query.promise;
  const owned = await lease(locks);
  expect(locks.events).toEqual([]);
  let finished = false;
  const release = owned.release().then(() => {
    finished = true;
  });
  await turns();
  expect(locks.events).toEqual(["callback:bun-wasm:filesystem:indexeddb-maintenance:ordering"]);
  expect(finished).toBe(false);
  request.resolve();
  await turns();
  expect(locks.events.at(-1)).toBe("query");
  expect(finished).toBe(false);
  query.resolve({
    get held() {
      throw new Error("snapshot must not be inspected");
    },
  });
  await release;
  expect(finished).toBe(true);
  await owned.release();
  expect(locks.events.filter((value) => value === "query")).toHaveLength(1);
});

test("renderer-complete but broker-held maintenance cannot be reported released", async () => {
  const locks = new BrokerModel();
  const owned = await lease(locks);
  expect(await maintenanceLock(locks, "ordering", "exclusive")).toBe("busy");
  await owned.release();
  const reopened = await maintenanceLock(locks, "ordering", "exclusive");
  expect(reopened).not.toBe("busy");
  if (reopened !== "busy") await reopened.release();
});

for (const synchronous of [false, true])
  test(`real maintenance retains ${synchronous ? "synchronous" : "rejected"} query failure across release`, async () => {
    const locks = new BrokerModel(),
      reason = new Error("confirmation");
    locks.queryResult = () => {
      if (synchronous) throw reason;
      return Promise.reject(reason);
    };
    const owned = await lease(locks);
    const release = owned.release();
    expect(await rejected(release)).toBe(reason);
    expect(owned.release()).toBe(release);
    expect(await rejected(owned.release())).toBe(reason);
    expect(locks.events.filter((value) => value === "query")).toHaveLength(1);
  });

test("real maintenance preserves exact request rejection without querying", async () => {
  const locks = new BrokerModel();
  const owned = await lease(locks);
  locks.requestFailure = { value: 0 };
  expect(await rejected(owned.release())).toBe(0);
  expect(locks.events).not.toContain("query");
});

test("publication guard uses the original manager and memoizes broker failure", async () => {
  const locks = new BrokerModel(),
    reason = new Error("guard query");
  const restore = environment({ navigator: { locks } });
  try {
    const guard = await acquirePublicationGuard("guard", "exclusive", new AbortController().signal);
    locks.queryResult = () => Promise.reject(reason);
    const release = guard.release();
    expect(await rejected(release)).toBe(reason);
    expect(guard.release()).toBe(release);
    expect(await rejected(guard.release())).toBe(reason);
    expect(locks.events.at(-1)).toBe("query");
    expect(locks.events.filter((value) => value === "query")).toHaveLength(1);
  } finally {
    restore();
  }
});

/** Only native IndexedDB delivery is simulated; the real idle owner, storage close and leases run. */
function idleFixture() {
  const locks = new BrokerModel();
  let closes = 0;
  let operationFailure: { value: unknown } | undefined;
  let closeFailure: { value: unknown } | undefined;
  function nativeRequest(result: unknown) {
    const request = {
      result,
      error: null,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
    };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  }
  const database = {
    version: 1,
    objectStoreNames: {
      length: 3,
      contains: (name: string) => ["metadata", "journal", "data"].includes(name),
    },
    close() {
      closes++;
      if (closeFailure) throw closeFailure.value;
    },
    transaction() {
      if (operationFailure) throw operationFailure.value;
      return {
        objectStore: () => ({
          get: () => nativeRequest(INDEXEDDB_FORMAT),
          getAllKeys: () => nativeRequest([]),
        }),
      };
    },
  };
  const restore = environment({
    navigator: { locks },
    indexedDB: {
      open: () => nativeRequest(database),
      databases: () => Promise.resolve([{ name: "idle" }]),
      deleteDatabase() {
        if (!operationFailure) return nativeRequest(undefined);
        const request = {
          result: undefined,
          error: operationFailure.value,
          onerror: null as (() => void) | null,
        };
        queueMicrotask(() => request.onerror?.());
        return request;
      },
    },
  });
  const loading = spyOn(IndexedDBStorage.prototype, "load").mockResolvedValue(undefined);
  return {
    locks,
    loading,
    get closes() {
      return closes;
    },
    failOperation(value: unknown) {
      operationFailure = { value };
    },
    failClose(value: unknown) {
      closeFailure = { value };
    },
    restore() {
      loading.mockRestore();
      restore();
    },
  };
}
async function idleOwner() {
  const owner = await openIdle("idle");
  if (typeof owner === "string") throw new Error(`expected owner, got ${owner}`);
  return owner;
}
for (const failedQuery of [1, 2])
  test(`idle close retains confirmation ${failedQuery} failure and joins both releases`, async () => {
    const fixture = idleFixture(),
      failure = new Error(`query ${failedQuery}`);
    try {
      let queries = 0;
      fixture.locks.queryResult = () =>
        ++queries === failedQuery ? Promise.reject(failure) : Promise.resolve(undefined);
      const owner = await idleOwner();
      const close = owner.close();
      expect(await rejected(close)).toBe(failure);
      expect(queries).toBe(2);
      expect(owner.close()).toBe(close);
      expect(await rejected(owner.close())).toBe(failure);
      expect(queries).toBe(2);
      expect(fixture.closes).toBe(failedQuery === 1 ? 3 : 2);
    } finally {
      fixture.restore();
    }
  });

test("idle delete retains falsy operation first and both independent confirmation failures", async () => {
  const fixture = idleFixture(),
    maintenance = new Error("maintenance"),
    writer = new Error("writer");
  try {
    const owner = await idleOwner();
    fixture.failOperation(false);
    let queries = 0;
    fixture.locks.queryResult = () => Promise.reject(++queries === 1 ? maintenance : writer);
    const failure = await rejected(owner.delete());
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw failure;
    expect(failure.errors[0]).toBe(false);
    combined(failure.errors[1], [maintenance, writer]);
    expect(failure.cause).toBe(false);
    expect(queries).toBe(2);
  } finally {
    fixture.restore();
  }
});

test("idle native close failure retains ownership and exact cause", async () => {
  const fixture = idleFixture();
  try {
    const owner = await idleOwner();
    fixture.failClose(null);
    expect(await rejected(owner.close())).toBe(null);
    expect(fixture.locks.events).not.toContain("query");
  } finally {
    fixture.restore();
  }
});

test("stored database operation and confirmation failures retain operation first", async () => {
  const fixture = idleFixture(),
    query = new Error("query");
  try {
    fixture.failOperation("");
    fixture.locks.queryResult = () => Promise.reject(query);
    combined(await rejected(storedNames()), ["", query]);
    expect(fixture.closes).toBe(1);
  } finally {
    fixture.restore();
  }
});

test("stored database close failure does not release its maintenance lease", async () => {
  const fixture = idleFixture();
  try {
    fixture.failOperation(0);
    fixture.failClose(undefined);
    combined(await rejected(storedNames()), [0, undefined]);
    expect(fixture.locks.events).not.toContain("query");
  } finally {
    fixture.restore();
  }
});

test("idle close separately joins maintenance cleanup, writer request and writer confirmation", async () => {
  const fixture = idleFixture();
  const renderer = Promise.withResolvers<void>(),
    maintenance = Promise.withResolvers<unknown>(),
    writer = Promise.withResolvers<unknown>();
  try {
    const owner = await idleOwner();
    fixture.locks.requestGate = renderer.promise;
    let queries = 0,
      completed = false;
    fixture.locks.queryResult = () => (++queries === 1 ? maintenance.promise : writer.promise);
    const closing = owner.close().then(() => {
      completed = true;
    });
    await turns();
    expect(queries).toBe(0);
    expect(completed).toBe(false);
    renderer.resolve();
    await turns();
    expect(queries).toBe(1);
    expect(completed).toBe(false);
    maintenance.resolve(undefined);
    await turns();
    expect(queries).toBe(2);
    expect(completed).toBe(false);
    writer.resolve(undefined);
    await closing;
    expect(completed).toBe(true);
  } finally {
    renderer.resolve();
    maintenance.resolve(undefined);
    writer.resolve(undefined);
    fixture.restore();
  }
});

test("idle close continues to tolerate native ownership loss while confirming its cleanup", async () => {
  const fixture = idleFixture(),
    lost = Promise.withResolvers<never>();
  try {
    fixture.locks.writerLoss = lost.promise;
    const owner = await idleOwner();
    lost.reject(new DOMException("stolen", "AbortError"));
    await turns();
    await owner.close();
    expect(fixture.locks.events.filter((value) => value === "query")).toHaveLength(2);
  } finally {
    fixture.restore();
  }
});

test("stored workspace successful inspection cannot hide failed confirmation", async () => {
  const fixture = idleFixture(),
    failure = new Error("required confirmation");
  try {
    fixture.locks.queryResult = () => Promise.reject(failure);
    expect(await rejected(storedNames())).toBe(failure);
  } finally {
    fixture.restore();
  }
});

for (const kind of ["throw", "reject"] as const)
  test(`idle writer request ${kind} preserves its falsy failure and releases maintenance`, async () => {
    const fixture = idleFixture();
    try {
      fixture.locks.writerRequestFailure = { kind, value: 0 };
      expect(await rejected(openIdle("idle"))).toBe(0);
      expect(fixture.locks.events.filter((value) => value === "query")).toHaveLength(1);
      expect(fixture.locks.broker.size).toBe(0);
    } finally {
      fixture.restore();
    }
  });

test("idle rejected writer request preserves operation before failed maintenance confirmation", async () => {
  const fixture = idleFixture(),
    cleanup = new Error("maintenance confirmation");
  try {
    fixture.locks.writerRequestFailure = { kind: "reject", value: false };
    fixture.locks.queryResult = () => Promise.reject(cleanup);
    combined(await rejected(openIdle("idle")), [false, cleanup]);
    expect(fixture.locks.events.filter((value) => value === "query")).toHaveLength(1);
  } finally {
    fixture.restore();
  }
});

for (const cleanupFails of [false, true])
  test(`idle native request failure stays primary when cleanup fails ${cleanupFails}`, async () => {
    const fixture = idleFixture(),
      lost = Promise.withResolvers<never>();
    const maintenance = new Error("maintenance"),
      writer = new Error("writer");
    try {
      fixture.locks.writerLoss = lost.promise;
      const owner = await idleOwner();
      lost.reject(0);
      await turns();
      let queries = 0;
      fixture.locks.queryResult = () => {
        queries++;
        return cleanupFails
          ? Promise.reject(queries === 1 ? maintenance : writer)
          : Promise.resolve(undefined);
      };
      const closing = owner.close();
      const failure = await rejected(closing);
      if (cleanupFails) combined(failure, [0, maintenance, writer]);
      else expect(failure).toBe(0);
      expect(queries).toBe(2);
      expect(owner.close()).toBe(closing);
      expect(await rejected(owner.close())).toBe(failure);
      expect(queries).toBe(2);
    } finally {
      fixture.restore();
    }
  });
