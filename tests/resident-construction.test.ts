import { expect, spyOn, test } from "bun:test";
import { createPersistentResidentOwner } from "../browser/persistent-resident-owner";
import { MemoryBackend } from "../fs/backend";
import { MemoryBudget, type MemoryAllocator, type MemoryBackingSpec } from "../fs/memory-budget";
import { FilesystemService } from "../fs/service";
import type { FilesystemConnection } from "../fs/protocol";
import { publicationBufferPlan } from "../fs/publication";
import { OPFS_FORMAT } from "../fs/vfs-format";
import { identityOpfsFixture } from "./fixtures/durable-identity-opfs";

const MiB = 1024 * 1024;
const limits = {
  sessions: 16,
  operations: 16,
  inputBytes: 64,
  argumentBytes: 512,
  effectBytes: 4096,
  effects: 16,
  resultBytes: 256,
  logRecords: 8,
  logBytes: 32768,
  pins: 2,
  pinBytes: 256,
};
function memory(
  bytes = 64 * MiB,
  allocator?: MemoryAllocator,
  producers = { allocations: 128, references: 256, leases: 16 },
) {
  return new MemoryBudget(
    {
      bytes,
      producers,
      progress: { bytes: 0, allocations: 0, references: 0, leases: 0 },
      waiters: 0,
      serialLimit: Number.MAX_SAFE_INTEGER,
    },
    allocator,
  );
}
function environment() {
  const keys = ["location", "navigator", "FileSystemFileHandle"];
  const originals = keys.map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  const native = identityOpfsFixture();
  const held = new Set<string>();
  const releases: string[] = [];
  const opened = Promise.withResolvers<void>();
  const releaseOpen = Promise.withResolvers<void>();
  let blockOpen = false;
  const values = {
    location: { origin: "https://construction.test" },
    FileSystemFileHandle: class {
      createSyncAccessHandle() {}
    },
    navigator: {
      storage: {
        async getDirectory() {
          opened.resolve();
          if (blockOpen) await releaseOpen.promise;
          return native.root;
        },
      },
      locks: {
        async request(name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) {
          held.add(name);
          try {
            return await callback({ name, mode: options.mode ?? "exclusive" });
          } finally {
            held.delete(name);
            releases.push(name);
          }
        },
      },
    },
  };
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  return {
    native,
    held,
    releases,
    opened: opened.promise,
    block() {
      blockOpen = true;
    },
    unblock() {
      releaseOpen.resolve();
    },
    owner(budget: MemoryBudget, publicationLimits = limits) {
      return createPersistentResidentOwner(
        {
          kind: "initial-open",
          runtimeLifetime: "construction",
          attempt: crypto.randomUUID(),
          selected: {
            origin: values.location.origin,
            name: "resident",
            implementation: "opfs-memory",
            format: OPFS_FORMAT,
          },
          publication: { limits: publicationLimits },
        },
        new AbortController().signal,
        undefined,
        budget,
      );
    },
    restore() {
      releaseOpen.resolve();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test("resident constructor is pure and allocation waits for guarded open", async () => {
  const env = environment();
  const original = globalThis.SharedArrayBuffer;
  let allocations = 0;
  const intercepted = new Proxy(original, {
    construct(target, args) {
      allocations++;
      return Reflect.construct(target, args);
    },
  });
  Object.defineProperty(globalThis, "SharedArrayBuffer", {
    configurable: true,
    value: intercepted,
  });
  let owner: ReturnType<typeof env.owner> | undefined;
  try {
    owner = env.owner(memory());
    void owner.ready.catch(() => {});
    expect(allocations).toBe(0);
  } finally {
    Object.defineProperty(globalThis, "SharedArrayBuffer", { configurable: true, value: original });
    await owner?.stop();
    env.restore();
  }
});

test("resident real factory refuses an individually fitting root plus fixed bundle before excess allocation", async () => {
  const env = environment();
  const allocator = controlledAllocator();
  const budget = memory(exactCapacity() - 1, allocator);
  const before = budget.snapshot();
  const owner = env.owner(budget);
  const result = owner.ready.catch((error: unknown) => error);
  try {
    const outcome = await result;
    expect(outcome).toMatchObject({ code: "capacity" });
    expect(allocator.specs).toHaveLength(0);
    await owner.stop();
    expect(budget.snapshot().allocated).toBe(before.allocated);
    expect(budget.snapshot().obligations).toBe(0);
    expect(env.held.size).toBe(0);
  } finally {
    await owner.stop();
    env.restore();
  }
});

for (const producers of [
  { allocations: 82, references: 83, leases: 2 },
  { allocations: 83, references: 82, leases: 2 },
  { allocations: 83, references: 83, leases: 1 },
]) {
  test(`resident refuses insufficient holding records before allocation ${JSON.stringify(producers)}`, async () => {
    const env = environment();
    const allocator = controlledAllocator();
    const budget = memory(64 * MiB, allocator, producers);
    const before = budget.snapshot();
    const owner = env.owner(budget);
    try {
      await expect(owner.ready).rejects.toMatchObject({ code: "capacity" });
      await owner.stop();
      expect(allocator.specs).toHaveLength(0);
      expect(budget.snapshot().allocated).toBe(before.allocated);
      expect(budget.snapshot().producerFree).toEqual(before.producerFree);
      expect(budget.snapshot().obligations).toBe(0);
      expect(env.held.size).toBe(0);
    } finally {
      await owner.stop();
      env.restore();
    }
  });
}

test("resident retains all 83 allocation/reference records and two holding leases after close", async () => {
  const env = environment();
  const allocator = controlledAllocator();
  const budget = memory(64 * MiB, allocator, { allocations: 83, references: 83, leases: 2 });
  const before = budget.snapshot();
  const owner = env.owner(budget);
  try {
    await owner.ready;
    expect(allocator.specs).toHaveLength(82);
    expect(budget.snapshot().backingBytes - before.backingBytes).toBe(23_182_280);
    expect(budget.snapshot().allocated - before.allocated).toBe(23_182_792);
    expect(budget.snapshot().producerFree).toEqual({ allocations: 0, references: 0, leases: 0 });
    expect(budget.snapshot().obligations).toBe(0);
    const published = budget.snapshot();
    await owner.stop();
    expect(budget.snapshot()).toEqual(published);
    expect(env.held.size).toBe(0);
  } finally {
    await owner.stop();
    env.restore();
  }
});

test("cloning a budget does not transfer construction authority", () => {
  const env = environment();
  const allocator = controlledAllocator();
  const budget = memory(64 * MiB, allocator);
  try {
    expect(() => env.owner(structuredClone(budget))).toThrow("realm-local memory budget required");
    expect(allocator.specs).toHaveLength(0);
    expect(env.held.size).toBe(0);
  } finally {
    env.restore();
  }
});

function rootCharge(): number {
  const budget = memory();
  const before = budget.snapshot().allocated;
  new MemoryBackend(undefined, undefined, budget);
  return budget.snapshot().allocated - before;
}
const fixedBytes =
  262144 +
  49156 +
  16 +
  65536 +
  limits.sessions * 8 +
  44 +
  limits.sessions * 16 +
  limits.operations * 36 +
  limits.operations * (limits.argumentBytes + limits.inputBytes) +
  limits.operations * limits.resultBytes +
  limits.logRecords * 12 +
  limits.logBytes +
  limits.pins * 12 +
  limits.pinBytes +
  4096 * 12;
const startupCharge = rootCharge();
function exactCapacity() {
  return memory().snapshot().allocated + startupCharge + fixedBytes;
}
function controlledAllocator(before?: (spec: MemoryBackingSpec, index: number) => void) {
  const specs: MemoryBackingSpec[] = [];
  return {
    specs,
    allocate(spec: MemoryBackingSpec) {
      specs.push(spec);
      before?.(spec, specs.length);
      if (spec.kind !== "shared") throw new Error("unexpected private array backing");
      const buffer: unknown = Reflect.construct(SharedArrayBuffer, [
        spec.bytes,
        { maxByteLength: spec.maximum },
      ]);
      if (!(buffer instanceof SharedArrayBuffer)) throw new Error("unexpected allocation result");
      return buffer;
    },
    grow() {
      throw new Error("construction must not grow backing");
    },
  };
}

test("resident real open borrows one physical backend root and charges the whole observed fixed bundle", async () => {
  const env = environment();
  const allocator = controlledAllocator();
  const budget = memory(exactCapacity(), allocator);
  const before = budget.snapshot();
  const captured: { backend?: MemoryBackend } = {};
  let connection: FilesystemConnection | undefined;
  const original = MemoryBackend.prototype.attachShared;
  const attach = spyOn(MemoryBackend.prototype, "attachShared").mockImplementation(function (
    this: MemoryBackend,
    ...args
  ) {
    if (!captured.backend) {
      captured.backend = this;
      expect(args[0]).toBe(this.shared.buffer);
    }
    return Reflect.apply(original, this, args);
  });
  const connectOriginal = FilesystemService.prototype.connect;
  const connect = spyOn(FilesystemService.prototype, "connect").mockImplementation(function (
    this: FilesystemService,
    value,
  ) {
    connection = value;
    return Reflect.apply(connectOriginal, this, [value]);
  });
  const owner = env.owner(budget);
  try {
    await owner.ready;
    const backend = captured.backend;
    if (!backend || !connection || !connection.publication)
      throw new Error("real pair not captured");
    const admittedConnection = connection;
    const arena = connection.publication.buffers;
    const backing = [
      connection.shared,
      connection.ownerStates,
      connection.capabilities,
      connection.epoch,
      connection.signal,
      connection.sections,
    ].concat(
      connection.segments,
      connection.revocations,
      Object.values(arena).filter((value) => value instanceof SharedArrayBuffer),
    );
    expect(new Set(backing).size).toBe(82);
    expect(allocator.specs).toHaveLength(82);
    expect(allocator.specs.filter((spec) => spec.bytes > MiB)).toHaveLength(1);
    expect(allocator.specs.filter((spec) => spec.bytes === 0)).toHaveLength(63);
    expect(arena.pageReaders?.byteLength).toBe(65536);
    expect(arena.readerLifetimes?.byteLength).toBe(limits.sessions * 8);
    expect(arena.versions.byteLength).toBe(49152);
    expect(budget.snapshot().backingBytes - before.backingBytes).toBe(
      backing.reduce((sum, buffer) => sum + buffer.byteLength, 0),
    );
    expect(budget.snapshot().allocated).toBe(budget.snapshot().limit);
    expect(budget.snapshot().obligations).toBe(0);
    expect(before.producerFree.allocations - budget.snapshot().producerFree.allocations).toBe(83);
    expect(before.producerFree.references - budget.snapshot().producerFree.references).toBe(83);
    expect(before.producerFree.leases - budget.snapshot().producerFree.leases).toBe(2);
    const alias = new MemoryBackend(undefined, undefined, backend);
    const cloned = structuredClone(connection.shared);
    alias.attachShared(cloned, connection.maxBytes, connection.segments, arena);
    backend.attachShared(cloned, connection.maxBytes, connection.segments, arena);
    expect(() =>
      alias.attachShared(
        new SharedArrayBuffer(cloned.byteLength),
        admittedConnection.maxBytes,
        admittedConnection.segments,
        arena,
      ),
    ).toThrow();
    expect(allocator.specs).toHaveLength(82);
    const published = budget.snapshot();
    await owner.stop();
    expect(budget.snapshot()).toEqual(published);
    expect(new Int32Array(cloned)[0]).toBe(new Int32Array(connection.shared)[0]);
    expect(env.held.size).toBe(0);
    expect(env.native.events.filter((event) => event.startsWith("close:")).length).toBeGreaterThan(
      0,
    );
  } finally {
    await owner.stop();
    attach.mockRestore();
    connect.mockRestore();
    env.restore();
  }
});

for (let failedAt = 1; failedAt <= 82; failedAt++) {
  test(`resident construction rolls back private fixed backing after allocator failure ${failedAt}`, async () => {
    const env = environment();
    const failure = new Error(`allocation-${failedAt}`);
    const allocator = controlledAllocator((_spec, index) => {
      if (index === failedAt) throw failure;
    });
    const budget = memory(exactCapacity(), allocator);
    const before = budget.snapshot();
    const owner = env.owner(budget);
    try {
      await expect(owner.ready).rejects.toBe(failure);
      await owner.stop();
      expect(allocator.specs).toHaveLength(failedAt);
      expect(budget.snapshot().allocated).toBe(
        before.allocated + (failedAt === 1 ? 0 : startupCharge),
      );
      expect(budget.snapshot().obligations).toBe(0);
      expect(budget.snapshot().producerFree.allocations).toBe(
        before.producerFree.allocations - (failedAt === 1 ? 0 : 2),
      );
      expect(env.held.size).toBe(0);
    } finally {
      await owner.stop();
      env.restore();
    }
  });
}

test("every construction allocator reentry sees reserved capacity and cannot admit another byte", async () => {
  const env = environment();
  const allocator = controlledAllocator(() => {
    const before = budget.snapshot();
    expect(budget.tryOperation({ bytes: 1, allocations: 1, references: 1, leases: 0 }).kind).toBe(
      "pressure",
    );
    expect(budget.snapshot()).toEqual(before);
  });
  const budget: MemoryBudget = memory(exactCapacity(), allocator);
  const owner = env.owner(budget);
  try {
    await owner.ready;
    expect(allocator.specs).toHaveLength(82);
  } finally {
    await owner.stop();
    env.restore();
  }
});

test("service attachment failure retains published raw aliases and repeated attempts reuse the same authority", async () => {
  const env = environment();
  const allocator = controlledAllocator();
  const budget = memory(exactCapacity(), allocator);
  const failure = new Error("service attach failed after exposure");
  let raw: FilesystemConnection | undefined;
  const connect = spyOn(FilesystemService.prototype, "connect").mockImplementation((value) => {
    raw = value;
    throw failure;
  });
  const owner = env.owner(budget);
  let second: ReturnType<typeof env.owner> | undefined;
  try {
    await expect(owner.ready).rejects.toBe(failure);
    await owner.stop();
    expect(raw?.publication?.buffers.pageReaders).toBeInstanceOf(SharedArrayBuffer);
    const retained = budget.snapshot();
    expect(retained.allocated).toBe(retained.limit);
    second = env.owner(budget);
    await expect(second.ready).rejects.toMatchObject({ code: "capacity" });
    await second.stop();
    expect(allocator.specs).toHaveLength(82);
    expect(budget.snapshot().allocated).toBe(retained.allocated);
    expect(budget.snapshot().obligations).toBe(0);
    expect(env.held.size).toBe(0);
  } finally {
    await second?.stop();
    await owner.stop();
    connect.mockRestore();
    env.restore();
  }
});

test("stopping guarded native opening joins completion without late construction or early guard release", async () => {
  const env = environment();
  env.block();
  const allocator = controlledAllocator();
  const budget = memory(exactCapacity(), allocator);
  const before = budget.snapshot();
  const owner = env.owner(budget);
  const ready = owner.ready.catch((error: unknown) => error);
  let ended = false;
  try {
    await env.opened;
    const stopped = owner.stop().then(() => {
      ended = true;
    });
    expect(await ready).toMatchObject({ errno: 11 });
    await Promise.resolve();
    expect(ended).toBe(false);
    expect(env.held.size).toBe(3);
    expect(env.releases).toHaveLength(0);
    env.unblock();
    await stopped;
    expect(allocator.specs).toHaveLength(1);
    expect(budget.snapshot().allocated).toBe(before.allocated + startupCharge);
    expect(budget.snapshot().obligations).toBe(0);
    expect(env.held.size).toBe(0);
  } finally {
    env.unblock();
    await owner.stop();
    env.restore();
  }
});

for (const stopAt of [1, 2, 65, 67, 78, 82]) {
  test(`stopping inside allocator ${stopAt} prevents further fixed allocation and late ready`, async () => {
    const env = environment();
    const allocator = controlledAllocator((_spec, index) => {
      if (index === stopAt) void owner.stop();
    });
    const budget = memory(exactCapacity(), allocator);
    const before = budget.snapshot();
    const owner: ReturnType<typeof env.owner> = env.owner(budget);
    try {
      await expect(owner.ready).rejects.toMatchObject({ errno: 11 });
      await owner.stop();
      expect(allocator.specs).toHaveLength(stopAt);
      expect(budget.snapshot().allocated).toBe(before.allocated + startupCharge);
      expect(budget.snapshot().obligations).toBe(0);
      expect(env.held.size).toBe(0);
    } finally {
      await owner.stop();
      env.restore();
    }
  });
}

test("pure validation covers reader multiplication before native open or any construction allocation", () => {
  const env = environment();
  const allocator = controlledAllocator();
  const budget = memory(exactCapacity(), allocator);
  try {
    const invalid = { ...limits, sessions: 0x7ffffffe, operations: 1 };
    expect(() => env.owner(budget, invalid)).toThrow(RangeError);
    expect(allocator.specs).toHaveLength(0);
    expect(env.held.size).toBe(0);
    expect(() => publicationBufferPlan(invalid, true)).toThrow(RangeError);
  } finally {
    env.restore();
  }
});

test("failed client port startup closes both private ports and refunds only the fixed bundle", async () => {
  const env = environment();
  const budget = memory(exactCapacity());
  const before = budget.snapshot();
  const failure = new Error("client port start failed");
  const closed = new Set<MessagePort>();
  const closeOriginal = MessagePort.prototype.close;
  const close = spyOn(MessagePort.prototype, "close").mockImplementation(function (
    this: MessagePort,
  ) {
    closed.add(this);
    Reflect.apply(closeOriginal, this, []);
  });
  const start = spyOn(MessagePort.prototype, "start").mockImplementationOnce(() => {
    throw failure;
  });
  const owner = env.owner(budget);
  try {
    await expect(owner.ready).rejects.toBe(failure);
    await owner.stop();
    expect(closed.size).toBe(2);
    for (const port of closed) expect(port.onmessage).toBeNull();
    expect(budget.snapshot().allocated).toBe(before.allocated + startupCharge);
    expect(budget.snapshot().obligations).toBe(0);
    expect(env.held.size).toBe(0);
  } finally {
    await owner.stop();
    start.mockRestore();
    close.mockRestore();
    env.restore();
  }
});

test("failed service attachment after registration joins its actual session before closing ports", async () => {
  const env = environment();
  const budget = memory(exactCapacity());
  const failure = new Error("connect failed after actual session registration");
  const closed = new Set<MessagePort>();
  const closeOriginal = MessagePort.prototype.close;
  const close = spyOn(MessagePort.prototype, "close").mockImplementation(function (
    this: MessagePort,
  ) {
    closed.add(this);
    Reflect.apply(closeOriginal, this, []);
  });
  const original = FilesystemService.prototype.connect;
  const connect = spyOn(FilesystemService.prototype, "connect").mockImplementation(function (
    this: FilesystemService,
    connection,
  ) {
    Reflect.apply(original, this, [connection]);
    throw failure;
  });
  const owner = env.owner(budget);
  try {
    await expect(owner.ready).rejects.toBe(failure);
    await owner.stop();
    expect(closed.size).toBe(2);
    expect(budget.snapshot().allocated).toBe(budget.snapshot().limit);
    expect(budget.snapshot().obligations).toBe(0);
    expect(env.held.size).toBe(0);
  } finally {
    await owner.stop();
    connect.mockRestore();
    close.mockRestore();
    env.restore();
  }
});

for (const failedAt of [1, 65]) {
  test(`retry after allocator failure ${failedAt} never creates a replacement authority`, async () => {
    const env = environment();
    const failure = new Error("first attempt allocation failure");
    const allocator = controlledAllocator((_spec, index) => {
      if (index === failedAt) throw failure;
    });
    const budget = memory(exactCapacity(), allocator);
    const owner = env.owner(budget);
    let second: ReturnType<typeof env.owner> | undefined;
    try {
      await expect(owner.ready).rejects.toBe(failure);
      await owner.stop();
      second = env.owner(budget);
      if (failedAt === 1) await second.ready;
      else await expect(second.ready).rejects.toMatchObject({ code: "capacity" });
      await second.stop();
      expect(allocator.specs).toHaveLength(failedAt === 1 ? 83 : failedAt);
      expect(budget.snapshot().obligations).toBe(0);
      expect(env.held.size).toBe(0);
    } finally {
      await second?.stop();
      await owner.stop();
      env.restore();
    }
  });
}
