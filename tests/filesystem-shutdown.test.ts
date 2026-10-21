import { expect, test } from "bun:test";
import {
  connectFilesystemIdentity,
  createFilesystemConnection,
  createProcessFilesystemIdentity,
  FilesystemClient,
  FilesystemService,
  MemoryBackend,
} from "../fs";
import {
  CAPABILITY_LENGTH,
  FilesystemSection,
  HEADER,
  isRevoked,
  pack,
  reapFilesystem,
  releaseFilesystemReservation,
  revokeFilesystem,
  State,
} from "../fs/protocol";
import { installFilesystemWorker } from "../fs/service";
import type { FilesystemBackend } from "../fs/backend";
import { SLOT_WORDS } from "../fs/shared";

class ClosingBackend extends MemoryBackend {
  closes = 0;
  readonly pins = new Map<number, number>();
  onPrepare: FilesystemBackend["prepare"];
  onFlush: FilesystemBackend["flush"];
  onClose: (() => Promise<void>) | undefined;
  onRelease: ((handle: number) => void) | undefined;
  retain(handle: number): void {
    super.retain(handle);
    this.pins.set(handle, (this.pins.get(handle) ?? 0) + 1);
  }
  release(handle: number): void {
    this.onRelease?.(handle);
    super.release(handle);
    const remaining = this.pins.get(handle)! - 1;
    if (remaining) this.pins.set(handle, remaining);
    else this.pins.delete(handle);
  }
  prepare(...args: Parameters<NonNullable<FilesystemBackend["prepare"]>>): void | Promise<void> {
    return this.onPrepare?.(...args);
  }
  flush(target?: number | string): Promise<void> {
    return this.onFlush?.(target) ?? Promise.resolve();
  }
  close(): Promise<void> {
    this.closes++;
    return this.onClose?.() ?? Promise.resolve();
  }
}

async function checkpoint(): Promise<void> {
  const channel = new MessageChannel();
  try {
    await new Promise<void>((resolve) => {
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(null);
    });
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
}

test("shutdown joins the original section before backend close", async () => {
  const backend = new ClosingBackend();
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection();
  const section = new FilesystemSection(pair.client);
  let held = false;
  let stopping: Promise<void> | undefined;
  try {
    service.connect(pair.server);
    section.enter();
    held = true;
    stopping = service.shutdown();
    await checkpoint();
    expect(backend.closes).toBe(0);
  } finally {
    if (held) section.exit();
    try {
      await stopping;
    } finally {
      pair.client.port.close();
      pair.server.port.close();
      service.dispose();
    }
  }
  expect(backend.closes).toBe(1);
});

function gate() {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  return {
    started: started.promise,
    resolve: () => release.resolve(),
    reject: (error: unknown) => release.reject(error),
    run() {
      started.resolve();
      return release.promise;
    },
  };
}

function outcome<T>(done: Promise<T>): Promise<PromiseSettledResult<T>> {
  return done.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );
}

async function expectPending(done: Promise<unknown>): Promise<void> {
  let settled = false;
  void done.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await checkpoint();
  expect(settled).toBe(false);
}

function fixture() {
  const backend = new ClosingBackend();
  const service = new FilesystemService(backend);
  const root = createFilesystemConnection();
  const releases: (() => void)[] = [];
  const joins: Promise<unknown>[] = [];
  const connections = [root];
  let client: FilesystemClient | undefined;
  const owned = {
    backend,
    service,
    root,
    releases,
    joins,
    connections,
    async close() {
      for (const release of releases) release();
      await Promise.allSettled(joins);
      client?.dispose();
      service.dispose();
      for (const connection of connections) {
        connection.client.port.close();
        connection.server.port.close();
      }
      // Failed shutdown deliberately retains its owner. The fixture alone owns these
      // memory pins; releasing them here is teardown, never a successful service drain.
      releaseFixturePins(backend);
    },
    connect() {
      service.connect(root.server);
      client = new FilesystemClient(root.client);
      return client;
    },
  };
  return owned;
}

test("shutdown waits for an independently connected child's distinct section", async () => {
  const owned = fixture();
  const child = connectFilesystemIdentity(createProcessFilesystemIdentity(owned.root.client));
  owned.connections.push(child);
  const section = new FilesystemSection(child.client);
  let held = false;
  owned.releases.push(() => {
    if (held) section.exit();
    held = false;
  });
  try {
    owned.connect();
    owned.service.connect(child.server);
    section.enter();
    held = true;
    const stopping = owned.service.shutdown();
    owned.joins.push(stopping);
    expect(isRevoked(owned.root.client)).toBe(true);
    expect(isRevoked(child.client)).toBe(true);
    await expectPending(stopping);
    expect(owned.backend.closes).toBe(0);
    section.exit();
    held = false;
    await stopping;
    expect(owned.backend.closes).toBe(1);
  } finally {
    await owned.close();
  }
});

for (const operation of ["prepare", "flush", "sync"] as const)
  test(`shutdown joins an admitted ${operation} and its continuation`, async () => {
    const owned = fixture();
    const held = gate();
    owned.releases.push(held.resolve);
    try {
      const client = owned.connect();
      const directory: number = await client.asyncCall("preopen", ["/"]);
      let prepares = 0;
      owned.backend.onPrepare = () => {
        prepares++;
        return held.run();
      };
      owned.backend.onFlush = () => held.run();
      const request = outcome(
        client.asyncCall(
          operation === "prepare" ? "listFiles" : operation,
          operation === "prepare" ? ["/"] : operation === "sync" ? [directory] : [],
        ),
      );
      owned.joins.push(request);
      await held.started;
      const stopping = owned.service.shutdown();
      owned.joins.push(stopping);
      owned.service.dispose();
      owned.service.sweep();
      await expectPending(stopping);
      expect(owned.backend.closes).toBe(0);
      held.resolve();
      await stopping;
      expect(owned.backend.closes).toBe(1);
      expect(prepares).toBe(operation === "prepare" ? 1 : 0);
      expect(await request).toMatchObject({ status: "rejected", reason: { errno: 11 } });
      expect(owned.service.resources().clients).toBe(0);
    } finally {
      await owned.close();
    }
  });

test("shutdown retains a cold preparation after initiating dispose removed its session", async () => {
  const owned = fixture();
  const held = gate();
  owned.releases.push(held.resolve);
  try {
    const client = owned.connect();
    owned.backend.onPrepare = () => held.run();
    const request = outcome(client.asyncCall("listFiles", ["/"]));
    owned.joins.push(request);
    await held.started;
    owned.service.dispose();
    expect(owned.service.resources().clients).toBe(0);
    const stopping = owned.service.shutdown();
    owned.joins.push(stopping);
    await expectPending(stopping);
    held.resolve();
    await stopping;
    expect(owned.backend.closes).toBe(1);
  } finally {
    await owned.close();
  }
});

test("shutdown owns the returned preparation when prepare reenters synchronously", async () => {
  const owned = fixture();
  const held = gate();
  let reentered: Promise<void> | undefined;
  owned.releases.push(held.resolve);
  try {
    const client = owned.connect();
    owned.backend.onPrepare = () => {
      const stopping = owned.service.shutdown();
      owned.joins.push(stopping);
      reentered = stopping;
      return held.run();
    };
    const request = outcome(client.asyncCall("listFiles", ["/"]));
    owned.joins.push(request);
    await held.started;
    const stopping = owned.service.shutdown();
    await expectPending(stopping);
    held.resolve();
    expect(reentered).toBe(stopping);
    await stopping;
    expect(owned.backend.closes).toBe(1);
  } finally {
    await owned.close();
  }
});

test("late request traffic cancels and wakes without new backend work", async () => {
  const owned = fixture();
  const section = new FilesystemSection(owned.root.client);
  let held = false;
  owned.releases.push(() => {
    if (held) section.exit();
    held = false;
  });
  try {
    owned.connect();
    section.enter();
    held = true;
    const stopping = owned.service.shutdown();
    owned.joins.push(stopping);
    let prepares = 0;
    owned.backend.onPrepare = () => {
      prepares++;
    };
    const input = pack({ operation: "listFiles", args: ["/"] });
    const buffer = new SharedArrayBuffer(HEADER + 1024);
    const cells = new Int32Array(buffer, 0, HEADER / 4);
    cells[1] = input.length;
    new Uint8Array(buffer, HEADER).set(input);
    const completion = Promise.withResolvers<void>();
    owned.root.client.port.onmessage = ({ data }: MessageEvent<{ completed?: number }>) => {
      if (data.completed === 9001) completion.resolve();
    };
    const signal = Atomics.load(new Int32Array(owned.root.client.signal), 0);
    owned.root.client.port.postMessage({ trim: true });
    owned.root.client.port.postMessage({ sweep: true });
    owned.root.client.port.postMessage({ id: 9001, buffer });
    await completion.promise;
    expect(cells[0]).toBe(State.Cancelled);
    expect(cells[6]).toBe(1);
    expect(Atomics.load(new Int32Array(owned.root.client.signal), 0)).toBeGreaterThan(signal);
    expect(prepares).toBe(0);
    expect(owned.backend.closes).toBe(0);
    section.exit();
    held = false;
    await stopping;
  } finally {
    await owned.close();
  }
});

async function reserveFile(owned: ReturnType<typeof fixture>) {
  const client = owned.connect();
  await client.asyncCall("writeFile", ["/file"], new Uint8Array([1]));
  const directory: number = await client.asyncCall("preopen", ["/"]);
  const path: { node: number; parent: number } = await client.asyncCall("resolve", [
    directory,
    "file",
  ]);
  client.retain(path.node);
  const identity = createProcessFilesystemIdentity(client.connection);
  const reservation = client.reserve(path.node, identity);
  owned.releases.push(() => releaseFilesystemReservation(reservation));
  client.release(path.node);
  await client.asyncCall("removePath", [path, false]);
  return { client, identity, reservation, handle: path.node };
}

test("unpublished source transfer pins refuse close and preserve the original failure", async () => {
  const owned = fixture();
  try {
    const { reservation, handle } = await reserveFile(owned);
    const stopping = owned.service.shutdown();
    owned.joins.push(outcome(stopping));
    const result = await outcome(stopping);
    expect(result).toMatchObject({ status: "rejected", reason: { errno: 6 } });
    expect(owned.backend.closes).toBe(0);
    expect(owned.backend.pins.get(handle)).toBe(1);
    expect(Atomics.load(new Int32Array(reservation.state), 1)).toBe(0);
    releaseFilesystemReservation(reservation);
    owned.service.sweep();
    owned.service.dispose();
    expect(owned.service.shutdown()).toBe(stopping);
    expect(await outcome(stopping)).toEqual(result);
    expect(owned.backend.closes).toBe(0);
  } finally {
    await owned.close();
  }
});

test("late connect preserves its known source reservation without adopting a new session", async () => {
  const owned = fixture();
  try {
    const { identity, reservation, handle } = await reserveFile(owned);
    const child = connectFilesystemIdentity(identity);
    owned.connections.push(child);
    const stopping = owned.service.shutdown();
    owned.joins.push(outcome(stopping));
    expect(() => owned.service.connect(child.server)).toThrow();
    expect(isRevoked(child.client)).toBe(true);
    expect(owned.service.resources().clients).toBe(1);
    expect(Atomics.load(new Int32Array(reservation.state), 1)).toBe(0);
    expect(await outcome(stopping)).toMatchObject({ status: "rejected" });
    expect(owned.backend.pins.get(handle)).toBe(1);
    expect(owned.backend.closes).toBe(0);
  } finally {
    await owned.close();
  }
});

test("late foreign reservation is retained and refused without changing its source table", async () => {
  const owned = fixture();
  const foreign = fixture();
  try {
    owned.connect();
    const { identity, reservation } = await reserveFile(foreign);
    const offered = connectFilesystemIdentity(identity);
    owned.connections.push(offered);
    const source = new Int32Array(reservation.source, 0, CAPABILITY_LENGTH);
    const before = Atomics.load(source, reservation.sourceKey + 2);
    const stopping = owned.service.shutdown();
    owned.joins.push(outcome(stopping));
    expect(() => owned.service.connect(offered.server)).toThrow();
    expect(Atomics.load(source, reservation.sourceKey + 2)).toBe(before);
    expect(Atomics.load(new Int32Array(reservation.state), 1)).toBe(0);
    expect(await outcome(stopping)).toMatchObject({ status: "rejected", reason: { errno: 6 } });
    expect(owned.backend.closes).toBe(0);
  } finally {
    await owned.close();
    await foreign.close();
  }
});

for (const reason of [undefined, null, false, 0, "", new Error("original failure")]) {
  test(`shutdown retains original preparation rejection ${String(reason)}`, async () => {
    const owned = fixture();
    const held = gate();
    owned.releases.push(held.resolve);
    try {
      const client = owned.connect();
      owned.backend.onPrepare = () => held.run();
      const request = outcome(client.asyncCall("listFiles", ["/"]));
      owned.joins.push(request);
      await held.started;
      const stopping = owned.service.shutdown();
      owned.joins.push(outcome(stopping));
      held.reject(reason);
      const result = await outcome(stopping);
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toBe(reason);
      owned.service.dispose();
      owned.service.sweep();
      expect(owned.service.shutdown()).toBe(stopping);
      expect(owned.backend.closes).toBe(0);
      expect(owned.service.resources().clients).toBe(1);
    } finally {
      await owned.close();
    }
  });

  test(`shutdown retains original backend close rejection ${String(reason)}`, async () => {
    const owned = fixture();
    try {
      owned.connect();
      owned.backend.onClose = () => Promise.reject(reason);
      const stopping = owned.service.shutdown();
      owned.joins.push(outcome(stopping));
      const result = await outcome(stopping);
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason).toBe(reason);
      expect(owned.service.shutdown()).toBe(stopping);
      expect(owned.backend.closes).toBe(1);
    } finally {
      await owned.close();
    }
  });
}

test("failed detached barriers still join safe siblings and aggregate in admission order once", async () => {
  const owned = fixture();
  const first = gate();
  const second = gate();
  owned.releases.push(first.resolve, second.resolve);
  const earlier = new Error("first");
  const later = new Error("second");
  try {
    const client = owned.connect();
    owned.backend.onFlush = (target) => (target === "/first" ? first.run() : second.run());
    const a = outcome(client.asyncCall("flush", ["/first"]));
    const b = outcome(client.asyncCall("flush", ["/second"]));
    owned.joins.push(a, b);
    await Promise.all([first.started, second.started]);
    const stopping = owned.service.shutdown();
    owned.joins.push(outcome(stopping));
    second.reject(later);
    await expectPending(stopping);
    expect(owned.backend.closes).toBe(0);
    first.reject(earlier);
    const result = await outcome(stopping);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.reason).toBeInstanceOf(AggregateError);
      expect(Reflect.get(result.reason, "errors")).toEqual([earlier, later]);
    }
    expect(owned.backend.closes).toBe(0);
  } finally {
    await owned.close();
  }
});

test("release and close callbacks reenter the same original shutdown promise", async () => {
  const owned = fixture();
  const reentered: Promise<void>[] = [];
  try {
    const client = owned.connect();
    await client.asyncCall("preopen", ["/"]);
    owned.backend.onRelease = () => {
      reentered.push(owned.service.shutdown());
      owned.service.dispose();
    };
    owned.backend.onClose = () => {
      reentered.push(owned.service.shutdown());
      return Promise.resolve();
    };
    const stopping = owned.service.shutdown();
    owned.joins.push(stopping);
    expect(owned.service.shutdown()).toBe(stopping);
    await stopping;
    expect(reentered.length).toBe(2);
    expect(reentered.every((done) => done === stopping)).toBe(true);
    expect(owned.backend.closes).toBe(1);
  } finally {
    await owned.close();
  }
});

test("a rearmed original quiescing waiter cannot permit close before the rejected entrant exits", async () => {
  const owned = fixture();
  const section = new FilesystemSection(owned.root.client);
  const cells = new Int32Array(owned.root.client.sections);
  const sweep = owned.service.sweep.bind(owned.service);
  let held = false;
  let rearmed = false;
  owned.releases.push(() => {
    if (held) section.exit();
    held = false;
    Atomics.store(cells, 0, 0);
    Atomics.notify(cells, 0);
  });
  try {
    owned.connect();
    section.enter();
    held = true;
    revokeFilesystem(owned.root.client);
    owned.service.sweep();
    owned.service.sweep = () => {
      if (rearmed) return sweep();
      rearmed = true;
      // Match the existing rearm control's paused increment-before-revocation check.
      Atomics.add(cells, 0, 1);
      queueMicrotask(() => exitRejectedSection(cells));
      sweep();
    };
    owned.backend.onClose = () => {
      expect(Atomics.load(cells, 0)).toBe(0);
      return Promise.resolve();
    };
    const stopping = owned.service.shutdown();
    owned.joins.push(stopping);
    await expectPending(stopping);
    section.exit();
    held = false;
    await stopping;
    expect(rearmed).toBe(true);
    expect(owned.backend.closes).toBe(1);
  } finally {
    owned.service.sweep = sweep;
    await owned.close();
  }
});

test("worker failure ACK keeps a nonempty diagnostic for an empty original rejection", async () => {
  const backend = new ClosingBackend();
  const messages: unknown[] = [];
  const scope: Parameters<typeof installFilesystemWorker>[0] = {
    onmessage: null,
    postMessage: (message) => {
      messages.push(message);
    },
  };
  const pair = createFilesystemConnection();
  try {
    backend.onClose = () => Promise.reject("");
    installFilesystemWorker(scope, () => backend);
    scope.onmessage?.(new MessageEvent("message", { data: { connect: pair.server } }));
    await checkpoint();
    scope.onmessage?.(new MessageEvent("message", { data: { dispose: true } }));
    await checkpoint();
    const terminal = messages.find(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        Reflect.get(message, "type") === "filesystem-disposed",
    );
    if (typeof terminal !== "object" || terminal === null) throw new Error("missing shutdown ACK");
    expect(Reflect.get(terminal, "error")).toBeTruthy();
    expect(backend.closes).toBe(1);
  } finally {
    pair.client.port.close();
    pair.server.port.close();
  }
});

function releaseFixturePins(backend: ClosingBackend): void {
  backend.onRelease = undefined;
  for (const [handle, count] of backend.pins) {
    for (let index = 0; index < count; index++) backend.release(handle);
  }
}

function exitRejectedSection(cells: Int32Array): void {
  Atomics.sub(cells, 0, 1);
  Atomics.notify(cells, 0);
}

test("a failed original session release retains its pin and still attempts safe sibling release", async () => {
  const owned = fixture();
  const child = connectFilesystemIdentity(createProcessFilesystemIdentity(owned.root.client));
  owned.connections.push(child);
  const failure = new Error("original release");
  let attempts = 0;
  try {
    const root = owned.connect();
    const directory: number = await root.asyncCall("preopen", ["/"]);
    owned.service.connect(child.server);
    const peer = new FilesystemClient(child.client);
    owned.releases.push(() => peer.dispose());
    await peer.asyncCall("preopen", ["/"]);
    owned.backend.onRelease = () => {
      attempts++;
      if (attempts === 1) throw failure;
    };
    const stopping = owned.service.shutdown();
    owned.joins.push(outcome(stopping));
    expect(await outcome(stopping)).toEqual({ status: "rejected", reason: failure });
    expect(attempts).toBe(2);
    expect(owned.backend.pins.get(directory)).toBe(1);
    expect(owned.service.resources().clients).toBe(1);
    expect(owned.service.shutdown()).toBe(stopping);
    owned.service.dispose();
    owned.service.sweep();
    expect(attempts).toBe(2);
    expect(owned.backend.closes).toBe(0);
  } finally {
    await owned.close();
  }
});

test("F1 shutdown recovers later proven-dead locks before an earlier session release", async () => {
  const owned = fixture();
  const child = connectFilesystemIdentity(createProcessFilesystemIdentity(owned.root.client));
  owned.connections.push(child);
  let contentions = 0;
  let lock: number | undefined;
  try {
    const client = owned.connect();
    await client.asyncCall("writeFile", ["/locked"], new Uint8Array([1]));
    const directory: number = await client.asyncCall("preopen", ["/"]);
    const path: { node: number } = await client.asyncCall("resolve", [directory, "locked"]);
    client.retain(path.node);
    owned.service.connect(child.server);
    lock = owned.backend.shared.fileSlot(path.node) * SLOT_WORDS + 8;
    expect(owned.backend.pins.get(path.node)).toBe(1);
    Atomics.store(owned.backend.shared.slots, lock, child.client.owner);
    reapFilesystem(child.client);
    const contend = owned.backend.shared.onContention;
    owned.backend.shared.onContention = () => {
      contentions++;
      contend?.();
      // Finite escape after recording the real blocked release, not timeout evidence.
      owned.backend.revokeOwner(child.client.owner, new Int32Array(child.client.epoch));
    };
    const stopping = owned.service.shutdown();
    owned.joins.push(outcome(stopping));
    await stopping;
    expect(contentions).toBe(0);
    expect(owned.backend.shared.ownerActive(child.client.owner)).toBe(false);
    expect(owned.backend.pins.size).toBe(0);
    expect(owned.backend.closes).toBe(1);
  } finally {
    if (lock !== undefined) Atomics.store(owned.backend.shared.slots, lock, 0);
    owned.backend.shared.onContention = undefined;
    await owned.close();
  }
});

function attempt(run: () => void): PromiseSettledResult<void> {
  try {
    run();
    return { status: "fulfilled", value: undefined };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

test("F2 initiating dispose owns a pin before its release callback reenters sweep", async () => {
  const owned = fixture();
  let releases = 0;
  try {
    const client = owned.connect();
    await client.asyncCall("preopen", ["/"]);
    owned.backend.onRelease = () => {
      releases++;
      owned.service.sweep();
    };
    const result = attempt(() => owned.service.dispose());
    expect(result).toEqual({ status: "fulfilled", value: undefined });
    expect(releases).toBe(1);
    expect(owned.backend.pins.size).toBe(0);
    expect(owned.service.resources().clients).toBe(0);
    expect(owned.backend.closes).toBe(0);
  } finally {
    owned.backend.onRelease = undefined;
    await owned.close();
  }
});

test("F2 a failed initiating release keeps its pin and original failure without retry", async () => {
  const owned = fixture();
  const failure = new Error("initiating release");
  let releases = 0;
  try {
    const client = owned.connect();
    const directory: number = await client.asyncCall("preopen", ["/"]);
    owned.backend.onRelease = () => {
      releases++;
      owned.service.sweep();
      throw failure;
    };
    expect(attempt(() => owned.service.dispose())).toEqual({ status: "rejected", reason: failure });
    expect(releases).toBe(1);
    expect(owned.backend.pins.get(directory)).toBe(1);
    expect(attempt(() => owned.service.sweep())).toEqual({ status: "rejected", reason: failure });
    expect(releases).toBe(1);
    const stopping = owned.service.shutdown();
    owned.joins.push(outcome(stopping));
    expect(await outcome(stopping)).toEqual({ status: "rejected", reason: failure });
    expect(owned.service.shutdown()).toBe(stopping);
    expect(releases).toBe(1);
    expect(owned.backend.closes).toBe(0);
  } finally {
    owned.backend.onRelease = undefined;
    if (owned.backend.pins.size) owned.joins.push(outcome(owned.service.shutdown()));
    await owned.close();
  }
});

function originalQuiescing(service: FilesystemService) {
  const sessions: unknown = Reflect.get(service, "sessions");
  if (!(sessions instanceof Set)) throw new Error("missing original sessions");
  for (const session of sessions) {
    if (typeof session !== "object" || session === null) continue;
    const done: unknown = Reflect.get(session, "quiescing");
    if (done instanceof Promise) return { session, done };
  }
  throw new Error("missing original quiescing promise");
}

async function rejectedQuiescing(reason: unknown, reentrant: boolean): Promise<void> {
  const owned = fixture();
  const section = new FilesystemSection(owned.root.client);
  let held = false;
  let releases = 0;
  let stopping: Promise<void> | undefined;
  owned.releases.push(() => {
    if (held) section.exit();
    held = false;
  });
  try {
    const client = owned.connect();
    const directory: number = await client.asyncCall("preopen", ["/"]);
    section.enter();
    held = true;
    revokeFilesystem(owned.root.client);
    owned.service.sweep();
    const original = originalQuiescing(owned.service);
    const quiesced = outcome(original.done);
    owned.joins.push(quiesced);
    owned.backend.onRelease = () => {
      releases++;
      if (releases !== 1) return;
      expect(Reflect.get(original.session, "quiescing")).toBeUndefined();
      if (reentrant) stopping = owned.service.shutdown();
      throw reason;
    };
    section.exit();
    held = false;
    expect(await quiesced).toEqual({ status: "rejected", reason });
    const work: unknown = Reflect.get(owned.service, "work");
    expect(work instanceof Map && work.has(original.done)).toBe(true);
    expect(Reflect.get(original.session, "quiescing")).toBeUndefined();
    expect(owned.backend.pins.get(directory)).toBe(1);
    stopping ??= owned.service.shutdown();
    owned.joins.push(outcome(stopping));
    const result = await outcome(stopping);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBe(reason);
    expect(owned.service.shutdown()).toBe(stopping);
    expect(releases).toBe(1);
    expect(owned.backend.closes).toBe(0);
  } finally {
    await owned.close();
  }
}

const quiescingReasons = [new Error("original quiescing sweep"), undefined, null, false, 0, ""];
for (const [index, reason] of quiescingReasons.entries()) {
  test(`F3 original cleared quiescing rejection ${index} survives later shutdown`, () =>
    rejectedQuiescing(reason, false));
  test(`F3 original cleared quiescing rejection ${index} survives reentrant shutdown`, () =>
    rejectedQuiescing(reason, true));
}

test("F1 service revocation alone does not authorize dead-owner recovery", async () => {
  const owned = fixture();
  const child = connectFilesystemIdentity(createProcessFilesystemIdentity(owned.root.client));
  owned.connections.push(child);
  const recover = owned.backend.revokeOwner.bind(owned.backend);
  const recovered: number[] = [];
  try {
    const client = owned.connect();
    await client.asyncCall("preopen", ["/"]);
    owned.service.connect(child.server);
    revokeFilesystem(child.client);
    owned.backend.revokeOwner = (owner, epoch) => {
      recovered.push(owner);
      recover(owner, epoch);
    };
    const stopping = owned.service.shutdown();
    owned.joins.push(stopping);
    await stopping;
    expect(recovered).toEqual([]);
    expect(owned.backend.closes).toBe(1);
  } finally {
    await owned.close();
  }
});

test("F1 failed recovery preserves the original failure and attempts independent recoveries", async () => {
  const owned = fixture();
  const first = connectFilesystemIdentity(createProcessFilesystemIdentity(owned.root.client));
  const second = connectFilesystemIdentity(createProcessFilesystemIdentity(owned.root.client));
  owned.connections.push(first, second);
  const failure = new Error("dead-owner recovery");
  const recover = owned.backend.revokeOwner.bind(owned.backend);
  const recovered: number[] = [];
  try {
    const client = owned.connect();
    const directory: number = await client.asyncCall("preopen", ["/"]);
    owned.service.connect(first.server);
    owned.service.connect(second.server);
    reapFilesystem(first.client);
    reapFilesystem(second.client);
    owned.backend.revokeOwner = (owner, epoch) => {
      recovered.push(owner);
      if (owner === first.client.owner) throw failure;
      recover(owner, epoch);
    };
    const stopping = owned.service.shutdown();
    owned.joins.push(outcome(stopping));
    const result = await outcome(stopping);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBe(failure);
    expect(recovered).toEqual([first.client.owner, second.client.owner]);
    expect(owned.backend.pins.get(directory)).toBe(1);
    expect(owned.service.shutdown()).toBe(stopping);
    expect(owned.backend.closes).toBe(0);
    owned.service.dispose();
    owned.service.sweep();
    expect(recovered).toHaveLength(2);
  } finally {
    await owned.close();
  }
});
