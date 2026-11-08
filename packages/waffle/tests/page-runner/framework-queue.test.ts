import { expect, test } from "bun:test";
import { FrameworkQueue } from "./framework-queue.js";
import { HostConsumers } from "./owned-consumers.js";

function fixture() {
  const consumers = new HostConsumers(),
    faults: string[] = [];
  let expired = false;
  const queue = new FrameworkQueue(
    consumers,
    () => {
      if (expired) throw new Error("Expired operation");
    },
    (detail) => faults.push(detail),
  );
  return {
    queue,
    consumers,
    faults,
    expire: () => {
      expired = true;
    },
  };
}
test("one queue joins nested entries and owns the actual HTTP settlement independently of callback return", async () => {
  const { queue, faults } = fixture();
  const order: string[] = [];
  let request: RequestInit = {};
  const first = queue.run(async () => {
    await queue.run(async () => {
      order.push("nested");
    });
    request = queue.guard({ signal: AbortSignal.timeout(1000) });
    order.push("callback-return");
  });
  const next = queue.run(async () => {
    order.push("probe");
  });
  await Bun.sleep(15);
  expect(order).toEqual(["nested", "callback-return"]);
  queue.response({ statusCode: 200, body: { value: null } }, request);
  await first;
  await next;
  expect(order).toEqual(["nested", "callback-return", "probe"]);
  expect(faults).toEqual([]);
});
test("unowned, revoked, and inherited expired operation contexts cannot enter the request boundary", async () => {
  const { queue } = fixture();
  expect(() => queue.guard({})).toThrow("Unowned");
  let late: (() => void) | undefined;
  await queue.run(async () => {
    late = () => queue.guard({});
  });
  expect(late).toBeDefined();
  queue.revoke();
  await expect(queue.run(async () => queue.guard({}))).rejects.toThrow("revoked");
});
test("a previously queued operation is checked at dispatch, not just enqueue time", async () => {
  const { queue, expire } = fixture();
  const release = Promise.withResolvers<void>();
  const first = queue.run(() => release.promise);
  let dispatched = false;
  const waiting = queue.run(async () => {
    dispatched = true;
  });
  await Bun.sleep(5);
  expire();
  release.resolve();
  await first.catch(() => {});
  await waiting.catch(() => {});
  expect(dispatched).toBe(false);
});
test("malformed responses caught by an SDK caller remain sticky via actual transport events", async () => {
  const { queue, faults } = fixture();
  let settle: ((event: unknown) => void) | undefined;
  queue.observe({
    on(_event: string, listener: (event: unknown) => void) {
      settle = listener;
    },
    off() {},
  });
  await expect(
    queue.run(async () => {
      const request = queue.guard({});
      settle?.({ request, success: false, error: new Error("Could not parse response") });
    }),
  ).rejects.toThrow("transport failed");
  expect(faults).toContain("WebDriver transport failed before an observed parsed response");
  expect(queue.commandFailures[0]).toMatchObject({ client: "attached", stage: "unknown" });
  expect(JSON.stringify(queue.commandFailures)).not.toContain("Could not parse");
});
test("the request guard composes the original SDK signal instead of replacing it", async () => {
  const { queue } = fixture();
  const sdk = new AbortController();
  await queue.run(async () => {
    const request = queue.guard({ signal: sdk.signal });
    sdk.abort("SDK timeout");
    expect(request.signal?.aborted).toBe(true);
    queue.response({ statusCode: 200, body: { value: null } }, request);
  });
});

test("SDK hook observations retain their operation token but never substitute for actual HTTP settlement", async () => {
  const { queue } = fixture();
  const release = Promise.withResolvers<void>();
  let request: RequestInit = {};
  const first = queue.run(async () => {
    queue.commandStarted();
    request = queue.guard({});
    void release.promise.then(() => queue.commandSettled());
  });
  let probed = false;
  const second = queue.run(async () => {
    probed = true;
  });
  await Bun.sleep(10);
  expect(probed).toBe(false);
  queue.response({ statusCode: 200, body: { value: null } }, request);
  await first;
  await second;
  expect(probed).toBe(true);
  release.resolve();
  await Bun.sleep(0);
  expect(queue.commandHooks).toHaveLength(2);
  expect(queue.commandHooks[0]?.operation).toBe(queue.commandHooks[1]?.operation);
  expect(queue.commandHooks[1]?.revoked).toBe(true);
});

function deferred() {
  return Promise.withResolvers<void>();
}
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("Unexpected fulfillment");
    },
    (reason: unknown) => reason,
  );
}
test("sealed parent cannot dispatch while its admitted child and grandchild remain live", async () => {
  const { queue } = fixture();
  const parentDone = deferred(),
    childGo = deferred(),
    grandchildGo = deferred(),
    grandchildStarted = deferred();
  let late: Promise<unknown> | undefined;
  const dispatchLate = () => {
    late = rejection(queue.run(async () => queue.guard({})));
  };
  const grandchild = async () => {
    grandchildStarted.resolve();
    await grandchildGo.promise;
    const request = queue.guard({});
    queue.response({ statusCode: 200, body: { value: null } }, request);
  };
  const child = async () => {
    await childGo.promise;
    void queue.run(grandchild);
  };
  const first = queue.run(async () => {
    void parentDone.promise.then(dispatchLate);
    void queue.run(child);
  });
  let probed = false;
  const next = queue.run(async () => {
    probed = true;
  });
  await Promise.resolve();
  childGo.resolve();
  await grandchildStarted.promise;
  expect(probed).toBe(false);
  parentDone.resolve();
  await Bun.sleep(0);
  expect(await late).toBeInstanceOf(Error);
  grandchildGo.resolve();
  await expect(first).rejects.toThrow();
  await next;
});
test("discarded child rejection prevents fulfilled root success", async () => {
  const { queue } = fixture();
  const reason = Object.freeze({ marker: "exact child rejection" });
  const result = queue.run(async () => {
    await queue
      .run(async () => {
        throw reason;
      })
      .catch(() => {});
    return "not success";
  });
  expect(await rejection(result)).toBe(reason);
});
const rootRejections: readonly unknown[] = [
  undefined,
  null,
  false,
  0,
  "",
  Object.create(null, {
    message: {
      get() {
        throw new Error("hostile");
      },
    },
  }),
];
for (const reason of rootRejections) {
  test("root rejection retains exact identity over child failure", async () => {
    const { queue } = fixture();
    const result = queue.run(async () => {
      void queue
        .run(async () => {
          throw new Error("secondary child");
        })
        .catch(() => {});
      throw reason;
    });
    expect(Object.is(await rejection(result), reason)).toBe(true);
  });
}
test("overlapping sibling frame callbacks are denied", async () => {
  const { queue } = fixture();
  const release = deferred();
  const result = queue.run(async () => {
    const first = queue.run(() => release.promise, "test-frame");
    const second = rejection(queue.run(async () => {}, "main-frame"));
    expect(String(await second)).toContain("Overlapping sibling");
    release.resolve();
    await first;
  });
  await expect(result).rejects.toThrow();
});

test("live descendants admit new requests during recursive draining", async () => {
  const { queue } = fixture();
  const childGo = deferred(),
    requestReady = deferred();
  let request: RequestInit = {};
  const grandchild = async () => {
    request = queue.guard({});
    requestReady.resolve();
  };
  const child = async () => {
    await childGo.promise;
    void queue.run(grandchild);
  };
  const first = queue.run(async () => {
    void queue.run(child);
  });
  let nextEntered = false;
  const next = queue.run(async () => {
    nextEntered = true;
  });
  await Bun.sleep(0);
  childGo.resolve();
  await requestReady.promise;
  expect(nextEntered).toBe(false);
  queue.response({ statusCode: 200, body: { value: null } }, request);
  await first;
  await next;
  expect(nextEntered).toBe(true);
});
test("nested domain entry is rejected before callback invocation", async () => {
  const { queue } = fixture();
  let invoked = false;
  const root = queue.run(async () => {
    await queue
      .run(
        async () => {
          invoked = true;
        },
        "screenshot",
        { rootOnly: true },
      )
      .catch(() => {});
  });
  await expect(root).rejects.toThrow("Nested framework domain");
  expect(invoked).toBe(false);
});
test("private finalizer gets its own scope and joins restoration before completion", async () => {
  const { queue } = fixture();
  const restore = deferred(),
    restoring = deferred(),
    late = deferred();
  let lateResult: Promise<unknown> | undefined;
  const dispatchLate = () => {
    lateResult = rejection(queue.run(async () => {}));
  };
  const result = queue.run(
    async () => {
      void late.promise.then(dispatchLate);
      return 42;
    },
    "screenshot",
    {
      finalize: async () => {
        void queue.run(async () => {
          restoring.resolve();
          await restore.promise;
        }, "test-frame");
      },
    },
  );
  await restoring.promise;
  late.resolve();
  await Bun.sleep(0);
  expect(String(await lateResult)).toContain("revoked");
  restore.resolve();
  await expect(result).rejects.toThrow("revoked");
});
test("revocation cancels requests immediately but still waits for actual restoration", async () => {
  const { queue } = fixture();
  const restoring = deferred(),
    release = deferred();
  let request: RequestInit = {};
  let finished = false;
  const result = queue.run(async () => 42, null, {
    finalize: () =>
      queue.run(async () => {
        request = queue.guard({});
        restoring.resolve();
        await release.promise;
        queue.response({ statusCode: 200, body: { value: null } }, request);
      }, "test-frame"),
  });
  void result.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  await restoring.promise;
  queue.revoke();
  expect(request.signal?.aborted).toBe(true);
  expect(finished).toBe(false);
  release.resolve();
  await expect(result).rejects.toThrow("revoked");
});
test("a fulfilled body cannot survive an expired actual HTTP join", async () => {
  const { queue, consumers } = fixture();
  let request: RequestInit = {};
  const result = queue.run(async () => {
    request = queue.guard({});
    return 42;
  });
  let dispatched = false;
  const next = rejection(
    queue.run(async () => {
      dispatched = true;
    }),
  );
  try {
    await expect(result).rejects.toThrow("settlement timed out");
    expect(String(await next)).toContain("revoked");
    expect(dispatched).toBe(false);
    expect(request.signal?.aborted).toBe(true);
    expect(await consumers.join(1)).toBe(false);
  } finally {
    queue.response({ statusCode: 200, body: { value: null } }, request);
    expect(await consumers.join(100)).toBe(true);
  }
}, 8000);

test("the actual observed SDK session is checked before requests and final success", async () => {
  const { queue } = fixture();
  queue.bindSession("owned-session");
  const client = { sessionId: "owned-session", on() {}, off() {} };
  const result = queue.run(async () => {
    queue.observe(client);
    client.sessionId = "replacement-session";
    return "not success";
  });
  await expect(result).rejects.toThrow("SDK session identity changed");
});
test("transport observers remain until an unjoined actual request settles", async () => {
  const { queue } = fixture();
  let request: RequestInit = {},
    removed = 0;
  let settle: ((value: unknown) => void) | undefined;
  const result = queue.run(async () => {
    queue.observe({
      on(_event: string, listener: (event: unknown) => void) {
        settle = listener;
      },
      off() {
        removed++;
      },
    });
    request = queue.guard({});
  });
  await expect(result).rejects.toThrow("settlement timed out");
  queue.releaseObservers();
  expect(removed).toBe(0);
  settle?.({ request, success: false });
  await Bun.sleep(0);
  expect(removed).toBe(1);
}, 8000);
