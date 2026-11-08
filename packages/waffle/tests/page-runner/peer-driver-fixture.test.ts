import { expect, test } from "bun:test";
import { bounded } from "./driver.js";
import { PeerDriverFixture } from "./peer-driver-fixture.js";
import { record } from "./protocol.js";

function retirementFixture(driver = new PeerDriverFixture()) {
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
      if (path === "/heartbeat") return Response.json({ kind: "live", retire: true });
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
    response.resolve(Response.json({ kind: "live", retire: false }));
    await bounded(stopping, 1000, "retirement poll joined");
    await server.stop(true);
    await Bun.sleep(5);
    expect(stopped).toBe(true);
    expect(fixture.polls()).toBe(1);
    expect(fixture.reports).toEqual(["hello", "list", "doc-complete"]);
  } finally {
    response.resolve(Response.json({ kind: "live", retire: false }));
    await driver.stop();
    await server.stop(true);
  }
});

for (const action of ["navigate", "close"] as const) {
  test(`peer driver ${action} joins the predecessor retirement poll`, async () => {
    const fixture = retirementFixture();
    const { driver, server, entered, response } = fixture;
    try {
      await driver.navigate(server.url.href);
      await bounded(entered.promise, 1000, "predecessor retirement poll entered");
      const predecessor = driver.windows.get("root");
      let completed = false;
      const operation =
        action === "navigate" ? driver.navigate(server.url.href) : driver.closeWindow();
      const changing = operation.then(() => {
        completed = true;
      });
      await Bun.sleep(0);
      expect(completed).toBe(false);
      expect(driver.windows.get("root")).toBe(predecessor);
      response.resolve(Response.json({ kind: "live", retire: false }));
      await bounded(changing, 1000, "predecessor retirement poll joined");
      expect(driver.windows.get("root")).not.toBe(predecessor);
    } finally {
      response.resolve(Response.json({ kind: "live", retire: false }));
      await driver.stop();
      await server.stop(true);
    }
  });
}

test("peer driver stop preserves a failed retirement request", async () => {
  const fixture = retirementFixture();
  const { driver, server, entered, response } = fixture;
  try {
    await driver.navigate(server.url.href);
    await bounded(entered.promise, 1000, "failing retirement poll entered");
    const stopping = driver.stop().then(
      () => undefined,
      (error: unknown) => error,
    );
    await server.stop(true);
    const error = await bounded(stopping, 1000, "failed retirement poll joined");
    expect(error).toBeInstanceOf(Error);
    await expect(driver.stop()).rejects.toBe(error);
    expect(fixture.polls()).toBe(1);
  } finally {
    response.resolve(Response.json({ kind: "live", retire: false }));
    await server.stop(true);
  }
});

test("peer driver joins every document before surfacing a retirement failure", async () => {
  const first = retirementFixture();
  const second = retirementFixture(first.driver);
  const driver = first.driver;
  try {
    await driver.navigate(first.server.url.href);
    await bounded(first.entered.promise, 1000, "first poll entry");
    const other = await driver.createWindow();
    await driver.selectWindow(other);
    await driver.navigate(second.server.url.href);
    await bounded(second.entered.promise, 1000, "second poll entry");
    const firstPage = driver.windows.get("root");
    if (!firstPage) throw new Error("Missing first document");
    let settled = false;
    const stopping = driver
      .stop()
      .then(
        () => ({ fulfilled: true }),
        (reason: unknown) => ({ rejected: reason }),
      )
      .finally(() => {
        settled = true;
      });
    await first.server.stop(true);
    const failed = await bounded(
      firstPage.stop().then(
        () => ({ fulfilled: true }),
        (reason: unknown) => ({ rejected: reason }),
      ),
      1000,
      "first poll failure",
    );
    expect(failed).toHaveProperty("rejected");
    await Bun.sleep(0);
    expect(settled).toBe(false);
    expect(second.polls()).toBe(1);
    second.response.resolve(Response.json({ kind: "live", retire: false }));
    expect(await bounded(stopping, 1000, "all retirement polls joined")).toStrictEqual(failed);
  } finally {
    first.response.resolve(Response.json({ kind: "live", retire: false }));
    second.response.resolve(Response.json({ kind: "live", retire: false }));
    await driver.stop().catch(() => {});
    await first.server.stop(true);
    await second.server.stop(true);
  }
});

for (const reason of [undefined, null, false, 0, ""]) {
  test(`peer driver joined stop preserves falsy rejection ${String(reason)}`, async () => {
    const { driver, server, entered, response } = retirementFixture();
    try {
      await driver.navigate(server.url.href);
      await bounded(entered.promise, 1000, "falsy poll entry");
      const page = driver.windows.get("root");
      if (!page) throw new Error("Missing document");
      const send = page.reporter.send.bind(page.reporter);
      page.reporter.send = (body) =>
        body.kind === "retire-ready" ? Promise.reject(reason) : send(body);
      const stopped = driver.stop().then(
        () => ({ fulfilled: true }),
        (error: unknown) => ({ rejected: error }),
      );
      response.resolve(Response.json({ kind: "live", retire: true }));
      expect(await bounded(stopped, 1000, "falsy poll joined")).toStrictEqual({ rejected: reason });
      expect(
        await driver.stop().then(
          () => ({ fulfilled: true }),
          (error: unknown) => ({ rejected: error }),
        ),
      ).toStrictEqual({ rejected: reason });
    } finally {
      response.resolve(Response.json({ kind: "live", retire: false }));
      await driver.stop().catch(() => {});
      await server.stop(true);
    }
  });
}

for (const reply of [
  () => new Response("{not json"),
  () => Response.json({ kind: "live", retire: "invalid" }),
  () => Response.json({ kind: "live", retire: true }, { status: 503 }),
]) {
  test("peer stop preserves genuine invalid control reply after reporter abort", async () => {
    const fixture = retirementFixture();
    try {
      await fixture.driver.navigate(fixture.server.url.href);
      await bounded(fixture.entered.promise, 1000, "invalid control poll entry");
      const stopping = fixture.driver.stop();
      fixture.response.resolve(reply());
      const settled = await bounded(
        stopping.then(
          () => ({ fulfilled: true }),
          (error: unknown) => ({ rejected: error }),
        ),
        1000,
        "invalid control joined",
      );
      expect(settled).toHaveProperty("rejected");
      if (!("rejected" in settled)) throw new Error("Invalid control was accepted");
      expect(settled.rejected).toBeInstanceOf(Error);
      await expect(fixture.driver.stop()).rejects.toBe(settled.rejected);
    } finally {
      fixture.response.resolve(Response.json({ kind: "cancelled" }));
      await fixture.driver.stop().catch(() => {});
      await fixture.server.stop(true);
    }
  });
}
