import { expect, spyOn, test } from "bun:test";
import { SafariDriver } from "./safari-driver.js";

const udid = "10128D70-92A7-4626-9CE5-1537CF27BE84";
const target = "http://fixture/navigation";
type Call = { method: string; path: string; body: unknown };

function reply(call: Call): Response {
  if (call.path.endsWith("/window/new"))
    return Response.json({ value: { handle: "peer", type: "tab" } });
  if (call.path.endsWith("/window/handles") || call.method === "DELETE")
    return Response.json({ value: ["root"] });
  if (call.method === "GET")
    return Response.json({ value: call.path.endsWith("/url") ? target : "root" });
  return Response.json({ value: null });
}

async function control(
  run: (driver: SafariDriver, calls: Call[]) => Promise<void>,
  respond: (call: Call) => Promise<Response> | Response = reply,
  cleanup = () => {},
): Promise<void> {
  const calls: Call[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const call = {
        method: request.method,
        path: new URL(request.url).pathname,
        body: request.body ? await request.json() : null,
      };
      calls.push(call);
      if (call.path !== "/session") return respond(call);
      return Response.json({
        value: {
          sessionId: "navigation-session",
          capabilities: {
            browserName: "Safari",
            browserVersion: "26.5",
            platformName: "iOS",
            "safari:useSimulator": true,
            "safari:deviceUDID": udid,
          },
        },
      });
    },
  });
  try {
    const driver = new SafariDriver(udid, "no-native-resources");
    await driver.startControl(server.url.origin, AbortSignal.timeout(2000));
    await run(driver, calls);
  } finally {
    cleanup();
    await server.stop(true);
  }
}

function navigation(call: Call): boolean {
  return call.method === "POST" && call.path.endsWith("/url");
}

test("navigation accepts a real HTTP reply after the old five-second cutoff", async () => {
  const release = Promise.withResolvers<void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await control(
    async (driver, calls) => {
      await driver.navigate(target, AbortSignal.timeout(30_000));
      expect(driver.uncertain).toBe(false);
      expect(calls.filter(navigation)).toEqual([
        { method: "POST", path: "/session/navigation-session/url", body: { url: target } },
      ]);
      expect((await driver.stop()).session.status).toBe("confirmed");
    },
    async (call) => {
      if (!navigation(call)) return Response.json({ value: null });
      timer = setTimeout(release.resolve, 5200);
      await release.promise;
      return Response.json({ value: null });
    },
    () => {
      clearTimeout(timer);
      release.resolve();
    },
  );
}, 8000);

test("session pageLoad keeps the original thirty-second load allowance", async () => {
  await control(async (driver, calls) => {
    expect(calls.find((call) => call.path.endsWith("/timeouts"))?.body).toEqual({
      implicit: 0,
      pageLoad: 30_000,
      script: 3000,
    });
    expect((await driver.stop()).session.status).toBe("confirmed");
  });
});

for (const kind of ["cancellation", "deadline"] as const) {
  test(`navigation ${kind} promptly retains uncertainty and blocks later dispatch`, async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await control(
        async (driver, calls) => {
          const controller = new AbortController();
          const reason = new Error("Caller revoked navigation");
          const signal = kind === "deadline" ? AbortSignal.timeout(100) : controller.signal;
          const started = performance.now();
          const pending = driver.navigate(target, signal).then(
            () => undefined,
            (error: unknown) => error,
          );
          await entered.promise;
          if (kind === "cancellation") timer = setTimeout(() => controller.abort(reason), 10);
          expect(await pending).toBe(signal.reason);
          expect(signal.aborted).toBe(true);
          expect(performance.now() - started).toBeLessThan(1000);
          expect(driver.uncertain).toBe(true);
          const before = calls.length;
          await expect(driver.navigate(target, AbortSignal.timeout(1000))).rejects.toThrow(
            "Uncertain",
          );
          expect(calls.length).toBe(before);
          release.resolve();
          expect((await driver.stop()).session.status).toBe("confirmed");
          expect(driver.uncertain).toBe(true);
        },
        async (call) => {
          if (!navigation(call)) return Response.json({ value: null });
          entered.resolve();
          await release.promise;
          return Response.json({ value: null });
        },
        release.resolve,
      );
    } finally {
      clearTimeout(timer);
      release.resolve();
    }
  });
}

test("an exhausted caller signal cannot dispatch navigation", async () => {
  await control(async (driver, calls) => {
    const signal = AbortSignal.abort(new Error("Already expired"));
    const before = calls.length;
    await expect(driver.navigate(target, signal)).rejects.toThrow("Already expired");
    expect(calls.length).toBe(before);
    expect((await driver.stop()).session.status).toBe("confirmed");
  });
});

test("only navigation uses the thirty-second transport bound", async () => {
  await control(async (driver) => {
    const signal = new AbortController().signal;
    const timeout = spyOn(AbortSignal, "timeout");
    try {
      await driver.navigate(target, signal);
      expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([30_000]);
      timeout.mockClear();
      await driver.createWindow(signal);
      await driver.selectWindow("root", signal);
      await driver.handle(signal);
      await driver.handles(signal);
      await driver.url(signal);
      await driver.closeWindow(signal);
      await driver.reloadWindow(signal);
      await driver.script("return null", signal);
      expect(timeout.mock.calls.map(([ms]) => ms)).toEqual(Array<number>(8).fill(5000));
      timeout.mockClear();
      expect((await driver.stop()).session.status).toBe("confirmed");
      expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([5000, 5000]);
    } finally {
      timeout.mockRestore();
    }
  });
});

for (const kind of ["navigation", "script"] as const) {
  test(`${kind} transport expiry and failed deletion retain cleanup debt`, async () => {
    const release = Promise.withResolvers<void>();
    await control(
      async (driver, calls) => {
        const realTimeout = AbortSignal.timeout;
        const timeout = spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
          realTimeout(ms === 5000 || ms === 30_000 ? 25 : ms),
        );
        const signal = new AbortController().signal;
        const started = performance.now();
        try {
          const pending =
            kind === "navigation"
              ? driver.navigate(target, signal)
              : driver.script("return null", signal);
          await expect(pending).rejects.toThrow("timed out");
          expect(driver.uncertain).toBe(true);
          const before = calls.length;
          await expect(driver.navigate(target, signal)).rejects.toThrow("Uncertain");
          expect(calls.length).toBe(before);
          const cleanup = await driver.stop();
          expect(cleanup.session.status).toBe("unconfirmed");
          expect(cleanup.launcher.status).toBe("not-created");
          expect(await driver.stop()).toBe(cleanup);
          expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
          expect(performance.now() - started).toBeLessThan(1000);
        } finally {
          timeout.mockRestore();
        }
      },
      async (call) => {
        if (call.path.endsWith("/timeouts")) return Response.json({ value: null });
        await release.promise;
        return Response.json({ value: null });
      },
      release.resolve,
    );
  });
}
