import { expect, test } from "bun:test";
import { OrderedReporter } from "./ordered-reporter.js";
import { reportEventByteLimit } from "./report-chunks.js";
import { record, resultByteLimit } from "./protocol.js";

function ack(init: RequestInit): Response {
  const body: unknown = JSON.parse(String(init.body));
  if (!record(body)) throw new Error("Missing envelope");
  return Response.json({ ackedThrough: body.seq });
}
test("reservation includes the last slot before conversion and rejects reentry without a sequence", async () => {
  const gate = Promise.withResolvers<void>();
  const reporter = new OrderedReporter<{ value: number }>("run", async (_url, init) => {
    await gate.promise;
    return ack(init);
  });
  const prefix = Array.from({ length: 63 }, (_, value) => reporter.send({ value }));
  let nested: Promise<void> | undefined;
  let converted = 0;
  try {
    const outer = reporter.sendSnapshot(() => {
      expect(reporter.observation.pending).toBe(64);
      nested = reporter.sendSnapshot(() => {
        converted++;
        return { value: 65 };
      });
      return { value: 64 };
    });
    await expect(outer).rejects.toThrow("reentry");
    await expect(nested).rejects.toThrow("reentry");
    expect(converted).toBe(0);
    expect(reporter.observation.pending).toBe(63);
    expect(reporter.signal.aborted).toBe(true);
  } finally {
    gate.resolve();
    await Promise.all(prefix);
    reporter.stop();
  }
  expect(reporter.observation.ackedThrough).toBe(62);
});
test("full envelope is encoded once before sequence commit", async () => {
  let reads = 0;
  const reporter = new OrderedReporter<{ value: string }>("run", async (_url, init) => ack(init));
  await reporter.sendSnapshot(() => ({
    get value() {
      reads++;
      return "snapshot";
    },
  }));
  expect(reads).toBe(1);
  await expect(
    reporter.sendSnapshot(() => ({ value: "x".repeat(reportEventByteLimit) })),
  ).rejects.toThrow("4 MiB");
  expect(reporter.observation.ackedThrough).toBe(0);
  expect(reporter.observation.pending).toBe(0);
});

test("capacity refusal preserves the healthy prefix and refuses further conversion", async () => {
  const gate = Promise.withResolvers<void>();
  const reporter = new OrderedReporter<{ value: number }>("run", async (_url, init) => {
    await gate.promise;
    return ack(init);
  });
  const prefix = Array.from({ length: 64 }, (_, value) => reporter.send({ value }));
  let reads = 0;
  try {
    await expect(
      reporter.sendSnapshot(() => {
        reads++;
        return { value: 65 };
      }),
    ).rejects.toThrow("capacity");
    expect(reads).toBe(0);
    expect(reporter.observation.pending).toBe(64);
  } finally {
    gate.resolve();
    await Promise.all(prefix);
    reporter.stop();
  }
  expect(reporter.observation.ackedThrough).toBe(63);
  expect(reporter.observation.failure).toContain("capacity");
});
for (const phase of ["fetch", "parse"] as const) {
  test(`cancellation retains abort-ignoring actual ${phase} ownership and forbids replacement`, async () => {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let attempts = 0;
    const reporter = new OrderedReporter<{ value: number }>("run", async (_url, init) => {
      attempts++;
      if (phase === "fetch") {
        entered.resolve();
        await gate.promise;
        return ack(init);
      }
      const response = ack(init);
      const parse = response.json.bind(response);
      response.json = async () => {
        entered.resolve();
        await gate.promise;
        return parse();
      };
      return response;
    });
    const sending = reporter.send({ value: 1 });
    const observed = sending.catch(() => {});
    try {
      await entered.promise;
      reporter.cancelDelivery("actual host cancellation");
      await Bun.sleep(5);
      expect(reporter.observation.pending).toBe(1);
      expect(reporter.observation.ackedThrough).toBe(-1);
      expect(attempts).toBe(1);
    } finally {
      gate.resolve();
      await observed;
      reporter.stop();
    }
    await expect(sending).rejects.toThrow("host cancellation");
    expect(reporter.observation.pending).toBe(0);
    expect(reporter.observation.ackedThrough).toBe(-1);
  });
}
test("throwing getters, toJSON and no-event snapshots consume no sequence", async () => {
  for (const snapshot of [
    () => ({
      get value(): string {
        throw new Error("getter");
      },
    }),
    () => ({
      value: {
        toJSON() {
          throw new Error("toJSON");
        },
      },
    }),
  ]) {
    const reporter = new OrderedReporter<object>("run", async (_url, init) => ack(init));
    await reporter.sendSnapshot(() => null);
    await expect(reporter.sendSnapshot(snapshot)).rejects.toThrow();
    expect(reporter.observation.pending).toBe(0);
    expect(reporter.observation.ackedThrough).toBe(-1);
    expect(reporter.signal.aborted).toBe(true);
  }
});
test("retry uses one owned envelope, including mutating nested toJSON", async () => {
  let reads = 0;
  const bodies: string[] = [];
  const reporter = new OrderedReporter<object>("run", async (_url, init) => {
    bodies.push(String(init.body));
    if (bodies.length === 1) throw new Error("held ACK lost");
    return ack(init);
  });
  await reporter.sendSnapshot(() => ({
    value: {
      toJSON() {
        return ++reads;
      },
    },
  }));
  expect(reads).toBe(1);
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toBe(bodies[1]);
});
for (const response of [
  () => Response.json(true),
  () => Response.json({ kind: "live", retire: false }, { status: 503 }),
]) {
  test("control replies require current schema and successful HTTP status", async () => {
    const reporter = new OrderedReporter<object>("run");
    await expect(reporter.hostReply(response())).rejects.toThrow("control reply");
    expect(reporter.signal.aborted).toBe(true);
  });
}

test("envelope limit includes run and document bytes before sequence allocation", async () => {
  let attempts = 0;
  const reporter = new OrderedReporter<{ value: string }>(
    "r".repeat(resultByteLimit - 10),
    async (_url, init) => {
      attempts++;
      return ack(init);
    },
  );
  await expect(reporter.sendSnapshot(() => ({ value: "tiny event" }))).rejects.toThrow("48 KiB");
  expect(attempts).toBe(0);
  expect(reporter.observation.pending).toBe(0);
  expect(reporter.observation.ackedThrough).toBe(-1);
});

test("malformed exact ACK failure is sticky and future snapshots never run", async () => {
  let attempts = 0;
  const reporter = new OrderedReporter<{ value: number }>(
    "run",
    async () => {
      attempts++;
      return Response.json({ ackedThrough: 99 });
    },
    1,
  );
  await expect(reporter.send({ value: 1 })).rejects.toThrow("acknowledgement lost");
  expect(attempts).toBe(1);
  expect(reporter.observation.ackedThrough).toBe(-1);
  expect(reporter.observation.pending).toBe(0);
  expect(reporter.signal.aborted).toBe(true);
  let reads = 0;
  await expect(
    reporter.sendSnapshot(() => {
      reads++;
      return { value: 2 };
    }),
  ).rejects.toThrow();
  expect(reads).toBe(0);
});

test("final encoding-stage reentry cannot commit the outer report", async () => {
  const original = TextEncoder.prototype.encode;
  let reporter: OrderedReporter<{ value: number }> | undefined;
  let nested: Promise<void> | undefined;
  let factoryReads = 0;
  TextEncoder.prototype.encode = function (value) {
    TextEncoder.prototype.encode = original;
    if (!reporter) throw new Error("Encoder ran during reporter construction");
    nested = reporter.sendSnapshot(() => {
      factoryReads++;
      return { value: 2 };
    });
    void nested.catch(() => {});
    return original.call(this, value);
  };
  try {
    reporter = new OrderedReporter("run", async (_url, init) => ack(init));
    await expect(reporter.sendSnapshot(() => ({ value: 1 }))).rejects.toThrow("reentry");
    await expect(nested).rejects.toThrow("reentry");
    expect(factoryReads).toBe(0);
    expect(reporter.observation.ackedThrough).toBe(-1);
    expect(reporter.observation.pending).toBe(0);
  } finally {
    TextEncoder.prototype.encode = original;
    await reporter?.stop();
  }
});
