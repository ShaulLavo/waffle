import { expect, spyOn, test } from "bun:test";
import { SafariDriver, type NativeCommandFailure } from "./safari-driver.js";

const udid = "10128D70-92A7-4626-9CE5-1537CF27BE84";
function sessionAnswer(): Response {
  return Response.json({
    value: {
      sessionId: "startup-session",
      capabilities: {
        browserName: "Safari",
        browserVersion: "26.5",
        platformName: "iOS",
        "safari:useSimulator": true,
        "safari:deviceUDID": udid,
      },
    },
  });
}

test("session creation accepts headers after five seconds without changing command or cleanup bounds", async () => {
  const release = Promise.withResolvers<void>();
  const calls: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (path !== "/session") return Response.json({ value: null });
      timer = setTimeout(release.resolve, 5200);
      await release.promise;
      return sessionAnswer();
    },
  });
  const timeout = spyOn(AbortSignal, "timeout");
  const driver = new SafariDriver(udid, "no-native-resources");
  Reflect.set(driver, "startLauncher", async (signal: AbortSignal) => {
    signal.throwIfAborted();
    Reflect.set(driver, "base", server.url.origin);
  });
  const signal = new AbortController().signal;
  try {
    await driver.start(signal);
    expect(driver.connection().sessionId).toBe("startup-session");
    await driver.script("return null", signal);
    await driver.press("Enter", { signal, dispatch: (send) => send() });
    expect((await driver.stop()).session.status).toBe("confirmed");
    expect(driver.uncertain).toBe(false);
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([
      20_000, 30_000, 5000, 5000, 5000, 5000, 5000,
    ]);
    expect(calls).toEqual([
      "POST /session",
      "POST /session/startup-session/timeouts",
      "POST /session/startup-session/execute/sync",
      "POST /session/startup-session/actions",
      "DELETE /session/startup-session",
    ]);
  } finally {
    clearTimeout(timer);
    release.resolve();
    await driver.stop();
    timeout.mockRestore();
    await server.stop(true);
  }
}, 8000);

for (const abort of ["deadline", "caller"] as const) {
  test(`session creation ${abort} preserves exact header failure timing without retry`, async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        calls++;
        entered.resolve();
        await release.promise;
        return sessionAnswer();
      },
    });
    const failures: NativeCommandFailure[] = [];
    const driver = new SafariDriver(udid, "no-native-resources", (facts) => failures.push(facts));
    const deadline = new AbortController();
    const caller = new AbortController();
    const realTimeout = AbortSignal.timeout;
    const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
      ms === 30_000 ? deadline.signal : realTimeout(ms),
    );
    const clock = { now: 123.25 };
    const now = spyOn(performance, "now").mockImplementation(() => clock.now);
    const reason =
      abort === "deadline"
        ? new DOMException("Session creation cancelled", "TimeoutError")
        : new TypeError("Session creation cancelled");
    const pending = driver
      .startControl(server.url.origin, caller.signal)
      .catch((error: unknown) => error);
    try {
      await entered.promise;
      expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([30_000]);
      clock.now = abort === "deadline" ? 30_123.875 : 987.5;
      (abort === "deadline" ? deadline : caller).abort(reason);
      expect(await pending).toBe(reason);
      expect(failures).toEqual([
        {
          client: "direct",
          operation: null,
          phase: null,
          method: "POST",
          path: "/session",
          dispatchedAt: 123.25,
          settledAt: clock.now,
          stage: "headers",
          status: null,
          abort,
          errorName: abort === "deadline" ? "TimeoutError" : "TypeError",
          errorCode: null,
        },
      ]);
      expect(failures.map((facts) => facts.settledAt - facts.dispatchedAt)).toEqual([
        abort === "deadline" ? 30_000.625 : 864.25,
      ]);
      expect(driver.uncertain).toBe(true);
      expect((await driver.stop()).session.status).toBe("unconfirmed");
      expect(calls).toBe(1);
    } finally {
      caller.abort(reason);
      release.resolve();
      await pending;
      now.mockRestore();
      timeout.mockRestore();
      await driver.stop();
      await server.stop(true);
    }
  });
}
