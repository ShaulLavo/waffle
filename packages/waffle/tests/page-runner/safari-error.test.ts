import { expect, test } from "bun:test";
import { WebDriverError } from "./driver.js";
import { SafariDriver } from "./safari-driver.js";

for (const message of ["", "The session has ended"]) {
  test(`WebDriver error text retains its code with message ${JSON.stringify(message)}`, () => {
    const error = new WebDriverError("invalid session id", message);
    expect(error.code).toBe("invalid session id");
    expect(String(error)).toContain("invalid session id");
    if (message) expect(String(error)).toContain(message);
  });
}

test("failed session deletion retains an empty-message WebDriver code in cleanup", async () => {
  const calls: string[] = [];
  const udid = "10128D70-92A7-4626-9CE5-1537CF27BE84";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (path === "/session")
        return Response.json({
          value: {
            sessionId: "error-control-session",
            capabilities: {
              browserName: "Safari",
              browserVersion: "26.5",
              platformName: "iOS",
              "safari:useSimulator": true,
              "safari:deviceUDID": udid,
            },
          },
        });
      if (request.method === "DELETE")
        return Response.json(
          { value: { error: "invalid session id", message: "", stacktrace: "" } },
          { status: 404 },
        );
      return Response.json({ value: null });
    },
  });
  try {
    const driver = new SafariDriver(udid, "no-native-resources");
    await driver.startControl(server.url.origin, AbortSignal.timeout(2000));
    const cleanup = await driver.stop();
    expect(cleanup.session.status).toBe("unconfirmed");
    expect(cleanup.session.detail).toContain("invalid session id");
    expect(cleanup.session.detail).toContain('"sessionId":"error-control-session"');
    expect(cleanup.launcher.status).toBe("not-created");
    expect(await driver.stop()).toBe(cleanup);
    expect(calls).toEqual([
      "POST /session",
      "POST /session/error-control-session/timeouts",
      "DELETE /session/error-control-session",
    ]);
  } finally {
    await server.stop(true);
  }
});
