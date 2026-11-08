import { expect, test } from "bun:test";
import { Reporter } from "./reporter.js";
import { record } from "./protocol.js";
async function withWindow(run: () => Promise<void>): Promise<void> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  try {
    await run();
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
}
function acknowledge(init: RequestInit): Response {
  const body: unknown = JSON.parse(String(init.body));
  if (!record(body)) throw new Error("Missing report");
  return Response.json({ ackedThrough: body.seq });
}
test("reporter outbox has a fixed bound and overflow remains sticky after draining", () =>
  withWindow(async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reporter = new Reporter("r", async (_url, init) => {
      await gate;
      return acknowledge(init);
    });
    const pending = Array.from({ length: 64 }, () =>
      reporter.send({ kind: "error", message: "queued" }),
    );
    await expect(reporter.send({ kind: "error", message: "overflow" })).rejects.toThrow("capacity");
    expect(reporter.observation.pending).toBe(64);
    release();
    await Promise.all(pending);
    expect(reporter.observation.failure).toContain("capacity");
    expect(reporter.observation.pending).toBe(0);
  }));
test("reporter retries identical sequence and body after lost acknowledgement", () =>
  withWindow(async () => {
    const bodies: string[] = [];
    const reporter = new Reporter(
      "r",
      async (_url, init) => {
        bodies.push(String(init.body));
        if (bodies.length === 1) throw new Error("Acknowledgement lost after acceptance");
        return acknowledge(init);
      },
      500,
    );
    await reporter.send({ kind: "doc-complete" });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(bodies[1]);
    expect(reporter.observation.ackedThrough).toBe(0);
  }));
test("heartbeat is independent of a blocked report and permits only one request in flight", () =>
  withWindow(async () => {
    let release!: () => void,
      beats = 0,
      reports = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reporter = new Reporter("r", async (url, init) => {
      if (url === "/heartbeat") beats++;
      else reports++;
      await gate;
      return url === "/heartbeat"
        ? Response.json({ kind: "live", retire: true })
        : acknowledge(init);
    });
    const pending = reporter.send({ kind: "doc-complete" });
    reporter.startHeartbeat(2);
    try {
      await Bun.sleep(25);
      expect(reports).toBe(1);
      expect(beats).toBe(1);
    } finally {
      reporter.stop();
      release();
      await pending;
    }
  }));

test("report retry and retirement use pre-fixture dependencies while instrumentation remains active", () =>
  withWindow(async () => {
    const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    const timer = globalThis.setTimeout,
      clear = globalThis.clearTimeout;
    const interval = globalThis.setInterval,
      clearInterval = globalThis.clearInterval;
    const timeout = AbortSignal.timeout;
    let attempts = 0,
      observedTimers = 0,
      retired = false;
    const reporter = new Reporter(
      "r",
      async (url, init) => {
        if (url.startsWith("/retire")) {
          retired = true;
          return Response.json({ kind: "live", retire: true });
        }
        if (++attempts === 1) throw new Error("Lost ACK");
        return acknowledge(init);
      },
      500,
    );
    try {
      Reflect.set(globalThis, "fetch", () => {
        throw new Error("Patched fetch");
      });
      Reflect.set(globalThis, "setTimeout", () => {
        observedTimers++;
        throw new Error("Observed reporter timeout");
      });
      Reflect.set(globalThis, "setInterval", () => {
        throw new Error("Observed reporter interval");
      });
      Reflect.set(globalThis, "clearTimeout", () => {
        throw new Error("Observed reporter clear");
      });
      Reflect.set(globalThis, "clearInterval", () => {
        throw new Error("Observed reporter clear");
      });
      AbortSignal.timeout = () => {
        throw new Error("Patched abort timeout");
      };
      reporter.startHeartbeat(1000);
      await reporter.send({ kind: "doc-complete" });
      await reporter.readyForRetirement();
      reporter.stop();
      expect(retired).toBe(true);
      expect(observedTimers).toBe(0);
      expect(attempts).toBe(3);
    } finally {
      if (fetchDescriptor) Object.defineProperty(globalThis, "fetch", fetchDescriptor);
      globalThis.setTimeout = timer;
      globalThis.clearTimeout = clear;
      globalThis.setInterval = interval;
      globalThis.clearInterval = clearInterval;
      AbortSignal.timeout = timeout;
      reporter.stop();
    }
  }));

test("ordinary retirement stops on collector cancellation and rejects old boolean commands", () =>
  withWindow(async () => {
    for (const command of [{ kind: "cancelled" }, true]) {
      let polls = 0;
      const reporter = new Reporter("run", async () => {
        if (++polls > 1) throw new Error("Unexpected replacement retirement poll");
        return Response.json(command);
      });
      await expect(reporter.readyForRetirement()).rejects.toThrow();
      expect(reporter.signal.aborted).toBe(true);
      await expect(reporter.readyForRetirement()).rejects.toThrow();
      expect(polls).toBe(1);
    }
  }));
test("heartbeat holds one physical parse after abort and reports one sticky failure scalar", () =>
  withWindow(async () => {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let beats = 0;
    const failures: unknown[] = [];
    const reporter = new Reporter("run", async (_url, init) => {
      beats++;
      const body: unknown = JSON.parse(String(init.body));
      if (record(body)) failures.push(body.failure);
      const response = Response.json({ kind: "cancelled" });
      const parse = response.json.bind(response);
      response.json = async () => {
        entered.resolve();
        await gate.promise;
        return parse();
      };
      return response;
    });
    reporter.closeAdmission("capacity", "Reporter outbox capacity exceeded");
    reporter.startHeartbeat(2);
    try {
      await entered.promise;
      reporter.cancelDelivery("abort does not settle parse");
      await Bun.sleep(15);
      expect(beats).toBe(1);
      expect(failures).toEqual(["capacity"]);
    } finally {
      reporter.stop();
      gate.resolve();
      await Bun.sleep(0);
    }
  }));
