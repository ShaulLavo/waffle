import { expect, test } from "bun:test";
import { createServer, request as httpRequest, type ServerResponse } from "node:http";
import { once } from "node:events";
import { FrameworkCollector } from "./framework-collector.js";
import { FrameworkTraceOwner, tracePath } from "./framework-trace.js";
import { FrameworkTracePageOwner, tracePostObserver } from "./framework-trace-page.js";
import { frameworkMiddleware } from "./framework-middleware.js";
import type { TesterTraceOptions } from "./framework-types.js";

const cleanupResponse = { event: "response:cleanup", iframeId: "actual-file", messageId: 7 };
const cleanupCommand = { ...cleanupResponse, event: "cleanup" };
const unchanged: TesterTraceOptions = { collectorResponse: async () => "unchanged" };
function pageFixture(snapshot = () => "final") {
  const bodies: object[] = [],
    receipts: object[] = [];
  const authorization = Promise.withResolvers<string>();
  const owner = new FrameworkTracePageOwner("tester", () => true);
  if (owner.document.kind !== "tester") throw new Error("Missing tester");
  owner.document.bind({ snapshot, releaseOriginalRpc: () => {} });
  owner.admit("generation", "actual-file", {
    post: async (body) => {
      bodies.push(body);
    },
    receipt: (body) => {
      receipts.push(body);
    },
    closeEvidence: async () => {},
    authorization: authorization.promise,
  });
  owner.incoming(cleanupCommand);
  return { owner, bodies, receipts };
}
async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("the exact original post receiver, arguments, object return and falsy throws are untouched", async () => {
  const { owner, bodies } = pageFixture();
  const channel = {};
  // eslint-disable-next-line unicorn/no-thenable -- This hostile original return must never be assimilated.
  const returned = Object.defineProperty({}, "then", {
    get(): never {
      throw new Error("Observed original return");
    },
  });
  const args: unknown[][] = [];
  const original = function (this: unknown, ...input: unknown[]) {
    expect(this).toBe(channel);
    args.push(input);
    return returned;
  };
  const observed = tracePostObserver(original, owner, () => channel);
  expect(observed.call(channel, cleanupResponse, "extra")).toBe(returned);
  await turn();
  expect(args).toEqual([[cleanupResponse, "extra"]]);
  expect(bodies).toEqual([{ kind: "terminal", text: "final" }]);
  for (const thrown of [0, false, "", null, undefined]) {
    const control = pageFixture();
    const wrapped = tracePostObserver(
      () => {
        throw thrown;
      },
      control.owner,
      () => channel,
    );
    let caught: unknown = Symbol();
    try {
      wrapped.call(channel);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(thrown);
    expect(control.bodies).toEqual([]);
  }
});
test("accessor fields are not observed, wrong receivers cannot seal, and observation throws stay separate", async () => {
  let reads = 0;
  const control = pageFixture();
  const channel = {};
  const post = tracePostObserver(
    (value: unknown) => value,
    control.owner,
    () => channel,
  );
  const accessor = {
    get event() {
      reads++;
      return "response:cleanup";
    },
    iframeId: "actual-file",
    messageId: 7,
  };
  expect(post.call(channel, accessor)).toBe(accessor);
  post.call({}, cleanupResponse);
  await turn();
  expect(reads).toBe(0);
  expect(control.bodies).toEqual([]);
  const throwing = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw 0;
      },
    },
  );
  expect(post.call(channel, throwing)).toBe(throwing);
  post.call(channel, cleanupResponse);
  await turn();
  expect(control.bodies).toEqual([{ kind: "failure", reason: "conversion" }]);
});
test("encoding reentry cannot let the outer final snapshot commit", async () => {
  let reads = 0;
  const control = pageFixture(() => {
    reads++;
    control.owner.posted(cleanupResponse);
    return "outer";
  });
  control.owner.posted(cleanupResponse);
  await turn();
  expect(reads).toBe(1);
  expect(control.bodies).toEqual([{ kind: "failure", reason: "reentry" }]);
});
test("terminal bytes do not close checkpoint admission or rerun the final reader", async () => {
  let reads = 0;
  const control = pageFixture(() => {
    reads++;
    return "last cleanup error";
  });
  control.owner.posted(cleanupResponse);
  await turn();
  control.owner.command({ kind: "checkpoint" });
  await turn();
  expect(reads).toBe(1);
  expect(control.bodies).toEqual([
    { kind: "terminal", text: "last cleanup error" },
    { kind: "checkpoint", text: "last cleanup error" },
  ]);
});
test("the final UTF-8 slot refuses oversized text without substituting a prefix", async () => {
  for (const text of ["x".repeat(49153), "界".repeat(16385)]) {
    const control = pageFixture(() => text);
    control.owner.posted(cleanupResponse);
    await turn();
    expect(control.bodies).toEqual([{ kind: "failure", reason: "conversion" }]);
  }
});

async function fixture(
  run: (control: Awaited<ReturnType<typeof setup>>) => Promise<void>,
  options = unchanged,
) {
  const control = await setup(options);
  try {
    await run(control);
  } finally {
    await control.close();
  }
}
function holdResponse(response: ServerResponse) {
  const ending = Promise.withResolvers<void>();
  const end = response.end;
  let finish = () => {};
  response.end = function (...args: unknown[]) {
    finish = () => Reflect.apply(end, response, args);
    ending.resolve();
    return this;
  };
  return {
    response,
    ending: ending.promise,
    finish: () => {
      const complete = finish;
      finish = () => {};
      complete();
    },
  };
}
async function setup(options: TesterTraceOptions) {
  const collector = new FrameworkCollector([]);
  const top = collector.expect("orchestrator", "http://page/top"),
    tester = collector.expect("tester", "http://page/tester");
  top.doc = "actual-top";
  tester.doc = "actual-tester";
  top.admitted = true;
  tester.admitted = true;
  const owner = new FrameworkTraceOwner(options);
  // Private CPU admission fixture only. No DOM challenge, driver, installed hook or native credit.
  const generation = owner.admit(top, tester);
  const middleware = frameworkMiddleware(collector, () => owner);
  const physical: ServerResponse[] = [];
  const firstBody = Promise.withResolvers<void>();
  const firstTopReceipt = Promise.withResolvers<void>();
  let bodyHold:
    | ReturnType<typeof Promise.withResolvers<ReturnType<typeof holdResponse>>>
    | undefined;
  const server = createServer((request, response) => {
    if (request.url === "/physical") {
      const reserve = owner.reserveResponse(response);
      if (!reserve) {
        response.writeHead(409).end();
        return;
      }
      physical.push(response);
      reserve(async () => {
        response.writeHead(200);
        response.flushHeaders();
      });
      return;
    }
    if (bodyHold && request.url?.startsWith(tracePath + "tester/body")) {
      const held = holdResponse(response);
      releases.push(held.finish);
      bodyHold.resolve(held);
      bodyHold = undefined;
    }
    middleware(request, response, () => response.writeHead(404).end());
    if (request.url?.startsWith(tracePath + "tester/body")) firstBody.resolve();
    if (request.url?.startsWith(tracePath + "orchestrator/receipt")) firstTopReceipt.resolve();
  });
  const clients = new AbortController();
  const releases: (() => void)[] = [];
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  let origin = "";
  const url = (role: "orchestrator" | "tester", slot: string) => {
    const doc = role === "tester" ? tester : top;
    return `${origin}${tracePath}${role}/${slot}?doc=${doc.doc}&token=${doc.token}&generation=${generation}`;
  };
  const post = async (role: "orchestrator" | "tester", slot: string, body: object) => {
    const response = await fetch(url(role, slot), {
      method: "POST",
      body: JSON.stringify(body),
      signal: clients.signal,
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toBe("ok");
  };
  const stream = async (role: "orchestrator" | "tester") => {
    const response = await fetch(url(role, "stream"), { signal: clients.signal });
    if (!response.body) throw new Error("Missing stream");
    const reader = response.body.getReader();
    readers.push(reader);
    let buffer = "";
    return async () => {
      while (!buffer.includes("\n\n")) {
        const value = await reader.read();
        if (value.done) throw new Error("Missing trace command");
        buffer += new TextDecoder().decode(value.value);
      }
      const end = buffer.indexOf("\n\n"),
        frame = buffer.slice(6, end);
      buffer = buffer.slice(end + 2);
      return JSON.parse(frame);
    };
  };
  const close = async () => {
    for (const release of releases) release();
    for (const response of physical) response.end();
    clients.abort();
    for (const reader of readers) await reader.cancel().catch(() => {});
    owner.abandon("cancelled");
    await owner.close(performance.now() + 100, true);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback port");
    origin = `http://127.0.0.1:${address.port}`;
    return {
      owner,
      post,
      stream,
      generation,
      collector,
      url,
      releases,
      close,
      clients,
      physical,
      holdNextBody: () => {
        bodyHold = Promise.withResolvers<ReturnType<typeof holdResponse>>();
        return bodyHold.promise;
      },
      firstBody: firstBody.promise,
      firstTopReceipt: firstTopReceipt.promise,
      origin,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
async function connections(control: Awaited<ReturnType<typeof setup>>) {
  const tester = await control.stream("tester"),
    top = await control.stream("orchestrator");
  const authorization = fetch(control.url("orchestrator", "authorize"), {
    signal: control.clients.signal,
  }).then((response) => response.text());
  void authorization.catch(() => {});
  return { tester, top, authorization };
}
async function terminalAndFence(control: Awaited<ReturnType<typeof setup>>) {
  await control.post("tester", "body", { kind: "terminal", text: "actual final cleanup trace" });
  await control.post("orchestrator", "body", { kind: "fence" });
}

type LiveCommand = "checkpoint" | "release";
function startCommand(control: Awaited<ReturnType<typeof setup>>, kind: LiveCommand) {
  return kind === "checkpoint"
    ? control.owner.capture.checkpoint()
    : control.owner.capture.releaseOriginalRpc();
}
function commandBody(kind: LiveCommand, text: string) {
  return kind === "checkpoint" ? { kind, text } : { kind };
}
function completionTests(kind: LiveCommand): void {
  test(`${kind} completion frees its actual response slot before an immediate next command`, () =>
    fixture(async (control) => {
      const next = await control.stream("tester");
      const first = startCommand(control, kind);
      expect(await next()).toEqual({ kind });
      const firstPost = control.post("tester", "body", commandBody(kind, "first"));
      void firstPost.catch(() => {});
      const firstResult = await first;
      const second = startCommand(control, kind);
      void second.catch(() => {});
      expect(await Promise.race([next(), second])).toEqual({ kind });
      const secondPost = control.post("tester", "body", commandBody(kind, "second"));
      expect(await second).toEqual(kind === "checkpoint" ? { kind, text: "second" } : undefined);
      expect(firstResult).toEqual(kind === "checkpoint" ? { kind, text: "first" } : undefined);
      await Promise.all([firstPost, secondPost]);
    }));
  test(`${kind} stays pending until its held HTTP response physically finishes`, () =>
    fixture(async (control) => {
      const next = await control.stream("tester");
      const holding = control.holdNextBody();
      const operation = startCommand(control, kind);
      let settled = false;
      void operation.then(
        () => {
          settled = true;
        },
        () => {},
      );
      expect(await next()).toEqual({ kind });
      const post = control.post("tester", "body", commandBody(kind, "held"));
      void post.catch(() => {});
      const held = await holding;
      await held.ending;
      await turn();
      expect(held.response.writableFinished).toBe(false);
      expect(settled).toBe(false);
      held.finish();
      await operation;
      expect(held.response.writableFinished).toBe(true);
      expect(settled).toBe(true);
      await post;
    }));
  test(`${kind} cancellation rejects while its validated HTTP response is still held`, () =>
    fixture(async (control) => {
      const next = await control.stream("tester");
      const holding = control.holdNextBody();
      const operation = startCommand(control, kind);
      const outcome = operation.then(
        () => "fulfilled",
        (error: unknown) => String(error),
      );
      expect(await next()).toEqual({ kind });
      const post = control.post("tester", "body", commandBody(kind, "cancelled prefix"));
      void post.catch(() => {});
      const held = await holding;
      await held.ending;
      control.owner.cancelLiveOperations();
      expect(await outcome).toBe(
        kind === "checkpoint"
          ? "Error: Trace checkpoint cancelled"
          : "Error: Trace RPC release cancelled",
      );
      expect(held.response.writableFinished).toBe(false);
      held.finish();
      await post;
      expect(await outcome).not.toBe("fulfilled");
    }));
}
completionTests("checkpoint");
completionTests("release");

test("actual receiver holds disposal through tester ACK and the final physical top receipt", () =>
  fixture(async (control) => {
    const streams = await connections(control);
    let removal = false;
    const removalContinuation = streams.authorization.then((value) => {
      expect(value).toBe("dispose");
      removal = true;
    });
    await terminalAndFence(control);
    const testerAck = await streams.tester();
    expect(testerAck.kind).toBe("settle");
    await turn();
    expect(removal).toBe(false);
    await control.post("tester", "receipt", testerAck);
    const topAck = await streams.top();
    expect(topAck.kind).toBe("settle");
    await turn();
    expect(removal).toBe(false);
    const settling = control.owner.settleBeforeDestruction(performance.now() + 1000);
    await control.post("orchestrator", "receipt", topAck);
    expect((await settling).status).toBe("confirmed");
    await removalContinuation;
    expect(removal).toBe(true);
  }));
test("a lost top receipt abandons within the original supplied allowance, never upgrades retained bytes", () =>
  fixture(async (control) => {
    const streams = await connections(control);
    await terminalAndFence(control);
    await control.post("tester", "receipt", await streams.tester());
    await streams.top();
    const saved = await control.owner.settleBeforeDestruction(performance.now());
    expect(saved).toEqual({
      status: "incomplete",
      reason: "deadline",
      retained: { kind: "terminal-unconfirmed", text: "actual final cleanup trace" },
    });
    expect(await streams.authorization).toBe("abandon");
    expect(control.owner.result()).toBe(saved);
  }));
test("a real collector response decision can hold evidence after final bytes, and cancellation never releases original RPC", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  await fixture(
    async (control) => {
      control.releases.push(release.resolve);
      const streams = await connections(control);
      const event = { kind: "error", error: "expected fixture error", source: "tester" };
      const response = fetch(new URL("/report", control.url("tester", "body")), {
        method: "POST",
        body: JSON.stringify({
          run: control.collector.run,
          token: control.collector.document("tester")!.token,
          doc: "actual-tester",
          seq: 0,
          kind: "event",
          event,
        }),
        signal: control.clients.signal,
      });
      await entered.promise;
      await terminalAndFence(control);
      let acked = false;
      const ack = streams.tester().then((value) => {
        acked = true;
        return value;
      });
      await turn();
      expect(acked).toBe(false);
      control.owner.cancelLiveOperations();
      expect(() => control.owner.capture.checkpoint()).toThrow("not live");
      release.resolve();
      await response.then((value) => value.text());
      await control.post("tester", "receipt", await ack);
      await control.post("orchestrator", "receipt", await streams.top());
      expect((await control.owner.settleBeforeDestruction(performance.now() + 1000)).status).toBe(
        "confirmed",
      );
      expect(await streams.authorization).toBe("dispose");
    },
    {
      collectorResponse: async (_observation, signal) => {
        entered.resolve();
        expect(signal.aborted).toBe(false);
        await release.promise;
        return "unchanged";
      },
    },
  );
});
test("foreign ingress, duplicate terminal bytes and a checkpoint never create a receipt", () =>
  fixture(async (control) => {
    const foreign = await fetch(control.url("tester", "body").replace("actual-tester", "foreign"), {
      method: "POST",
      body: "{}",
    });
    expect(foreign.status).toBe(409);
    await foreign.text();
    await control.post("tester", "body", { kind: "terminal", text: "same" });
    await control.post("tester", "body", { kind: "terminal", text: "same" });
    expect(control.owner.pending).toBe(true);
    const saved = await control.owner.settleBeforeDestruction(performance.now());
    expect(saved.status).toBe("incomplete");
    expect(saved.status === "incomplete" && saved.retained?.kind).toBe("terminal-unconfirmed");
  }));

test("the actual page fence stays held after its queued receipt until pure authorization is consumed", async () => {
  const authorization = Promise.withResolvers<string>(),
    receipt = Promise.withResolvers<object>();
  const top = new FrameworkTracePageOwner("orchestrator", () => true);
  let closed = false,
    removed = false;
  top.admit("generation", "actual-file", {
    post: async () => {},
    receipt: (body) => receipt.resolve(body),
    closeEvidence: async () => {
      closed = true;
    },
    authorization: authorization.promise,
  });
  top.posted(cleanupCommand);
  top.incoming(cleanupResponse);
  if (top.document.kind !== "orchestrator") throw new Error("Wrong document role");
  const continuation = top.document.waitForTesterTrace().then(() => {
    removed = true;
  });
  top.command({ kind: "settle", artifact: "physical-final", generation: "generation" });
  expect(await receipt.promise).toEqual({ artifact: "physical-final", generation: "generation" });
  expect(closed).toBe(true);
  expect(removed).toBe(false);
  await turn();
  expect(removed).toBe(false);
  authorization.resolve("dispose");
  await continuation;
  expect(removed).toBe(true);
});
test("a cancelled decision that ignores its signal stays physically owned and the saved result never upgrades", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  await fixture(
    async (control) => {
      control.releases.push(release.resolve);
      const streams = await connections(control);
      const request = fetch(new URL("/report", control.url("tester", "body")), {
        method: "POST",
        body: JSON.stringify({
          run: control.collector.run,
          token: control.collector.document("tester")!.token,
          doc: "actual-tester",
          seq: 0,
          kind: "event",
          event: { kind: "error", error: "held", source: "tester" },
        }),
        signal: control.clients.signal,
      });
      void request.catch(() => {});
      await entered.promise;
      await terminalAndFence(control);
      const saved = await control.owner.settleBeforeDestruction(performance.now());
      expect(saved.status).toBe("incomplete");
      expect((await control.owner.close(performance.now())).status).toBe("unconfirmed");
      expect(await streams.authorization).toBe("abandon");
      release.resolve();
      await request.catch(() => {});
      await turn();
      expect((await control.owner.close(performance.now() + 100)).status).toBe("confirmed");
      expect(control.owner.result()).toBe(saved);
    },
    {
      collectorResponse: async (_observation, signal) => {
        entered.resolve();
        await release.promise;
        expect(signal.aborted).toBe(true);
        return "unchanged";
      },
    },
  );
});
test("checkpoint and RPC release have separate single slots and cancellation cannot fake their physical replies", () =>
  fixture(async (control) => {
    const streams = await connections(control);
    const checkpoint = control.owner.capture.checkpoint();
    const release = control.owner.capture.releaseOriginalRpc();
    void checkpoint.catch(() => {});
    void release.catch(() => {});
    expect(await streams.tester()).toEqual({ kind: "checkpoint" });
    expect(await streams.tester()).toEqual({ kind: "release" });
    await expect(control.owner.capture.checkpoint()).rejects.toThrow("occupied");
    await expect(control.owner.capture.releaseOriginalRpc()).rejects.toThrow("occupied");
    control.owner.cancelLiveOperations();
    await expect(checkpoint).rejects.toThrow("cancelled");
    await expect(release).rejects.toThrow("cancelled");
    await control.post("tester", "body", { kind: "checkpoint", text: "prefix only" });
    await control.post("tester", "body", { kind: "release" });
    const saved = await control.owner.settleBeforeDestruction(performance.now());
    expect(saved.status === "incomplete" && saved.retained).toEqual({
      kind: "prefix",
      text: "prefix only",
    });
  }));
test("a conflicting duplicate is sticky and cannot overwrite exact retained terminal bytes", () =>
  fixture(async (control) => {
    await control.post("tester", "body", { kind: "terminal", text: "first" });
    await control.post("tester", "body", { kind: "terminal", text: "conflict" });
    const saved = await control.owner.settleBeforeDestruction(performance.now() + 1000);
    expect(saved).toEqual({
      status: "incomplete",
      reason: "receipt",
      retained: { kind: "terminal-unconfirmed", text: "first" },
    });
    const late = await fetch(control.url("tester", "body"), {
      method: "POST",
      body: JSON.stringify({ kind: "terminal", text: "late" }),
    });
    expect(late.status).toBe(409);
    await late.text();
    expect(control.owner.result()).toBe(saved);
  }));
test("a disconnected pre-admitted authorization slot fails capture without inventing a receipt", () =>
  fixture(async (control) => {
    const tester = await control.stream("tester"),
      top = await control.stream("orchestrator");
    const disconnect = new AbortController();
    const response = await fetch(control.url("orchestrator", "authorize"), {
      signal: disconnect.signal,
    });
    disconnect.abort();
    await response.body?.cancel().catch(() => {});
    await turn();
    expect((await control.owner.settleBeforeDestruction(performance.now())).status).toBe(
      "incomplete",
    );
    void tester;
    void top;
  }));

test("callback return does not join a real response that has not physically finished", () =>
  fixture(async (control) => {
    const streams = await connections(control);
    const response = await fetch(control.origin + "/physical", { signal: control.clients.signal });
    expect(response.status).toBe(200);
    await terminalAndFence(control);
    let acked = false;
    const testerAck = streams.tester().then((value) => {
      acked = true;
      return value;
    });
    await turn();
    expect(acked).toBe(false);
    control.physical[0]!.end("physically finished");
    expect(await response.text()).toBe("physically finished");
    await control.post("tester", "receipt", await testerAck);
    await control.post("orchestrator", "receipt", await streams.top());
    expect((await control.owner.settleBeforeDestruction(performance.now() + 1000)).status).toBe(
      "confirmed",
    );
    expect(await streams.authorization).toBe("dispose");
  }));
test("exactly 64 real response owners fit and the 65th reserves no callback or queued response", () =>
  fixture(async (control) => {
    const responses = await Promise.all(
      Array.from({ length: 64 }, () =>
        fetch(control.origin + "/physical", { signal: control.clients.signal }),
      ),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(control.physical).toHaveLength(64);
    const refused = await fetch(control.origin + "/physical");
    expect(refused.status).toBe(409);
    await refused.text();
    expect(control.physical).toHaveLength(64);
    const saved = await control.owner.settleBeforeDestruction(performance.now());
    expect(saved.status === "incomplete" && saved.reason).toBe("capacity");
    for (const response of control.physical) response.end();
    await Promise.all(responses.map((response) => response.text()));
  }));
test("ingress reserves the one body reader before parsing identity or allocating a second reader", () =>
  fixture(async (control) => {
    const reply = Promise.withResolvers<number | undefined>();
    const body = JSON.stringify({ kind: "terminal", text: "first owned body" });
    const readResponse = (response: import("node:http").IncomingMessage) => {
      response.resume();
      response.once("end", finishResponse.bind(undefined, response, reply));
    };
    const request = httpRequest(control.url("tester", "body"), { method: "POST" }, readResponse);
    request.on("error", reply.reject);
    try {
      request.write(body.slice(0, 1));
      await control.firstBody;
      const extra = await fetch(control.url("tester", "body"), {
        method: "POST",
        body: "unparsed extra ingress",
      });
      expect(extra.status).toBe(409);
      await extra.text();
      request.end(body.slice(1));
      expect(await reply.promise).toBe(200);
      const saved = await control.owner.settleBeforeDestruction(performance.now());
      expect(saved.status === "incomplete" && saved.retained?.text).toBe("first owned body");
    } finally {
      request.destroy();
    }
  }));
test("physical response close before finish leaves evidence incomplete rather than calling a write a receipt", () =>
  fixture(async (control) => {
    const response = await fetch(control.origin + "/physical", { signal: control.clients.signal });
    const read = response.text();
    void read.catch(() => {});
    control.physical[0]!.destroy();
    await read.catch(() => {});
    await turn();
    const saved = await control.owner.settleBeforeDestruction(performance.now());
    expect(saved.status === "incomplete" && saved.reason).toBe("consumers-unconfirmed");
  }));

function finishResponse(
  response: import("node:http").IncomingMessage,
  reply: ReturnType<typeof Promise.withResolvers<number | undefined>>,
): void {
  reply.resolve(response.statusCode);
}

test("terminal and live control replies serialize through the single admitted body reader", async () => {
  const hold = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  const bodies: object[] = [];
  let active = 0,
    releases = 0;
  const owner = new FrameworkTracePageOwner("tester", () => true);
  if (owner.document.kind !== "tester") throw new Error("Wrong trace role");
  owner.document.bind({
    snapshot: () => "sealed",
    releaseOriginalRpc: () => {
      releases++;
    },
  });
  owner.admit("generation", "actual-file", {
    post: async (body) => {
      expect(active++).toBe(0);
      bodies.push(body);
      entered.resolve();
      await hold.promise;
      active--;
    },
    receipt: () => {},
    closeEvidence: async () => {},
    authorization: Promise.resolve(""),
  });
  try {
    owner.incoming(cleanupCommand);
    owner.posted(cleanupResponse);
    await entered.promise;
    owner.command({ kind: "checkpoint" });
    owner.command({ kind: "release" });
    await turn();
    expect(bodies).toEqual([{ kind: "terminal", text: "sealed" }]);
  } finally {
    hold.resolve();
    await turn();
  }
  expect(bodies).toEqual([
    { kind: "terminal", text: "sealed" },
    { kind: "checkpoint", text: "sealed" },
    { kind: "release" },
  ]);
  expect(releases).toBe(1);
});

test("an actually entered top receipt body handler must join before disposal authorization", () =>
  fixture(async (control) => {
    const streams = await connections(control);
    await terminalAndFence(control);
    await control.post("tester", "receipt", await streams.tester());
    const ack = await streams.top();
    const body = JSON.stringify(ack),
      reply = Promise.withResolvers<number | undefined>();
    const read = (response: import("node:http").IncomingMessage) => {
      response.resume();
      response.once("end", finishResponse.bind(undefined, response, reply));
    };
    const request = httpRequest(control.url("orchestrator", "receipt"), { method: "POST" }, read);
    request.on("error", reply.reject);
    let removed = false;
    const continuation = streams.authorization.then((text) => {
      expect(text).toBe("dispose");
      removed = true;
    });
    try {
      request.write(body.slice(0, -1));
      await control.firstTopReceipt;
      await turn();
      expect(control.owner.pending).toBe(true);
      expect(removed).toBe(false);
      request.end(body.slice(-1));
      expect(await reply.promise).toBe(200);
      expect((await control.owner.settleBeforeDestruction(performance.now() + 1000)).status).toBe(
        "confirmed",
      );
      await continuation;
      expect(removed).toBe(true);
    } finally {
      request.destroy();
    }
  }));
