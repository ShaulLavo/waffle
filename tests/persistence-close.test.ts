import { expect, spyOn, test } from "bun:test";
import { PersistentBackend } from "../fs/persistent";
import type { PersistedIndex, PersistenceBatch, StorageBackend } from "../fs/storage";

const encode = (text: string) => new TextEncoder().encode(text);
const closedPersistence = "filesystem persistence backend is closed";

class Gate {
  readonly entered = Promise.withResolvers<void>();
  readonly released = Promise.withResolvers<void>();
  async wait(): Promise<void> {
    this.entered.resolve();
    await this.released.promise;
  }
}

// StorageBackend stand-in only. PersistentBackend and its MemoryBackend operations are real.
class ControlledStorage implements StorageBackend {
  index?: PersistedIndex;
  readonly payloads = new Map<string, Uint8Array>();
  readonly events: string[] = [];
  onPersist?: () => void | Promise<void>;
  onFlush?: () => void | Promise<void>;
  onRead?: () => void | Promise<void>;
  onClose?: () => void | Promise<void>;
  async load(): Promise<PersistedIndex | undefined> {
    return this.index && structuredClone(this.index);
  }
  async read(key: string): Promise<Uint8Array> {
    this.events.push("read");
    await this.onRead?.();
    const payload = this.payloads.get(key);
    if (!payload) throw new Error("missing test payload");
    return payload.slice();
  }
  async persist(batch: PersistenceBatch): Promise<void> {
    this.events.push("persist");
    await this.onPersist?.();
    const nodes = new Map(this.index?.nodes.map((node) => [node.ino, node]));
    for (const node of batch.upserts) nodes.set(node.ino, structuredClone(node));
    for (const ino of batch.removes) nodes.delete(ino);
    for (const [key, payload] of batch.data) this.payloads.set(key, payload.slice());
    this.index = {
      version: 1,
      generation: batch.generation,
      root: batch.root,
      nodes: Array.from(nodes.values()),
    };
  }
  async flush(): Promise<void> {
    this.events.push("flush");
    await this.onFlush?.();
  }
  async close(): Promise<void> {
    this.events.push("close");
    await this.onClose?.();
  }
}

type Fixture = {
  readonly store: ControlledStorage;
  readonly backend: PersistentBackend;
  gate(): Gate;
  track(promise: Promise<void>): Promise<void>;
  reopen(): Promise<PersistentBackend>;
};

async function withBackend(
  run: (fixture: Fixture) => Promise<void>,
  intervalMs = 0,
): Promise<void> {
  const gates: Gate[] = [];
  const pending: Promise<void>[] = [];
  const backends: PersistentBackend[] = [];
  const store = new ControlledStorage();
  try {
    const backend = await PersistentBackend.open(store, { intervalMs });
    backends.push(backend);
    await run({
      store,
      backend,
      gate() {
        const gate = new Gate();
        gates.push(gate);
        return gate;
      },
      track(promise) {
        void promise.catch(() => {});
        pending.push(promise);
        return promise;
      },
      async reopen() {
        const reopened = await PersistentBackend.open(store, { intervalMs: 0 });
        backends.push(reopened);
        return reopened;
      },
    });
  } finally {
    for (const gate of gates) gate.released.resolve();
    await Promise.allSettled(pending);
    for (const backend of backends) backend.dispose();
  }
}

async function rejection(promise: Promise<void>): Promise<unknown> {
  const [outcome] = await Promise.allSettled([promise]);
  expect(outcome?.status).toBe("rejected");
  if (outcome?.status !== "rejected") throw new Error("expected original close rejection");
  return outcome.reason;
}

function writes(backend: PersistentBackend, path = "/saved"): void {
  backend.execute("writeFile", [path], encode("saved"));
}

const reasons: readonly unknown[] = [
  new Error("original storage failure"),
  undefined,
  null,
  false,
  0,
  -0,
  0n,
  NaN,
  "",
];

async function failsOnce(stage: "persist" | "flush" | "close", reason: unknown): Promise<void> {
  await withBackend(async ({ store, backend, track }) => {
    const fail = () => Promise.reject(reason);
    if (stage === "persist") store.onPersist = fail;
    if (stage === "flush") store.onFlush = fail;
    if (stage === "close") store.onClose = fail;
    writes(backend);
    const closing = track(backend.close());
    expect(await rejection(closing)).toBe(reason);
    expect(store.events.filter((event) => event === "close")).toHaveLength(
      stage === "close" ? 1 : 0,
    );
    const repeated = track(backend.close());
    expect(repeated).toBe(closing);
    expect(await rejection(repeated)).toBe(reason);
    expect(store.events.filter((event) => event === "persist")).toHaveLength(1);
    expect(store.events.filter((event) => event === "close")).toHaveLength(
      stage === "close" ? 1 : 0,
    );
  });
}

for (const stage of ["persist", "flush", "close"] as const)
  test.each(reasons)(`final ${stage} preserves rejection %p without retry or release`, (reason) =>
    failsOnce(stage, reason),
  );

test("close joins the final persist and returns its exact promise before storage callbacks", async () => {
  await withBackend(async ({ store, backend, gate, track, reopen }) => {
    const save = gate();
    const nested: Promise<void>[] = [];
    store.onPersist = () => {
      nested.push(track(backend.close()));
      return save.wait();
    };
    writes(backend);
    const closing = track(backend.close());
    const repeated = track(backend.close());
    await save.entered.promise;
    expect(repeated).toBe(closing);
    expect(nested).toEqual([closing]);
    expect(store.events).toEqual(["persist"]);
    store.onPersist = undefined;
    save.released.resolve();
    await closing;
    expect(track(backend.close())).toBe(closing);
    expect(store.events).toEqual(["persist", "flush", "close"]);
    const restored = await reopen();
    await restored.prepare("readFile", ["/saved"]);
    expect(restored.execute("readFile", ["/saved"], new Uint8Array())).toEqual(encode("saved"));
  });
});

test("terminal cutoff rejects external work synchronously before the final callback", async () => {
  await withBackend(async ({ store, backend, gate, track }) => {
    const save = gate();
    store.onPersist = () => save.wait();
    writes(backend);
    const closing = track(backend.close());
    expect(() => writes(backend, "/late")).toThrow(closedPersistence);
    expect(() => backend.prepare("readFile", ["/saved"])).toThrow(closedPersistence);
    await expect(track(backend.flush())).rejects.toThrow(closedPersistence);
    await expect(track(backend.checkpoint())).rejects.toThrow(closedPersistence);
    await save.entered.promise;
    expect(backend.fs.lookup("/late")).toBeUndefined();
    save.released.resolve();
    await closing;
    expect(store.events).toEqual(["persist", "flush", "close"]);
  });
});

test("dispose cannot invalidate a pending terminal save", async () => {
  await withBackend(async ({ store, backend, gate, track }) => {
    const save = gate();
    store.onPersist = () => save.wait();
    writes(backend);
    const closing = track(backend.close());
    await save.entered.promise;
    backend.dispose();
    save.released.resolve();
    await closing;
    expect(store.events).toEqual(["persist", "flush", "close"]);
  });
});

test("close joins an already-started unchanged flush before final save or release", async () => {
  await withBackend(async ({ store, backend, gate, track }) => {
    writes(backend);
    await backend.checkpoint();
    const barrier = gate();
    store.onFlush = () => barrier.wait();
    const saving = track(backend.flush());
    await barrier.entered.promise;
    store.onFlush = undefined;
    const closing = track(backend.close());
    await new Promise<void>((done) => setImmediate(done));
    expect(store.events).toEqual(["persist", "flush"]);
    barrier.released.resolve();
    await Promise.all([saving, closing]);
    expect(store.events).toEqual(["persist", "flush", "flush", "close"]);
  });
});

test("an admitted flush failure cannot be replaced by a successful final sibling", async () => {
  await withBackend(async ({ store, backend, gate, track }) => {
    writes(backend);
    await backend.checkpoint();
    const barrier = gate();
    const failure = new Error("original admitted flush failed");
    store.onFlush = async () => {
      await barrier.wait();
      throw failure;
    };
    const saving = track(backend.flush());
    await barrier.entered.promise;
    store.onFlush = undefined;
    const closing = track(backend.close());
    barrier.released.resolve();
    expect(await rejection(saving)).toBe(failure);
    expect(await rejection(closing)).toBe(failure);
    expect(store.events).toEqual(["persist", "flush"]);
  });
});

test("close joins every admitted sibling even when the first one rejects", async () => {
  await withBackend(async ({ store, backend, gate, track }) => {
    writes(backend);
    await backend.checkpoint();
    const first = gate();
    const second = gate();
    const failure = new Error("first barrier failed");
    store.onFlush = async () => {
      await first.wait();
      throw failure;
    };
    const earlier = track(backend.flush());
    await first.entered.promise;
    store.onFlush = () => second.wait();
    const later = track(backend.flush());
    await second.entered.promise;
    store.onFlush = undefined;
    const closing = track(backend.close());
    let settled = false;
    void closing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    first.released.resolve();
    await rejection(earlier);
    await new Promise<void>((done) => setImmediate(done));
    expect(settled).toBe(false);
    expect(store.events.includes("close")).toBe(false);
    second.released.resolve();
    await later;
    expect(await rejection(closing)).toBe(failure);
  });
});

test("close joins a cold read already inside storage", async () => {
  await withBackend(async ({ store, backend, gate, track, reopen }) => {
    writes(backend);
    await backend.flush();
    backend.dispose();
    const cold = await reopen();
    const reading = gate();
    store.onRead = () => reading.wait();
    const preparing = cold.prepare("readFile", ["/saved"]);
    if (!preparing) throw new Error("cold preparation did not start");
    track(preparing);
    await reading.entered.promise;
    const closing = track(cold.close());
    await new Promise<void>((done) => setImmediate(done));
    expect(store.events.includes("close")).toBe(false);
    reading.released.resolve();
    await Promise.all([preparing, closing]);
    expect(store.events.at(-1)).toBe("close");
  });
});

test("normal live explicit retry succeeds before a later terminal close", async () => {
  await withBackend(async ({ store, backend, track }) => {
    const failure = new Error("live persist failed");
    store.onPersist = () => Promise.reject(failure);
    writes(backend);
    expect(await rejection(track(backend.flush()))).toBe(failure);
    store.onPersist = undefined;
    await backend.flush();
    await track(backend.close());
    expect(store.events).toEqual(["persist", "persist", "flush", "flush", "close"]);
  });
});

test("close cancels the interval and queued timer callbacks cannot append work", async () => {
  const schedule = spyOn(globalThis, "setInterval");
  const cancel = spyOn(globalThis, "clearInterval");
  try {
    await withBackend(async ({ store, backend, gate, track }) => {
      const callback = schedule.mock.calls.at(-1)?.[0];
      if (typeof callback !== "function") throw new Error("missing interval callback");
      const save = gate();
      store.onPersist = () => save.wait();
      writes(backend);
      const closing = track(backend.close());
      expect(cancel).toHaveBeenCalledTimes(1);
      callback();
      await save.entered.promise;
      expect(store.events).toEqual(["persist"]);
      save.released.resolve();
      await closing;
      expect(store.events).toEqual(["persist", "flush", "close"]);
    }, 60_000);
  } finally {
    schedule.mockRestore();
    cancel.mockRestore();
  }
});
