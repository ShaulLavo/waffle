import { expect, test } from "bun:test";
import { bounded } from "./driver.js";
import { PeerDriverFixture } from "./peer-driver-fixture.js";
import { record } from "./protocol.js";

function retirementFixture() {
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const reports: string[] = [];
  let polls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/retire") {
        polls++;
        entered.resolve();
        return response.promise;
      }
      if (path === "/heartbeat") return Response.json(true);
      if (path === "/report") {
        const body: unknown = await request.json();
        if (!record(body) || typeof body.seq !== "number" || typeof body.kind !== "string")
          throw new Error("Invalid fixture report");
        reports.push(body.kind);
        return Response.json({ ackedThrough: body.seq });
      }
      const config = { run: "poll-unit", token: "list", group: "list", role: "list" };
      return new Response(`<script>window.__suiteConfiguration=${JSON.stringify(config)}</script>`);
    },
  });
  const driver = new PeerDriverFixture();
  return { driver, server, entered, response, reports, polls: () => polls };
}

test("peer driver stop joins a retirement poll before the collector closes", async () => {
  const fixture = retirementFixture();
  const { driver, server, entered, response } = fixture;
  try {
    await driver.navigate(server.url.href);
    await bounded(entered.promise, 1000, "retirement poll entered");
    let stopped = false;
    const stopping = driver.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(0);
    expect(stopped).toBe(false);
    response.resolve(Response.json(false));
    await bounded(stopping, 1000, "retirement poll joined");
    await server.stop(true);
    await Bun.sleep(5);
    expect(stopped).toBe(true);
    expect(fixture.polls()).toBe(1);
    expect(fixture.reports).toEqual(["hello", "list", "doc-complete"]);
  } finally {
    response.resolve(Response.json(false));
    await driver.stop();
    await server.stop(true);
  }
});
