import { expect, test } from "bun:test";
import { runHostPage } from "./host-page.js";
import { Reporter } from "./reporter.js";
import type { Body } from "./protocol.js";

test("page diagnostics and disposal use the passed absolute bound, not a new hook allowance", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  const release = Promise.withResolvers<void>();
  const messages: Body[] = [];
  let hookEnded = false;
  try {
    const reporter = new Reporter("run");
    reporter.send = async (body) => {
      messages.push(body);
    };
    const deadline = performance.timeOrigin + performance.now() + 80;
    const running = runHostPage(
      {
        run: "run",
        token: "token",
        group: "case",
        ledger: [],
        role: "case",
        caseId: "case",
        request: null,
        execution: "host",
        teardownMs: 10_000,
      },
      {
        kind: "host",
        teardown: async () => {
          await release.promise;
          hookEnded = true;
        },
      },
      reporter,
      (value) => value,
    );
    await Bun.sleep(55);
    window.__hostCase.phase = "driving";
    window.__hostCase.verdict({ status: "fail", error: "PRIMARY" }, deadline);
    await running;
    expect(hookEnded).toBe(false);
    const terminal = messages.find((body) => body.kind === "case-end");
    expect(terminal).toMatchObject({ kind: "case-end", status: "fail" });
    expect(JSON.stringify(terminal)).toContain("PRIMARY");
    expect(JSON.stringify(terminal)).toContain('"settled":false');
    expect(performance.timeOrigin + performance.now() - deadline).toBeLessThan(100);
    release.resolve();
    await release.promise;
    expect(JSON.stringify(terminal)).toContain('"settled":false');
  } finally {
    release.resolve();
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
