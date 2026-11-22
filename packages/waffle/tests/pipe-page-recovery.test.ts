import { afterEach, expect, test } from "bun:test";
import type { PipeController as ProductionPipeController } from "../proc/pipes.js";
import { pipeRingOffset, pipeSharedPagesInUse } from "../proc/pipes.js";
import { isolatedPipes } from "./fixtures/pipes-intrinsics.ts";

// Every page outside a ring's unread window must return to the pipe's shared pool, whichever
// path left it behind: a failed publication, a reader stopped after its consuming CAS, a slot
// reused before the relay looked at it, or a relay drain racing its own recovery.
const { pipes, atomics: A, hooks } = isolatedPipes();
const { PipeController, PipeErrno } = pipes;
type PipeController = ProductionPipeController;
type Endpoint = ReturnType<PipeController["retain"]>;

const controllers: PipeController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
});
function controller(options: ConstructorParameters<typeof PipeController>[0] = {}) {
  const pipe = new PipeController({ relay: "manual", ...options });
  controllers.push(pipe);
  return pipe;
}
function shared(endpoint: Endpoint) {
  return pipeSharedPagesInUse(endpoint.handle());
}
const none = { bytes: 0, records: 0 };
/** Read until `count` bytes arrive, pumping the relay between attempts. */
function receive(pipe: PipeController, reader: Endpoint, count: number): number {
  const buffer = new Uint8Array(65536);
  let received = 0;
  for (let round = 0; round < 64 && received < count; round++) {
    const result = reader.tryRead([buffer]);
    if (result > 0) received += result;
    else pipe.pumpRelay();
  }
  return received;
}
/** Run `during` the first time pipe code copies payload into this pipe's buffer. */
function duringCopyIn(buffer: SharedArrayBuffer, during: () => void): () => boolean {
  const copy = hooks.typedArrayCopy;
  let fired = false;
  hooks.typedArrayCopy = (target, offset, source, begin, end) => {
    if (!fired && target.buffer === buffer) {
      fired = true;
      during();
    }
    copy(target, offset, source, begin, end);
  };
  return () => {
    hooks.typedArrayCopy = copy;
    return fired;
  };
}

test("a writer revoked during its copy returns the pages it mapped", () => {
  const pipe = controller();
  const reader = pipe.retain(1, "read"),
    writer = pipe.retain(2, "write");
  const restore = duringCopyIn(reader.handle().buffer, () => pipe.revoke(2));
  try {
    expect(writer.tryWrite([new Uint8Array(65536)])).toBe(-PipeErrno.BADF);
  } finally {
    expect(restore()).toBe(true);
  }
  expect(shared(reader)).toEqual(none);
});

test("a relay delivery to a reader that closes mid-copy returns its pages", () => {
  const pipe = controller();
  const first = pipe.retain(1, "read"),
    second = first.forProcess(2),
    third = first.forProcess(3);
  const writer = pipe.retain(4, "write");
  expect(pipe.mode).toBe("relay");
  expect(writer.tryWrite([new Uint8Array(65536)])).toBe(65536);
  expect(first.tryRead([new Uint8Array(65536)])).toBe(-PipeErrno.AGAIN);
  const restore = duringCopyIn(first.handle().buffer, () => first.close());
  try {
    pipe.pumpRelay();
  } finally {
    expect(restore()).toBe(true);
  }
  second.close();
  expect(receive(pipe, third, 65536)).toBe(65536);
  expect(writer.tryWrite([new Uint8Array(65536)])).toBe(65536);
  expect(receive(pipe, third, 65536)).toBe(65536);
  pipe.pumpRelay();
  expect(shared(third)).toEqual(none);
});

test("drained relay readers replaced before the next pump return their pages", () => {
  const pipe = controller({ capacity: 8192, maxReaders: 5 });
  const live = pipe.retain(1, "read");
  const writer = pipe.retain(10, "write");
  const readers = [2, 3, 4, 5].map((pid) => live.forProcess(pid));
  expect(pipe.mode).toBe("relay");
  let pid = 20;
  for (const [index, reader] of readers.entries()) {
    expect(writer.tryWrite([new Uint8Array([index])])).toBe(1);
    expect(reader.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.AGAIN);
    pipe.pumpRelay();
    expect(reader.tryRead([new Uint8Array(1)])).toBe(1);
    reader.close();
    readers[index] = live.forProcess(pid++);
  }
  pipe.pumpRelay();
  expect(shared(live)).toEqual(none);
  expect(writer.tryWrite([new Uint8Array(10)])).toBe(10);
  expect(receive(pipe, live, 10)).toBe(10);
});

test("a relay delivery drained while the relay recovers it returns its pages", () => {
  const pipe = controller();
  const first = pipe.retain(1, "read"),
    second = first.forProcess(2);
  const writer = pipe.retain(3, "write");
  expect(writer.tryWrite([new Uint8Array(100)])).toBe(100);
  expect(first.tryRead([new Uint8Array(100)])).toBe(-PipeErrno.AGAIN);
  pipe.pumpRelay();
  expect(second.tryRead([new Uint8Array(100)])).toBe(-PipeErrno.AGAIN);
  // The relay sees the delivery unread and the other reader's demand, then the owner drains it.
  const demand = new Int32Array(second.handle().buffer, pipeRingOffset(second.handle()) + 32, 1);
  const load = A.load;
  let drained = false;
  A.load = ((array: Int32Array, index: number) => {
    if (!drained && array.byteOffset === demand.byteOffset && array.buffer === demand.buffer) {
      drained = true;
      expect(first.tryRead([new Uint8Array(100)])).toBe(100);
    }
    return load(array, index);
  }) as typeof A.load;
  try {
    pipe.pumpRelay();
  } finally {
    A.load = load;
  }
  expect(drained).toBe(true);
  expect(shared(first)).toEqual(none);
});

test("returning a drained delivery's page wakes a writer waiting for it", () => {
  const pipe = controller();
  const first = pipe.retain(1, "read"),
    second = first.forProcess(2);
  const greedy = pipe.retain(3, "write"),
    blocked = pipe.retain(4, "write");
  expect(pipe.mode).toBe("relay");
  expect(greedy.tryWrite([new Uint8Array(100)])).toBe(100);
  expect(first.tryRead([new Uint8Array(100)])).toBe(-PipeErrno.AGAIN);
  pipe.pumpRelay();
  expect(first.tryRead([new Uint8Array(100)])).toBe(100);
  // The drained delivery still holds one shared page; two writers take the rest above the
  // delivery reserve, and the blocked writer fills its own two reserved pages.
  expect(greedy.tryWrite([new Uint8Array(65436)])).toBe(65436);
  const extra = pipe.retain(5, "write");
  expect(extra.tryWrite([new Uint8Array(12288)])).toBe(12288);
  expect(shared(first).bytes).toBe(16);
  expect(blocked.tryWrite([new Uint8Array(8192)])).toBe(8192);
  expect(blocked.tryWrite([new Uint8Array(1)])).toBe(-PipeErrno.AGAIN);
  const observed = Atomics.load(pipe.notification, 0);
  pipe.pumpRelay();
  expect(Atomics.load(pipe.notification, 0)).not.toBe(observed);
  expect(blocked.tryWrite([new Uint8Array(1)])).toBe(1);
  second.close();
});

function message(worker: Worker): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("pipe page worker timed out")), 10000);
    worker.addEventListener(
      "message",
      (event) => {
        clearTimeout(timer);
        resolve(event.data);
      },
      { once: true },
    );
    worker.addEventListener(
      "error",
      (event) => {
        clearTimeout(timer);
        reject(event.error ?? new Error(event.message));
      },
      { once: true },
    );
  });
}
/** Start a real Worker reading `endpoint`. It stops for good after its consuming CAS on the
 * ring of `consumedBy`: the source writer in direct mode, its own delivery ring in relay mode. */
async function stoppedAfterConsume(endpoint: Endpoint, consumedBy = endpoint): Promise<Worker> {
  const child = new Worker(new URL("./fixtures/pipe-page-worker.ts", import.meta.url));
  const handle = endpoint.handle();
  const ready = message(child);
  child.postMessage({
    handle: structuredClone(handle),
    gate: new Int32Array(new SharedArrayBuffer(4)),
    consumed: pipeRingOffset(consumedBy.handle()) + 16,
  });
  expect(await ready).toBe("ready");
  return child;
}

test("a direct reader Worker terminated after its consuming CAS leaks no pages", async () => {
  const pipe = controller({ maxWriters: 1 });
  const reader = pipe.retain(1, "read"),
    writer = pipe.retain(2, "write");
  expect(writer.tryWrite([new Uint8Array(65536)])).toBe(65536);
  expect(shared(reader).bytes).toBe(15);
  const consumed = stoppedAfterConsume(reader, writer);
  const child = await consumed;
  try {
    expect(await message(child)).toBe("consumed");
  } finally {
    await child.terminate();
  }
  pipe.revoke(1);
  const survivor = pipe.retain(5, "read");
  writer.close();
  // The replacement writer reuses the slot; nothing the dead reader passed stays mapped.
  const next = pipe.retain(3, "write");
  expect(survivor.tryRead([new Uint8Array(1)])).toBe(-PipeErrno.AGAIN);
  expect(next.handle().slot).toBe(writer.handle().slot);
  expect(shared(next)).toEqual(none);
}, 20000);

test("a relay reader Worker terminated after its consuming CAS leaks no pages", async () => {
  const pipe = controller();
  const host = pipe.retain(1, "read");
  const doomed = host.forProcess(2),
    live = host.forProcess(3);
  const writer = pipe.retain(4, "write");
  expect(pipe.mode).toBe("relay");
  const child = await stoppedAfterConsume(doomed);
  try {
    expect(writer.tryWrite([new Uint8Array(65536)])).toBe(65536);
    const consumed = message(child);
    for (let round = 0; round < 50 && shared(live).bytes < 16; round++) {
      pipe.pumpRelay();
      await Bun.sleep(5);
    }
    expect(await consumed).toBe("consumed");
  } finally {
    await child.terminate();
  }
  pipe.revoke(2);
  doomed.close();
  host.close();
  pipe.pumpRelay();
  expect(shared(live)).toEqual(none);
  expect(writer.tryWrite([new Uint8Array(65536)])).toBe(65536);
  expect(receive(pipe, live, 65536)).toBe(65536);
}, 20000);
