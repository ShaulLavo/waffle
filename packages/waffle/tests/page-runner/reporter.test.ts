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
      return url === "/heartbeat" ? Response.json(true) : acknowledge(init);
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
