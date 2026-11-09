import { expect, test } from "bun:test";
import { once } from "node:events";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { FrameworkCollector } from "./framework-collector.js";
import { frameworkMiddleware } from "./framework-middleware.js";
import { FrameworkTraceOwner } from "./framework-trace.js";
import { FrameworkTracePageOwner, tracePostObserver } from "./framework-trace-page.js";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
type Received = { incoming: IncomingMessage; outgoing: ServerResponse };
async function middlewareFixture(
  run: (control: Awaited<ReturnType<typeof middlewareSetup>>) => Promise<void>,
  admitted = true,
): Promise<void> {
  const control = await middlewareSetup(admitted);
  try {
    await run(control);
  } finally {
    await control.close();
  }
}
async function middlewareSetup(admitted: boolean) {
  const collector = new FrameworkCollector([]);
  const top = collector.expect("orchestrator", "http://page/top");
  const tester = collector.expect("tester", "http://page/tester");
  let decisions = 0;
  const owner = new FrameworkTraceOwner({
    collectorResponse: async () => {
      decisions++;
      return "unchanged";
    },
  });
  if (admitted) {
    top.doc = "top";
    tester.doc = "tester";
    top.admitted = tester.admitted = true;
    owner.admit(top, tester);
  }
  const seen: Received[] = [];
  const clients: ReturnType<typeof request>[] = [];
  const joined: Promise<void>[] = [];
  const middleware = frameworkMiddleware(collector, () => owner);
  const server = createServer((incoming, outgoing) => {
    seen.push({ incoming, outgoing });
    middleware(incoming, outgoing, () => outgoing.writeHead(404).end());
  });
  const close = async () => {
    for (const client of clients) client.destroy();
    await Promise.all(joined);
    owner.abandon("cancelled");
    await owner.close(performance.now() + 1000, true);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback address");
    const origin = `http://127.0.0.1:${address.port}`;
    const hold = async () => {
      const index = seen.length;
      const client = request(origin + "/report", { method: "POST" });
      clients.push(client);
      joined.push(new Promise<void>((resolve) => client.once("close", resolve)));
      client.on("error", () => {});
      client.on("response", (response) => response.resume());
      client.write("{");
      while (seen.length <= index) await turn();
      await turn();
      const received = seen[index];
      if (!received) throw new Error("Missing actual middleware entry");
      return { ...received, client };
    };
    return { owner, collector, top, tester, seen, hold, origin, close, decisions: () => decisions };
  } catch (error) {
    await close();
    throw error;
  }
}

for (const phase of ["cancelled", "unadmitted", "closed"] as const) {
  test(`actual collector readers stay owned through ${phase} capture cleanup`, () =>
    middlewareFixture(async (control) => {
      if (phase === "cancelled") control.owner.cancelLiveOperations();
      if (phase === "closed") await control.owner.close(performance.now() + 500, true);
      const received = await control.hold();
      const cleanup = await control.owner.close(performance.now() + 500, true);
      expect(cleanup.status).toBe("confirmed");
      expect(received.incoming.listenerCount("data")).toBe(0);
      expect(received.outgoing.destroyed || received.outgoing.writableFinished).toBe(true);
      expect(control.collector.document("orchestrator")?.messages).toEqual([]);
      expect(control.decisions()).toBe(0);
    }, phase !== "unadmitted"));
}

test("the actual collector middleware refuses reader 65 before body allocation", () =>
  middlewareFixture(async (control) => {
    for (let index = 0; index < 64; index++) await control.hold();
    const refused = await control.hold();
    expect(refused.incoming.listenerCount("data")).toBe(0);
    expect(refused.outgoing.destroyed || refused.outgoing.writableFinished).toBe(true);
    expect((await control.owner.close(performance.now() + 1000, true)).status).toBe("confirmed");
    expect(refused.incoming.listenerCount("data")).toBe(0);
    expect(control.decisions()).toBe(0);
  }));

test("pre-admission collector hello stays available without entering a fixture decision", () =>
  middlewareFixture(async (control) => {
    const response = await fetch(control.origin + "/report", {
      method: "POST",
      body: JSON.stringify({
        run: control.collector.run,
        token: control.top.token,
        doc: "hello-top",
        seq: 0,
        kind: "hello",
        role: "orchestrator",
        url: control.top.url,
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ackedThrough: 0 });
    expect(control.top.doc).toBe("hello-top");
    expect(control.decisions()).toBe(0);
    expect((await control.owner.close(performance.now() + 500, true)).status).toBe("confirmed");
  }, false));

test("a body admitted before physical pairing joins before the actual disposal fence", () =>
  middlewareFixture(async (control) => {
    const clients = new AbortController();
    const pending: Promise<unknown>[] = [];
    try {
      const hello = (document: typeof control.top, doc: string) => ({
        run: control.collector.run,
        token: document.token,
        doc,
        seq: 0,
        kind: "hello",
        role: document.kind,
        url: document.url,
      });
      const topHello = hello(control.top, "paired-top");
      for (const body of [topHello, hello(control.tester, "paired-tester")]) {
        const response = await fetch(control.origin + "/report", {
          method: "POST",
          body: JSON.stringify(body),
          signal: clients.signal,
        });
        expect(response.status).toBe(200);
        await response.text();
      }
      const held = await control.hold();
      control.top.admitted = control.tester.admitted = true;
      const generation = control.owner.admit(control.top, control.tester);
      const url = (role: "orchestrator" | "tester", slot: string) => {
        const document = role === "tester" ? control.tester : control.top;
        return `${control.origin}/__waffle_framework_trace/${role}/${slot}?doc=${document.doc}&token=${document.token}&generation=${generation}`;
      };
      const tester = await fetch(url("tester", "stream"), { signal: clients.signal });
      const top = await fetch(url("orchestrator", "stream"), { signal: clients.signal });
      const authorization = fetch(url("orchestrator", "authorize"), {
        signal: clients.signal,
      }).then((response) => response.text());
      void authorization.catch(() => {});
      let acknowledged = false;
      const testerAck = tester.text().then((text) => {
        acknowledged = true;
        return JSON.parse(text.slice(6));
      });
      const topAck = top.text().then((text) => JSON.parse(text.slice(6)));
      void testerAck.catch(() => {});
      void topAck.catch(() => {});
      pending.push(authorization, testerAck, topAck);
      for (const [role, body] of [
        ["tester", { kind: "terminal", text: "final" }],
        ["orchestrator", { kind: "fence" }],
      ] as const) {
        const response = await fetch(url(role, "body"), {
          method: "POST",
          body: JSON.stringify(body),
          signal: clients.signal,
        });
        expect(response.status).toBe(200);
        await response.text();
      }
      await turn();
      expect(acknowledged).toBe(false);
      held.client.end(JSON.stringify(topHello).slice(1));
      for (const [role, body] of [
        ["tester", await testerAck],
        ["orchestrator", topAck],
      ] as const) {
        const response = await fetch(url(role, "receipt"), {
          method: "POST",
          body: JSON.stringify(await body),
          signal: clients.signal,
        });
        expect(response.status).toBe(200);
        await response.text();
      }
      expect((await control.owner.settleBeforeDestruction(performance.now() + 1000)).status).toBe(
        "confirmed",
      );
      expect(await authorization).toBe("dispose");
    } finally {
      clients.abort();
      await Promise.allSettled(pending);
    }
  }, false));

const terminal = { event: "response:cleanup", iframeId: "file", messageId: 1 };
function pageFixture(snapshot: () => string) {
  const bodies: object[] = [];
  const owner = new FrameworkTracePageOwner("tester", () => true);
  if (owner.document.kind !== "tester") throw new Error("Wrong trace role");
  owner.document.bind({ snapshot, releaseOriginalRpc: () => {} });
  owner.admit("generation", "file", {
    post: async (body) => {
      bodies.push(body);
    },
    receipt: () => {},
    closeEvidence: async () => {},
    authorization: Promise.resolve(""),
  });
  owner.incoming({ ...terminal, event: "cleanup" });
  return { owner, bodies };
}

for (const operation of ["withResolvers", "resolve", "add", "delete"] as const) {
  test(`fixture mutation of ${operation} cannot replace the original post return`, async () => {
    const marker = new Error("poisoned mutable bookkeeping");
    const original = {
      withResolvers: Promise.withResolvers,
      resolve: Promise.resolve,
      add: Set.prototype.add,
      delete: Set.prototype.delete,
    };
    const broken = () => {
      throw marker;
    };
    const control = pageFixture(() => {
      if (operation === "withResolvers") Promise.withResolvers = broken;
      if (operation === "resolve") Promise.resolve = broken;
      if (operation === "add") Set.prototype.add = broken;
      if (operation === "delete") Set.prototype.delete = broken;
      return "recorded";
    });
    const receiver = {},
      returned = {};
    const post = tracePostObserver(
      (_value: unknown) => returned,
      control.owner,
      () => receiver,
    );
    let actual: unknown,
      threw = false;
    try {
      actual = post.call(receiver, terminal);
    } catch {
      threw = true;
    } finally {
      Promise.withResolvers = original.withResolvers;
      Promise.resolve = original.resolve;
      Set.prototype.add = original.add;
      Set.prototype.delete = original.delete;
    }
    expect(threw).toBe(false);
    expect(actual).toBe(returned);
    await turn();
    expect(control.bodies).toEqual([{ kind: "terminal", text: "recorded" }]);
  });
}

test("an internal bookkeeping allocation failure is sticky without replacing the original return", async () => {
  const marker = new Error("failed owned reservation");
  const control = pageFixture(() => {
    Reflect.set(control.owner, "addPending", () => {
      throw marker;
    });
    return "must not commit";
  });
  const add = Reflect.get(control.owner, "addPending");
  const receiver = {},
    returned = {};
  const post = tracePostObserver(
    (_value: unknown) => returned,
    control.owner,
    () => receiver,
  );
  try {
    expect(post.call(receiver, terminal)).toBe(returned);
    expect(Reflect.get(control.owner, "failed")).toBe(true);
  } finally {
    Reflect.set(control.owner, "addPending", add);
  }
  control.owner.posted(terminal);
  await turn();
  expect(control.bodies).toEqual([]);
});
