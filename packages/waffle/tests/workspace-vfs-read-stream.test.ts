import { expect, test } from "bun:test";
import { revokeFilesystem } from "../fs/protocol.js";
import { MemoryBackend } from "../fs/backend.js";
import { MemFS } from "../fs/memory.js";
import {
  openWorkspaceRead,
  type WorkspaceReadStream,
  type WorkspaceReadStep,
} from "../fs/workspace-stream.js";
import { publicReadFixture, heldNativeReadFixture } from "./fixtures/workspace-read.js";

import type { WorkspaceVfs, VersionLease, VersionStat, ByteRange } from "../fs/workspace-types.js";
import { PersistentBackend } from "../fs/persistent.js";
import { RangeFixture, pattern } from "./fixtures/opfs-range-storage.js";

const CHUNK = 65536;

function memory(size = CHUNK * 3 + 17) {
  const seed = new MemFS();
  seed.writeFile(
    "/file",
    Uint8Array.from({ length: size }, (_, index) => index % 251),
  );
  return publicReadFixture(new MemoryBackend(seed));
}

test("a stream pulls exact owned chunks and never prefetches", async () => {
  const fixture = memory();
  try {
    const opened = await openWorkspaceRead(fixture.workspace, "/file");
    if (opened.kind !== "ok") throw new Error(opened.kind);
    const sizes: number[] = [];
    for (;;) {
      const step = await opened.value.next();
      if (step.kind === "end") break;
      if (step.kind !== "chunk") throw new Error(step.kind);
      expect(step.bytes.buffer.byteLength).toBe(step.bytes.length);
      sizes.push(step.bytes.length);
    }
    expect(sizes).toEqual([CHUNK, CHUNK, CHUNK, 17]);
    await opened.value.close();
    expect(fixture.service.resources().readerLeases).toBe(0);
  } finally {
    await fixture.close();
  }
});

async function capture<T>(work: Promise<T>) {
  return work.then(
    (value) => ({ kind: "ok", value }) as const,
    (error: unknown) => ({ kind: "error", error }) as const,
  );
}
function wrap(
  workspace: WorkspaceVfs,
  change: (lease: VersionLease) => VersionLease,
): WorkspaceVfs {
  return {
    ...workspace,
    async pin(target, version, signal) {
      const result = await workspace.pin(target, version, signal);
      return result.kind === "ok" ? { kind: "ok", value: change(result.value) } : result;
    },
  };
}
async function open(workspace: WorkspaceVfs, range?: ByteRange, signal?: AbortSignal) {
  const result = await openWorkspaceRead(workspace, "/file", range, undefined, signal);
  if (result.kind !== "ok") throw new Error(result.kind);
  return result.value;
}
function released(value: ReturnType<typeof memory>): void {
  const resources = value.service.resources();
  for (const key of [
    "readerLeases",
    "readerTickets",
    "readerOperations",
    "readerPinBytes",
    "readerResultBytes",
  ])
    expect(resources[key] ?? 0).toBe(0);
}

for (const size of [0, 32771, CHUNK * 3 + 17]) {
  test(`memory stream owns ${size} bytes, requests only on demand, and releases at end`, async () => {
    const fixture = memory(size);
    let reads = 0;
    const workspace = wrap(fixture.workspace, (lease) => ({
      stat: lease.stat,
      read(range, signal) {
        reads++;
        return lease.read(range, signal);
      },
      close: () => lease.close(),
    }));
    try {
      const stream = await open(workspace);
      expect(reads).toBe(0);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(reads).toBe(0);
      let offset = 0;
      for (;;) {
        const step = await stream.next();
        if (step.kind === "end") break;
        if (step.kind !== "chunk") throw new Error(step.kind);
        expect(step.offset).toBe(offset);
        expect(step.bytes).toEqual(
          Uint8Array.from({ length: step.bytes.length }, (_, index) => (offset + index) % 251),
        );
        offset += step.bytes.length;
        step.bytes.fill(255);
      }
      expect(offset).toBe(size);
      expect(reads).toBe(Math.ceil(size / CHUNK));
      expect(await stream.next()).toEqual({ kind: "end" });
      await stream.close();
      const reread = await fixture.workspace.read("/file", {
        offset: 0,
        length: Math.min(CHUNK, size),
      });
      if (reread.kind !== "ok") throw new Error(reread.kind);
      expect(reread.value.bytes).toEqual(
        Uint8Array.from({ length: Math.min(CHUNK, size) }, (_, index) => index % 251),
      );
      released(fixture);
    } finally {
      await fixture.close();
    }
  });
}

for (const range of [
  { offset: 200000, length: 1 },
  { offset: 196625, length: 1 },
  { offset: 1, length: 0 },
  { offset: CHUNK + 3, length: 999999 },
]) {
  test(`stream range ${JSON.stringify(range)} clips only at selected EOF`, async () => {
    const fixture = memory();
    try {
      const stream = await open(fixture.workspace, range);
      expect(Object.isFrozen(stream.range)).toBe(true);
      expect(Object.isFrozen(stream.stat)).toBe(true);
      const length = Math.min(range.length, Math.max(0, 196625 - range.offset));
      expect(stream.range).toEqual({ offset: range.offset, length });
      let total = 0;
      for (;;) {
        const step = await stream.next();
        if (step.kind === "end") break;
        if (step.kind !== "chunk") throw new Error(step.kind);
        total += step.bytes.length;
      }
      expect(total).toBe(length);
      await stream.close();
      released(fixture);
    } finally {
      await fixture.close();
    }
  });
}

for (const range of [
  { offset: -1, length: 1 },
  { offset: 0, length: NaN },
  { offset: Number.MAX_SAFE_INTEGER, length: 1 },
]) {
  test(`invalid stream range ${JSON.stringify(range)} takes no lease`, async () => {
    const fixture = memory();
    let pins = 0;
    const workspace: WorkspaceVfs = {
      ...fixture.workspace,
      pin(...args) {
        pins++;
        return fixture.workspace.pin(...args);
      },
    };
    try {
      expect(await openWorkspaceRead(workspace, "/file", range)).toEqual({
        kind: "invalid",
        field: "range",
      });
      expect(pins).toBe(0);
      released(fixture);
    } finally {
      await fixture.close();
    }
  });
}

for (const phase of [
  "read-getter",
  "read-body",
  "bytes-getter",
  "close-getter",
  "close-body",
] as const) {
  test(`wrapped provider ${phase} reentrant next and close see reserved admission`, async () => {
    const fixture = memory(3);
    let stream: WorkspaceReadStream;
    let reentered: Promise<WorkspaceReadStep> | undefined;
    let closing: Promise<void> | undefined;
    let reads = 0,
      closes = 0;
    const enter = () => {
      reentered = stream.next();
      closing = stream.close();
      expect(stream.close()).toBe(closing);
    };
    const workspace = wrap(fixture.workspace, (lease) => {
      const wrapped: VersionLease = {
        stat: lease.stat,
        async read(range, signal) {
          reads++;
          if (phase === "read-body") enter();
          const result = await lease.read(range, signal);
          if (phase !== "bytes-getter" || result.kind !== "ok") return result;
          const value = result.value;
          return {
            kind: "ok",
            value: {
              ...value,
              get bytes() {
                enter();
                return value.bytes;
              },
            },
          };
        },
        close() {
          closes++;
          if (phase === "close-body") enter();
          return lease.close();
        },
      };
      if (phase === "read-getter")
        Object.defineProperty(wrapped, "read", {
          get() {
            enter();
            return () => {
              reads++;
              throw new Error("Read must not start after getter close");
            };
          },
        });
      if (phase === "close-getter")
        Object.defineProperty(wrapped, "close", {
          get() {
            enter();
            return () => {
              closes++;
              return lease.close();
            };
          },
        });
      return wrapped;
    });
    try {
      stream = await open(workspace);
      if (phase.startsWith("close")) await stream.close();
      else expect(await stream.next()).toEqual({ kind: "cancelled" });
      await closing;
      expect(await reentered).toEqual(
        phase.startsWith("close") ? { kind: "cancelled" } : { kind: "pressure", resource: "pull" },
      );
      expect(reads).toBe(phase === "read-getter" || phase.startsWith("close") ? 0 : 1);
      expect(closes).toBe(1);
      released(fixture);
    } finally {
      await fixture.close();
    }
  });
}

for (const reason of [undefined, null, false, 0, ""]) {
  for (const phase of [
    "read-getter",
    "read-body",
    "stat-getter",
    "bytes-getter",
    "close-getter",
    "close-body",
  ] as const) {
    test(`stream preserves exact falsy ${String(reason)} from ${phase}`, async () => {
      const fixture = memory(3);
      let providerClose: Promise<void> | undefined;
      const workspace = wrap(fixture.workspace, (lease) => {
        const wrapped: VersionLease = {
          stat: lease.stat,
          async read(range, signal) {
            if (phase === "read-body") throw reason;
            const result = await lease.read(range, signal);
            if (result.kind !== "ok") return result;
            if (phase === "stat-getter")
              return {
                kind: "ok",
                value: {
                  ...result.value,
                  get stat(): VersionStat {
                    throw reason;
                  },
                },
              };
            if (phase === "bytes-getter")
              return {
                kind: "ok",
                value: {
                  ...result.value,
                  get bytes(): Uint8Array<ArrayBuffer> {
                    throw reason;
                  },
                },
              };
            return result;
          },
          async close() {
            await lease.close();
            if (phase === "close-body") throw reason;
          },
        };
        if (phase === "read-getter")
          Object.defineProperty(wrapped, "read", {
            get() {
              throw reason;
            },
          });
        if (phase === "close-getter")
          Object.defineProperty(wrapped, "close", {
            get() {
              providerClose = lease.close();
              throw reason;
            },
          });
        return wrapped;
      });
      try {
        const stream = await open(workspace);
        if (!phase.startsWith("close")) {
          const first = stream.next();
          expect(await capture(first)).toEqual({ kind: "error", error: reason });
          expect(stream.next()).toBe(first);
        }
        const close = stream.close();
        expect(stream.close()).toBe(close);
        const outcome = await capture(close);
        expect(outcome).toEqual(
          phase.startsWith("close")
            ? { kind: "error", error: reason }
            : { kind: "ok", value: undefined },
        );
        await providerClose;
        released(fixture);
      } finally {
        await providerClose;
        await fixture.close();
      }
    });
  }
}

for (const resource of ["operations", "result-bytes", "metadata"] as const) {
  test(`pull pressure ${resource} keeps the same offset without retrying or prefetching`, async () => {
    const fixture = memory(3);
    const offsets: number[] = [];
    const workspace = wrap(fixture.workspace, (lease) => ({
      stat: lease.stat,
      read(range, signal) {
        offsets.push(range!.offset);
        if (offsets.length === 1) return Promise.resolve({ kind: "pressure", resource });
        return lease.read(range, signal);
      },
      close: () => lease.close(),
    }));
    try {
      const stream = await open(workspace);
      expect(await stream.next()).toEqual({ kind: "pressure", resource });
      expect(fixture.service.resources().readerLeases).toBe(1);
      expect((await stream.next()).kind).toBe("chunk");
      expect(offsets).toEqual([0, 0]);
      await stream.close();
      released(fixture);
    } finally {
      await fixture.close();
    }
  });
}

test("a valid prefix is followed by one stable corrupt terminal and releases the lease", async () => {
  const fixture = memory(CHUNK + 1);
  const failure = { kind: "corrupt", message: "second chunk" } as const;
  let reads = 0;
  const workspace = wrap(fixture.workspace, (lease) => ({
    stat: lease.stat,
    read(range, signal) {
      return ++reads === 2 ? Promise.resolve(failure) : lease.read(range, signal);
    },
    close: () => lease.close(),
  }));
  try {
    const stream = await open(workspace);
    expect((await stream.next()).kind).toBe("chunk");
    expect(await stream.next()).toBe(failure);
    expect(await stream.next()).toBe(failure);
    expect(reads).toBe(2);
    await stream.close();
    released(fixture);
  } finally {
    await fixture.close();
  }
});

test("sixteen idle streams hold leases but never hold a result slot needed by whole read", async () => {
  const fixture = memory(3);
  const streams: WorkspaceReadStream[] = [];
  try {
    for (let index = 0; index < 16; index++) streams.push(await open(fixture.workspace));
    expect(await openWorkspaceRead(fixture.workspace, "/file")).toEqual({
      kind: "pressure",
      resource: "leases",
    });
    expect((await fixture.workspace.read("/file")).kind).toBe("ok");
    expect(fixture.service.resources()).toMatchObject({
      readerLeases: 16,
      readerTickets: 0,
      readerResultBytes: 0,
    });
  } finally {
    await Promise.all(streams.map((stream) => stream.close()));
    await fixture.close();
  }
});

test("selected suffix survives mutation, metadata denial, rename, unlink and replacement", async () => {
  const fixture = memory();
  try {
    const stream = await open(fixture.workspace);
    const stat = stream.stat;
    expect((await stream.next()).kind).toBe("chunk");
    const root = await fixture.client.asyncCall("preopen", ["/"]);
    const handle = (await fixture.client.asyncCall("resolve", [root, "file"])).node;
    await fixture.client.asyncCall("writeFile", ["/file"], new Uint8Array([99]));
    await fixture.client.asyncCall("setMode", [handle, 0]);
    await fixture.client.asyncCall("move", ["/file", "/old"]);
    await fixture.client.asyncCall("remove", ["/old"]);
    await fixture.client.asyncCall("writeFile", ["/file"], new Uint8Array(CHUNK).fill(101));
    let offset = CHUNK;
    for (;;) {
      const step = await stream.next();
      if (step.kind === "end") break;
      if (step.kind !== "chunk") throw new Error(step.kind);
      expect(step.bytes).toEqual(
        Uint8Array.from({ length: step.bytes.length }, (_, index) => (offset + index) % 251),
      );
      offset += step.bytes.length;
    }
    expect(stream.stat).toBe(stat);
    await stream.close();
    released(fixture);
  } finally {
    await fixture.close();
  }
});

test("uncancellable cold native work holds ticket, result reservation and lease until exact settlement", async () => {
  const physical = new RangeFixture();
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let fixture: Awaited<ReturnType<typeof heldNativeReadFixture>> | undefined;
  let next: Promise<WorkspaceReadStep> | undefined;
  let closing: Promise<void> | undefined;
  try {
    fixture = await heldNativeReadFixture(physical, gate.promise, () => entered.resolve());
    const stream = await open(fixture.value.workspace);
    next = stream.next();
    await entered.promise;
    const before = fixture.value.service.resources();
    closing = stream.close();
    expect(stream.close()).toBe(closing);
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(fixture.value.service.resources()).toMatchObject({
      readerTickets: 1,
      readerLeases: 1,
      readerResultBytes: before.readerResultBytes,
    });
    gate.resolve();
    expect(await next).toEqual({ kind: "cancelled" });
    await closing;
    released(fixture.value);
  } finally {
    gate.resolve();
    await next;
    await closing;
    await fixture?.value.close();
    await physical.cleanup();
  }
});

for (const stage of ["before-open", "during-pin", "after-open"] as const) {
  test(`stream signal ${stage} takes and closes only its own lease`, async () => {
    const fixture = memory(3);
    const controller = new AbortController();
    let pins = 0,
      closes = 0;
    const wrapped = wrap(fixture.workspace, (lease) => {
      if (stage === "during-pin") controller.abort(false);
      return {
        stat: lease.stat,
        read: lease.read.bind(lease),
        close() {
          closes++;
          return lease.close();
        },
      };
    });
    const workspace: WorkspaceVfs = {
      ...wrapped,
      pin(...args) {
        pins++;
        return wrapped.pin(...args);
      },
    };
    try {
      if (stage === "before-open") controller.abort(0);
      const result = await openWorkspaceRead(
        workspace,
        "/file",
        undefined,
        undefined,
        controller.signal,
      );
      if (stage === "after-open") {
        if (result.kind !== "ok") throw new Error(result.kind);
        controller.abort(null);
        expect(await result.value.next()).toEqual({ kind: "cancelled" });
        const close = result.value.close();
        expect(result.value.close()).toBe(close);
        await close;
      } else expect(result).toEqual({ kind: "cancelled" });
      expect(pins).toBe(stage === "before-open" ? 0 : 1);
      expect(closes).toBe(stage === "before-open" ? 0 : 1);
      released(fixture);
    } finally {
      await fixture.close();
    }
  });
}

for (const stop of ["projection", "revocation"] as const) {
  test(`root ${stop} stops a stream and joins the original reader owner`, async () => {
    const fixture = memory(3);
    try {
      const stream = await open(fixture.workspace);
      if (stop === "projection") await fixture.workspace.close();
      else {
        revokeFilesystem(fixture.client.connection);
        fixture.client.sweep();
      }
      expect(await stream.next()).toEqual({ kind: "stopped" });
      await stream.close();
      released(fixture);
    } finally {
      await fixture.close();
    }
  });
}

test("single-chunk whole reads return the exact owned completion, without taking a lease", async () => {
  const fixture = memory(32771);
  const submit = fixture.client.submit.bind(fixture.client);
  let delivered: unknown;
  fixture.client.submit = (...args) => {
    const completion = submit(...args);
    if (args[0] !== "publicationReadChunk") return completion;
    const value = completion.value.bind(completion);
    completion.value = async () => {
      delivered = await value();
      return delivered;
    };
    return completion;
  };
  try {
    const result = await fixture.workspace.read("/file");
    if (result.kind !== "ok") throw new Error(result.kind);
    expect(result.value.bytes === delivered).toBe(true);
    expect(fixture.service.resources().readerLeases).toBe(0);
    result.value.bytes.fill(255);
    const again = await fixture.workspace.read("/file");
    if (again.kind !== "ok") throw new Error(again.kind);
    expect(again.value.bytes[0]).toBe(0);
    expect(again.value.bytes).not.toBe(result.value.bytes);
    released(fixture);
  } finally {
    await fixture.close();
  }
});

for (const backing of ["subarray", "shared", "resizable", "subclass"] as const) {
  test(`stream refuses ${backing} provider backing without publishing a chunk`, async () => {
    const fixture = memory(3);
    class Borrowed extends Uint8Array {}
    const workspace = wrap(fixture.workspace, (lease) => ({
      stat: lease.stat,
      async read(range, signal) {
        const result = await lease.read(range, signal);
        if (result.kind !== "ok") return result;
        const buffer =
          backing === "shared"
            ? new SharedArrayBuffer(3)
            : new ArrayBuffer(3, { maxByteLength: 6 });
        const bytes =
          backing === "subarray"
            ? new Uint8Array(4).subarray(1)
            : backing === "subclass"
              ? new Borrowed(3)
              : new Uint8Array(buffer);
        return {
          kind: "ok",
          value: Object.defineProperty({ ...result.value }, "bytes", { value: bytes }),
        };
      },
      close: () => lease.close(),
    }));
    try {
      const stream = await open(workspace);
      const first = stream.next();
      expect(await capture(first)).toMatchObject({
        kind: "error",
        error: { name: "WorkspaceReadContractError" },
      });
      expect(stream.next()).toBe(first);
      await stream.close();
      released(fixture);
    } finally {
      await fixture.close();
    }
  });
}

test("four real cold reads refuse a stream pull without progress, then permit its original offset", async () => {
  const physical = new RangeFixture();
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let arrivals = 0;
  let fixture: Awaited<ReturnType<typeof heldNativeReadFixture>> | undefined;
  const work: Promise<unknown>[] = [];
  try {
    fixture = await heldNativeReadFixture(physical, gate.promise, () => {
      if (++arrivals === 4) entered.resolve();
    });
    const stream = await open(fixture.value.workspace);
    const workspace = fixture.value.workspace;
    for (let index = 0; index < 4; index++)
      work.push(workspace.read("/file", { offset: 0, length: 1 }));
    await entered.promise;
    expect(await stream.next()).toEqual({ kind: "pressure", resource: "operations" });
    expect(arrivals).toBe(4);
    gate.resolve();
    await Promise.all(work);
    const step = await stream.next();
    if (step.kind !== "chunk") throw new Error(step.kind);
    expect(step.offset).toBe(0);
    await stream.close();
    released(fixture.value);
  } finally {
    gate.resolve();
    await Promise.all(work);
    await fixture?.value.close();
    await physical.cleanup();
  }
});

for (const size of [0, 32771, CHUNK * 3 + 17]) {
  test(`cold persistent stream reads ${size} bytes without whole-file hydration`, async () => {
    const physical = new RangeFixture();
    let fixture: ReturnType<typeof publicReadFixture> | undefined;
    try {
      await physical.seed([size]);
      fixture = publicReadFixture(
        await PersistentBackend.open(await physical.open(), { intervalMs: 0 }),
      );
      const before = fixture.backend.shared.resources().usedBytes;
      const stream = await open(fixture.workspace);
      let offset = 0;
      for (;;) {
        const step = await stream.next();
        if (step.kind === "end") break;
        if (step.kind !== "chunk") throw new Error(step.kind);
        expect(step.bytes).toEqual(
          Uint8Array.from({ length: step.bytes.length }, (_, index) => pattern(offset + index)),
        );
        offset += step.bytes.length;
      }
      expect(offset).toBe(size);
      expect(fixture.backend.shared.resources().usedBytes).toBe(before);
      await stream.close();
      released(fixture);
    } finally {
      await fixture?.close();
      await physical.cleanup();
    }
  });
}

test("late owned bytes from an accepted wrapped pull are dropped after close", async () => {
  const fixture = memory(3);
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const workspace = wrap(fixture.workspace, (lease) => ({
    stat: lease.stat,
    async read(range, signal) {
      const result = await lease.read(range, signal);
      entered.resolve();
      await gate.promise;
      return result;
    },
    close: () => lease.close(),
  }));
  let work: Promise<WorkspaceReadStep> | undefined;
  try {
    const stream = await open(workspace);
    work = stream.next();
    await entered.promise;
    const closing = stream.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    gate.resolve();
    expect(await work).toEqual({ kind: "cancelled" });
    await closing;
    expect(await stream.next()).toEqual({ kind: "cancelled" });
    released(fixture);
  } finally {
    gate.resolve();
    await work;
    await fixture.close();
  }
});

test("an actual copyRead ticket cleanup rejection remains next's exact stable rejection", async () => {
  const fixture = memory(3);
  const submit = fixture.client.submit.bind(fixture.client);
  let failClose = true;
  fixture.client.submit = (...args) => {
    const completion = submit(...args);
    if (args[0] !== "publicationReadClose" || !failClose) return completion;
    failClose = false;
    const value = completion.value.bind(completion);
    completion.value = async () => {
      await value();
      throw 0;
    };
    return completion;
  };
  try {
    const stream = await open(fixture.workspace);
    const work = stream.next();
    expect(await capture(work)).toEqual({ kind: "error", error: 0 });
    expect(stream.next()).toBe(work);
    await stream.close();
    released(fixture);
  } finally {
    await fixture.close();
  }
});
