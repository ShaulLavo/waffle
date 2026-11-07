import { expect, test } from "bun:test";
import { createServer, request as httpRequest, type Server } from "node:http";
import { once } from "node:events";
import { frameworkMiddleware } from "./framework-middleware.js";
async function fixture(
  run: (origin: string, failures: string[], count: () => number) => Promise<void>,
) {
  const failures: string[] = [];
  let count = 0;
  const middleware = frameworkMiddleware({
    receive() {
      count++;
      return { ackedThrough: 0 };
    },
    heartbeat() {},
    retirement: () => false,
    fail: (category, detail) => failures.push(`${category}: ${detail}`),
  });
  const server: Server = createServer((request, response) =>
    middleware(request, response, () => {
      if (
        request.readableFlowing !== null ||
        response.headersSent ||
        response.hasHeader("Cache-Control")
      )
        throw new Error("Unknown route was touched");
      response.end("original-route");
    }),
  );
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing middleware control port");
    await run(`http://127.0.0.1:${address.port}`, failures, () => count);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
test("unknown Vite routes pass through without body consumption or header changes, reserved errors never become HTML", () =>
  fixture(async (origin, failures, count) => {
    expect(
      await (
        await fetch(origin + "/@fs/original.ts", { method: "POST", body: "untouched" })
      ).text(),
    ).toBe("original-route");
    const method = await fetch(origin + "/report");
    expect(method.status).toBe(405);
    expect(method.headers.get("Cache-Control")).toBe("no-store");
    expect((await fetch(origin + "/report", { method: "POST", body: "{}" })).status).toBe(200);
    const malformed = await fetch(origin + "/report", { method: "POST", body: "{" });
    expect(malformed.status).toBe(409);
    expect(await malformed.text()).not.toContain("original-route");
    expect(count()).toBe(1);
    expect(failures).toHaveLength(1);
  }));
test("the mounted collector caps actual streaming bytes at 65536 before state mutation", () =>
  fixture(async (origin, failures, count) => {
    const response = await fetch(origin + "/report", { method: "POST", body: " ".repeat(65537) });
    expect(response.status).toBe(409);
    expect(count()).toBe(0);
    expect(failures.join("\n")).toContain("65536");
  }));
test(
  "a partial report body expires and cancels its reader without leaving an owned socket",
  () =>
    fixture(async (origin, failures, count) => {
      const reply = Promise.withResolvers<number | undefined>();
      const request = httpRequest(origin + "/report", { method: "POST" }, (response) => {
        response.resume();
        reply.resolve(response.statusCode);
      });
      request.on("error", reply.reject);
      try {
        request.write("{");
        expect(await reply.promise).toBe(409);
        expect(count()).toBe(0);
        expect(failures.length).toBeGreaterThan(0);
      } finally {
        request.destroy();
      }
    }),
  5000,
);
