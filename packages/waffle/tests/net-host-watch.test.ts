import { expect, test } from "bun:test";
import { NetHost } from "../browser/net/host.js";
import { RingWriter, createRing } from "../browser/net/ring.js";
import { Kind } from "../browser/net/protocol.js";
import type { NotificationWaitSet } from "../browser/notification-wait.js";
import type { GuestWatchReadiness } from "../fs/guest-watch.js";

/** A single-thread stand-in for the armed set: one sequence word plus the filesystem counter. */
function waitSet(cells: Int32Array, onWait: (count: number) => void = () => {}) {
  const sequence = new Int32Array(new SharedArrayBuffer(4));
  let closed = false;
  let waits = 0;
  const set: NotificationWaitSet = {
    covered: true,
    get disposed() {
      return closed;
    },
    sample: () => ({
      sequence: Atomics.load(sequence, 0),
      filesystem: Atomics.load(cells, 3),
      network: undefined,
      process: undefined,
    }),
    wait(observed, deadline) {
      onWait(++waits);
      if (closed) return "closed";
      if (Atomics.load(cells, 3) !== observed.filesystem) return "not-equal";
      const remaining = Math.max(0, deadline - performance.now());
      if (!remaining) return "timed-out";
      return Atomics.wait(sequence, 0, observed.sequence, remaining);
    },
    setProcessSubscriptions() {},
    dispose() {
      closed = true;
    },
  };
  return { set, waits: () => waits };
}

function readiness(cells: Int32Array, pending = false): GuestWatchReadiness & { ready: boolean } {
  return {
    ready: pending,
    active: true,
    word: cells,
    pending() {
      return this.ready;
    },
  };
}

const counter = () => new Int32Array(new SharedArrayBuffer(16));

test("a pending guest watch ends poll(60000) without waiting", () => {
  const cells = counter();
  const host = new NetHost(createRing(), () => {});
  try {
    const { set, waits } = waitSet(cells);
    host.attachNotifications(set, () => readiness(cells, true));
    const start = performance.now();
    expect(host.poll(60000)).toBe(1);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(waits()).toBe(0);
  } finally {
    host.dispose();
  }
});

test("a counter move without a pending guest watch keeps the original deadline", () => {
  const cells = counter();
  const host = new NetHost(createRing(), () => {});
  try {
    const { set, waits } = waitSet(cells, (count) => {
      if (count === 1) Atomics.add(cells, 3, 1);
    });
    host.attachNotifications(set, () => readiness(cells));
    const start = performance.now();
    expect(host.poll(80)).toBe(0);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(79);
    expect(elapsed).toBeLessThan(1000);
    expect(waits()).toBe(2);
  } finally {
    host.dispose();
  }
});

test("a closed wait set ends poll(60000) with no news", () => {
  const cells = counter();
  const host = new NetHost(createRing(), () => {});
  try {
    const { set } = waitSet(cells);
    set.dispose();
    host.attachNotifications(set, () => undefined);
    expect(host.poll(60000)).toBe(0);
  } finally {
    host.dispose();
  }
});

test("an attached poll still reports helper ring news and local news once", async () => {
  const cells = counter();
  const ring = createRing();
  const host = new NetHost(ring, () => {});
  const writer = new RingWriter(ring);
  try {
    const { set } = waitSet(cells);
    host.attachNotifications(set, () => undefined);
    await writer.write(1, Kind.Data, new Uint8Array([1]));
    expect(host.poll(60000)).toBe(1);
    expect(host.poll(0)).toBe(0);
    const listener = host.listen("127.0.0.1", 49300);
    expect(host.connect("127.0.0.1", 49300)).toBeGreaterThan(0);
    expect(host.poll(60000)).toBe(1);
    expect(host.poll(0)).toBe(0);
    host.close(listener);
  } finally {
    writer.dispose();
    host.dispose();
  }
});

test("onNews wakes the engine on a commit only while a guest watch is pending", async () => {
  const cells = counter();
  const host = new NetHost(createRing(), () => {});
  let news = 0;
  try {
    const watches = readiness(cells);
    host.attachNotifications(waitSet(cells).set, () => watches);
    host.onNews(() => news++);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    await settle();
    const quiet = news;
    Atomics.add(cells, 3, 1);
    Atomics.notify(cells, 3);
    await settle();
    expect(news).toBe(quiet);
    watches.ready = true;
    Atomics.add(cells, 3, 1);
    Atomics.notify(cells, 3);
    await settle();
    expect(news).toBe(quiet + 1);
    host.dispose();
    Atomics.add(cells, 3, 1);
    Atomics.notify(cells, 3);
    await settle();
    expect(news).toBe(quiet + 1);
  } finally {
    host.dispose();
  }
});
