import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { FrameworkQueue } from "./framework-queue.js";
import { HostConsumers } from "./owned-consumers.js";
import { SafariDriver } from "./safari-driver.js";
import type { CommandFailure } from "./framework-types.js";

function observedThenable(read: () => unknown): object {
  return new Proxy({}, { get: (_target, key) => (key === "then" ? read() : undefined) });
}
async function emitFailedRequest(
  queue: FrameworkQueue,
  client: EventEmitter,
  error: unknown,
): Promise<void> {
  await queue.run(async () => {
    const request = queue.guard({
      method: "POST",
      body: "private-script",
      headers: { authorization: "private-token" },
    });
    client.emit("request.performance", { request, error });
  });
}
function partialBody(headers: ReturnType<typeof Promise.withResolvers<void>>): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":'));
        headers.resolve();
      },
    }),
  );
}
function queueFixture() {
  const faults: string[] = [];
  const queue = new FrameworkQueue(
    new HostConsumers(),
    () => {},
    (fault) => faults.push(fault),
  );
  const client = new EventEmitter();
  queue.observe(client);
  return { queue, client, faults };
}

test("attached failure facts are bounded, payload-free and do not read error accessors", async () => {
  const { queue, client } = queueFixture();
  let reads = 0;
  const secret = {
    get message() {
      reads++;
      throw new Error("private");
    },
  };
  try {
    for (let index = 0; index < 140; index++) {
      await expect(emitFailedRequest(queue, client, secret)).rejects.toThrow(
        "WebDriver transport failed before an observed parsed response",
      );
    }
    expect(queue.commandFailures).toHaveLength(128);
    expect(queue.commandFailures[0]).toMatchObject({
      client: "attached",
      method: "POST",
      path: null,
      stage: "unknown",
      status: null,
      abort: null,
    });
    expect(JSON.stringify(queue.commandFailures)).not.toContain("private");
    expect(reads).toBe(0);
  } finally {
    queue.releaseObservers();
  }
  expect(client.listenerCount("request.performance")).toBe(0);
});

test("attached request/response values and one-time thenable assimilation stay unchanged", async () => {
  const { queue } = queueFixture();
  const rejection = Object.freeze({
    get message() {
      throw new Error("must not read");
    },
  });
  let reads = 0;
  try {
    for (const value of [null, false, 0, "", undefined, { native: true }]) {
      expect(await queue.run(() => Promise.resolve(value))).toBe(value);
    }
    const thenable = observedThenable(() => {
      reads++;
      return (_resolve: unknown, reject: (error: unknown) => void) => reject(rejection);
    });
    const result = queue.run(() => Promise.resolve(thenable));
    expect(await result.catch((error: unknown) => error)).toBe(rejection);
    expect(reads).toBe(1);
    await queue.run(async () => {
      const request = queue.guard({ method: "GET" });
      const response = { statusCode: 200, body: { value: false } };
      expect(queue.response(response, request)).toBe(response);
    });
    expect(queue.commandFailures).toEqual([]);
  } finally {
    queue.releaseObservers();
  }
});

test("direct failures identify headers versus body and preserve the exact caller rejection", async () => {
  const release = Promise.withResolvers<void>();
  const headers = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/execute/sync")) {
        return partialBody(headers);
      }
      headers.resolve();
      await release.promise;
      return Response.json({ value: null });
    },
  });
  const failures: CommandFailure[] = [];
  try {
    for (const stage of ["headers", "body"] as const) {
      const driver = new SafariDriver("not-native", "no-resources", (fact) => failures.push(fact));
      Reflect.set(driver, "base", `http://127.0.0.1:${server.port}`);
      Reflect.set(driver, "session", "private-session");
      const controller = new AbortController();
      const rejection = new Error("private-caller-reason");
      const pending =
        stage === "body"
          ? driver.script("private-script", controller.signal)
          : driver.handle(controller.signal);
      await headers.promise;
      await Bun.sleep(20);
      controller.abort(rejection);
      expect(await pending.catch((error: unknown) => error)).toBe(rejection);
      const fact = failures.at(-1);
      expect(fact).toMatchObject({
        client: "direct",
        stage,
        abort: "caller",
        errorName: "Error",
        errorCode: null,
        status: stage === "body" ? 200 : null,
      });
      expect(fact?.settledAt).toBeGreaterThanOrEqual(fact?.dispatchedAt ?? Infinity);
      expect(fact?.path).toBe(
        stage === "body" ? "/session/:session/execute/sync" : "/session/:session/window",
      );
    }
    expect(JSON.stringify(failures)).not.toContain("private");
  } finally {
    release.resolve();
    await server.stop(true);
  }
});

test("a disabled direct observer adds no reads or changes to native failures", async () => {
  const driver = new SafariDriver("not-native", "no-resources");
  Reflect.set(driver, "base", "http://127.0.0.1:1");
  Reflect.set(driver, "session", "owned");
  const rejection = new Error("exact reason");
  const controller = new AbortController();
  controller.abort(rejection);
  expect(
    await driver.script("not recorded", controller.signal).catch((error: unknown) => error),
  ).toBe(rejection);
});

test("falsy and accessor rejections pass through the queue without replacement", async () => {
  const { queue } = queueFixture();
  let reads = 0;
  const getterFailure = Object.freeze({ private: true });
  const thenable = observedThenable(() => {
    reads++;
    throw getterFailure;
  });
  try {
    for (const reason of [false, 0, "", null, undefined, new Error("native")]) {
      const caught = await queue
        .run(() => Promise.reject(reason))
        .then(
          () => ({ fulfilled: true, reason: null }),
          (error: unknown) => ({ fulfilled: false, reason: error }),
        );
      expect(caught.fulfilled).toBe(false);
      expect(caught.reason).toBe(reason);
    }
    expect(await queue.run(() => Promise.resolve(thenable)).catch((error: unknown) => error)).toBe(
      getterFailure,
    );
    expect(reads).toBe(1);
  } finally {
    queue.releaseObservers();
  }
});

test("a throwing direct observer cannot replace an exact rejection", async () => {
  const driver = new SafariDriver("not-native", "no-resources", () => {
    throw new Error("observer");
  });
  Reflect.set(driver, "base", "http://127.0.0.1:1");
  Reflect.set(driver, "session", "owned");
  const reason = Object.freeze({
    get message() {
      throw new Error("private");
    },
  });
  const controller = new AbortController();
  controller.abort(reason);
  expect(await driver.script("private", controller.signal).catch((error: unknown) => error)).toBe(
    reason,
  );
});

test("attached abort facts preserve the first signal and never finish a request on abort alone", async () => {
  const { queue, client } = queueFixture();
  const caller = new AbortController();
  const entered = Promise.withResolvers<RequestInit>();
  let settled = false;
  const operation = queue.run(async () => {
    entered.resolve(queue.guard({ method: "GET", signal: caller.signal }));
  });
  void operation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    const request = await entered.promise;
    caller.abort("private");
    queue.revoke();
    await Bun.sleep(0);
    expect(settled).toBe(false);
    client.emit("request.performance", { request, error: "not recorded" });
    await operation.catch(() => {});
    expect(queue.commandFailures[0]?.abort).toBe("caller");
    expect(settled).toBe(true);
  } finally {
    queue.releaseObservers();
  }
});

test("the unchanged direct deadline records a header-stage timeout", async () => {
  const release = Promise.withResolvers<void>();
  const failures: CommandFailure[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      await release.promise;
      return Response.json({ value: null });
    },
  });
  const driver = new SafariDriver("not-native", "no-resources", (fact) => failures.push(fact));
  Reflect.set(driver, "base", `http://127.0.0.1:${server.port}`);
  Reflect.set(driver, "session", "owned");
  try {
    await expect(driver.handle(new AbortController().signal)).rejects.toThrow();
    expect(failures[0]).toMatchObject({
      abort: "deadline",
      stage: "headers",
      status: null,
      errorName: "TimeoutError",
      errorCode: null,
    });
  } finally {
    release.resolve();
    await server.stop(true);
  }
}, 7000);

test("malformed attached envelopes retain known status without consulting accessors", async () => {
  const { queue } = queueFixture();
  let reads = 0;
  const response = {
    body: null,
    get statusCode(): number {
      reads++;
      throw new Error("private");
    },
  };
  try {
    await expect(
      queue.run(async () => {
        const request = queue.guard({ method: "GET" });
        expect(queue.response(response, request)).toBe(response);
      }),
    ).rejects.toThrow("Malformed WebDriver envelope");
    expect(reads).toBe(0);
    expect(queue.commandFailures[0]).toMatchObject({ stage: "envelope", status: null });
    await expect(
      queue.run(async () => {
        const request = queue.guard({ method: "GET" });
        queue.response({ statusCode: 503, body: {} }, request);
      }),
    ).rejects.toThrow("Malformed WebDriver envelope");
    expect(queue.commandFailures[1]).toMatchObject({ stage: "envelope", status: 503 });
  } finally {
    queue.releaseObservers();
  }
});

test("parsed SDK failures retain status once without turning known errors into transport faults", async () => {
  const { queue, client, faults } = queueFixture();
  try {
    await queue.run(async () => {
      const request = queue.guard({ method: "GET" });
      const response = {
        statusCode: 404,
        body: { value: { error: "unknown command", message: "private message" } },
      };
      expect(queue.response(response, request)).toBe(response);
      client.emit("request.performance", { request, success: false, error: "private message" });
      client.emit("request.performance", { request, success: false });
    });
    expect(queue.commandFailures).toHaveLength(1);
    expect(queue.commandFailures[0]).toMatchObject({
      client: "attached",
      stage: "envelope",
      status: 404,
    });
    expect(faults).toEqual([]);
    expect(JSON.stringify(queue.commandFailures)).not.toContain("private");
  } finally {
    queue.releaseObservers();
  }
});

test("direct observation preserves complete falsy and structured operation values", async () => {
  let value: unknown = null;
  let observations = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ value }),
  });
  const driver = new SafariDriver("not-native", "no-resources", () => {
    observations++;
  });
  Reflect.set(driver, "base", `http://127.0.0.1:${server.port}`);
  Reflect.set(driver, "session", "owned");
  try {
    for (const next of [null, false, 0, "", { interior: [1, 2, 99, 4] }]) {
      value = next;
      expect(await driver.script("private script", AbortSignal.timeout(1000))).toEqual(next);
    }
    expect(observations).toBe(0);
  } finally {
    await server.stop(true);
  }
});
