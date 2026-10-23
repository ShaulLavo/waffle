import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { setImmediate } from "node:timers/promises";
import {
  encodeWorkspaceArchive,
  importWorkspaceArchive,
  parseWorkspaceArchive,
  type ArchiveEntry,
  type ArchiveManifest,
  type ArchiveSourceEntry,
  type ArchiveStagingSink,
} from "../fs/workspace-archive.js";

const manifest: ArchiveManifest = {
  format: "waffle-workspace-archive-v1",
  sourceFormat: null,
  sourceWorkspace: null,
};
const root: ArchiveEntry & { kind: "directory" } = {
  path: "/",
  kind: "directory",
  size: 0,
  mode: 0o700,
  mtime: 0,
  sourceIdentity: null,
};
const file: ArchiveEntry & { kind: "file" } = {
  path: "/x",
  kind: "file",
  size: 1,
  mode: 0o600,
  mtime: 0,
  sourceIdentity: null,
};
async function* values<T>(items: readonly T[]): AsyncGenerator<T> {
  yield* items;
}
async function consume(source: AsyncIterable<unknown>): Promise<void> {
  for await (const _item of source) {
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected rejection");
}
function leaves(error: unknown): unknown[] {
  if (error instanceof AggregateError) return error.errors.flatMap(leaves);
  return [error];
}
function expectLeaves(error: unknown, expected: readonly unknown[]): void {
  const actual = leaves(error);
  expect(actual.length).toBe(expected.length);
  expected.forEach((reason, index) => expect(actual[index]).toBe(reason));
}
function failing<T>(reason: unknown, cleanup?: { reason: unknown }): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => Promise.reject(reason),
        return: () =>
          cleanup
            ? Promise.reject(cleanup.reason)
            : Promise.resolve({ done: true, value: undefined }),
      };
    },
  };
}
class Sink implements ArchiveStagingSink {
  selected = "old";
  calls: string[] = [];
  reason: unknown;
  async begin() {
    this.calls.push("begin");
  }
  async entry() {
    this.calls.push("entry");
  }
  async write(_bytes: Uint8Array) {
    this.calls.push("write");
  }
  async endEntry() {
    this.calls.push("end-entry");
  }
  async complete() {
    this.calls.push("publish");
    this.selected = "new";
  }
  async abort(reason: unknown) {
    this.calls.push("abort");
    this.reason = reason;
  }
}
async function fixture(): Promise<Uint8Array> {
  const frames: Uint8Array[] = [];
  for await (const frame of encoded()) frames.push(frame);
  const bytes = new Uint8Array(frames.reduce((sum, frame) => sum + frame.length, 0));
  let offset = 0;
  for (const frame of frames) {
    bytes.set(frame, offset);
    offset += frame.length;
  }
  return bytes;
}
function encoded(payload = values([new Uint8Array([7])])) {
  return encodeWorkspaceArchive(
    manifest,
    values<ArchiveSourceEntry>([{ metadata: root }, { metadata: file, bytes: payload }]),
  );
}
async function copyProbe(kind: "ordinary" | "buffer" | "subclass"): Promise<void> {
  const bytes = await fixture();
  class CustomBytes extends Uint8Array {
    override slice(): Uint8Array<ArrayBuffer> {
      throw new Error("Input slice was called");
    }
  }
  const backing = new ArrayBuffer(1024 * 1024);
  const transport =
    kind === "buffer"
      ? Buffer.from(backing, 0, bytes.length)
      : kind === "subclass"
        ? new CustomBytes(backing, 0, bytes.length)
        : new Uint8Array(backing, 0, bytes.length);
  transport.set(bytes);
  const normalSet = Uint8Array.prototype.set;
  const normalSlice = transport.slice.bind(transport);
  let retained: Uint8Array | undefined;
  Uint8Array.prototype.set = function (source, offset) {
    if (source === transport) retained = this;
    normalSet.call(this, source, offset);
  };
  transport.slice = (start, end) => {
    retained = normalSlice(start, end);
    return retained;
  };
  const parser = parseWorkspaceArchive(values([transport]));
  try {
    expect((await parser.next()).value?.kind).toBe("manifest");
    expect(retained?.constructor).toBe(Uint8Array);
    expect(retained?.buffer.byteLength).toBe(bytes.length);
    expect(retained?.buffer).not.toBe(backing);
    transport.fill(0);
    await consume(parser);
  } finally {
    Uint8Array.prototype.set = normalSet;
    await parser.return(undefined);
  }
}

function fulfilledOnce<T>(value: T) {
  let reads = 0;
  const result = {
    done: false as const,
    value,
    get then(): undefined {
      reads++;
      if (reads > 1) throw new Error("IteratorResult reassimilated");
      return undefined;
    },
  };
  const ready = Promise.resolve(result);
  let used = false;
  const source: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (used) return Promise.resolve({ done: true as const, value: undefined });
          used = true;
          return ready;
        },
        return: () => Promise.resolve({ done: true, value: undefined }),
      };
    },
  };
  return { source, reads: () => reads };
}
async function fulfilledProbe(kind: "transport" | "entries" | "payload", withSignal: boolean) {
  const options = { signal: withSignal ? new AbortController().signal : undefined };
  if (kind === "transport") {
    const input = fulfilledOnce(await fixture());
    await consume(parseWorkspaceArchive(input.source, options));
    expect(input.reads()).toBe(1);
    return;
  }
  if (kind === "entries") {
    const input = fulfilledOnce<ArchiveSourceEntry>({ metadata: root });
    await consume(encodeWorkspaceArchive(manifest, input.source, options));
    expect(input.reads()).toBe(1);
    return;
  }
  const input = fulfilledOnce(new Uint8Array([7]));
  const entries = values<ArchiveSourceEntry>([
    { metadata: root },
    { metadata: file, bytes: input.source },
  ]);
  await consume(encodeWorkspaceArchive(manifest, entries, options));
  expect(input.reads()).toBe(1);
}
async function rejectionProbe(
  kind: "transport" | "entries" | "payload",
  reason: unknown,
  cleanup: boolean,
) {
  const cleanupError = new Error(`${kind} return`);
  const end = cleanup ? { reason: cleanupError } : undefined;
  if (kind === "transport") {
    const sink = new Sink();
    const error = await failure(importWorkspaceArchive(failing(reason, end), sink));
    expectLeaves(error, cleanup ? [reason, cleanupError] : [reason]);
    expect(sink.reason).toBe(error);
    expect(sink.calls).toEqual(["abort"]);
    expect(sink.selected).toBe("old");
    return;
  }
  const entries =
    kind === "entries"
      ? failing<ArchiveSourceEntry>(reason, end)
      : values<ArchiveSourceEntry>([
          { metadata: root },
          { metadata: file, bytes: failing(reason, end) },
        ]);
  const error = await failure(consume(encodeWorkspaceArchive(manifest, entries)));
  expectLeaves(error, cleanup ? [reason, cleanupError] : [reason]);
}
async function synchronousAbortProbe(): Promise<void> {
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => {
    unhandled.push(error);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await abortAtNext("transport");
    await abortAtNext("entries");
    await abortAtNext("payload");
    await setImmediate();
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}
async function abortAtNext(kind: "transport" | "entries" | "payload") {
  const controller = new AbortController();
  let returns = 0;
  function source<T>(): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator]() {
        return {
          next() {
            controller.abort("cancel-during-next");
            return Promise.reject(false);
          },
          async return() {
            returns++;
            return { done: true, value: undefined };
          },
        };
      },
    };
  }
  const options = { signal: controller.signal };
  if (kind === "transport") {
    const sink = new Sink();
    expect(await failure(importWorkspaceArchive(source(), sink, options))).toBe(
      "cancel-during-next",
    );
    expect(sink.selected).toBe("old");
    expect(sink.calls).toEqual(["abort"]);
  } else {
    const entries =
      kind === "entries"
        ? source<ArchiveSourceEntry>()
        : values<ArchiveSourceEntry>([{ metadata: root }, { metadata: file, bytes: source() }]);
    expect(await failure(consume(encodeWorkspaceArchive(manifest, entries, options)))).toBe(
      "cancel-during-next",
    );
  }
  expect(returns).toBe(1);
}
async function joinProbe(returnFails: boolean) {
  const controller = new AbortController();
  const started = deferred<void>(),
    returnStarted = deferred<void>();
  const pending = deferred<IteratorResult<Uint8Array>>(),
    returned = deferred<void>();
  const cleanup = new Error("return rejected");
  const calls: string[] = [];
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          started.resolve();
          return pending.promise;
        },
        async return() {
          calls.push("return-start");
          returnStarted.resolve();
          await returned.promise;
          calls.push("return-end");
          if (returnFails) throw cleanup;
          return { done: true, value: undefined };
        },
      };
    },
  };
  const sink = new Sink();
  const importing = failure(importWorkspaceArchive(source, sink, { signal: controller.signal }));
  await started.promise;
  controller.abort(false);
  await returnStarted.promise;
  expect(sink.calls).toEqual([]);
  returned.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(sink.calls).toEqual([]);
  pending.resolve({ done: true, value: undefined });
  expectLeaves(await importing, returnFails ? [false, cleanup] : [false]);
  expect(calls).toEqual(["return-start", "return-end"]);
  expect(sink.calls).toEqual(["abort"]);
  expect(sink.selected).toBe("old");
}

if (process.argv.includes("--archive-abort-child")) {
  await synchronousAbortProbe();
} else {
  for (const kind of ["ordinary", "buffer", "subclass"] as const)
    test(`transport owns exact base allocation: ${kind}`, () => copyProbe(kind));
  for (const kind of ["transport", "entries", "payload"] as const) {
    for (const enabled of [false, true])
      test(`fulfilled result observed once: ${kind}, signal=${enabled}`, () =>
        fulfilledProbe(kind, enabled));
    for (const reason of [undefined, null, false, 0, ""]) {
      test(`exact falsy failure: ${kind}, ${String(reason)}`, () =>
        rejectionProbe(kind, reason, false));
      test(`primary and return retained: ${kind}, ${String(reason)}`, () =>
        rejectionProbe(kind, reason, true));
    }
  }
  test("synchronous abort inside next owns every rejection", async () => {
    const child = Bun.spawn([process.execPath, import.meta.path, "--archive-abort-child"], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const [exit, errors] = await Promise.all([child.exited, stderr]);
    expect(errors).toBe("");
    expect(exit).toBe(0);
  });
  test("cancellation joins both started pull and return", () => joinProbe(false));
  test("failed return still joins started pull", () => joinProbe(true));
  test("payload and entry cleanup failures both survive", async () => {
    const payloadEnd = new Error("payload return"),
      entriesEnd = new Error("entries return");
    const entries: AsyncIterable<ArchiveSourceEntry> = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            Promise.resolve({
              done: false,
              value: { metadata: file, bytes: failing(0, { reason: payloadEnd }) },
            }),
          return: () => Promise.reject(entriesEnd),
        };
      },
    };
    async function* rooted() {
      yield { metadata: root };
      yield* entries;
    }
    expectLeaves(await failure(consume(encodeWorkspaceArchive(manifest, rooted()))), [
      0,
      payloadEnd,
      entriesEnd,
    ]);
  });
  test("write, transport return, and abort failures retain identities without publishing", async () => {
    const primary = new Error("write"),
      close = new Error("source return"),
      abort = new Error("abort");
    const bytes = await fixture();
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.resolve({ done: false, value: bytes }),
          return: () => Promise.reject(close),
        };
      },
    };
    const sink = new Sink();
    sink.write = () => Promise.reject(primary);
    sink.abort = async (reason) => {
      sink.reason = reason;
      throw abort;
    };
    const error = await failure(importWorkspaceArchive(source, sink));
    expectLeaves(error, [primary, close, abort]);
    expectLeaves(sink.reason, [primary, close]);
    expect(sink.calls).not.toContain("publish");
    expect(sink.selected).toBe("old");
  });
  test("normal early return exposes cleanup-only failure", async () => {
    const cleanup = new Error("early return");
    const bytes = await fixture();
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.resolve({ done: false, value: bytes }),
          return: () => Promise.reject(cleanup),
        };
      },
    };
    const parser = parseWorkspaceArchive(source);
    expect((await parser.next()).value?.kind).toBe("manifest");
    expect(await failure(parser.return(undefined))).toBe(cleanup);
  });
}
