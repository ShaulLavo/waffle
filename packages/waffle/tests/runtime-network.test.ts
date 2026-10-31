import { expect, test } from "bun:test";
import { createRuntime, type RuntimeNetworkHelper } from "../index.js";
import { NetHost } from "../browser/net/host.js";
import { createRing } from "../browser/net/ring.js";
import { FilesystemSection } from "../fs/protocol.js";

function ignoreData() {}

const noFetch = async () => {
  throw Error("External fetch forbidden");
};
function create() {
  return createRuntime({
    filesystem: {
      workerURL: new URL("../browser/fs-worker.ts", import.meta.url),
      mode: "memory",
    },
    processHost() {
      throw Error("Networking activated processes");
    },
  });
}
function bind(helper: RuntimeNetworkHelper, port: number) {
  const reply = new SharedArrayBuffer(12);
  helper.handle({ type: "tcp-listen", id: port, port, host: "localhost", reply });
  return Atomics.load(new Int32Array(reply), 1);
}

test("runtime lazily memoizes networking and projects only live helper capabilities", async () => {
  const runtime = create();
  const hosts: NetHost[] = [];
  try {
    const pending = runtime.network();
    expect(runtime.network()).toBe(pending);
    const network = await pending;
    expect(Object.keys(network)).toEqual(["createHelper", "lookup"]);
    expect(Object.isFrozen(network)).toBe(true);
    const ring = createRing();
    const helper = network.createHelper({ ring, fetch: noFetch });
    expect(Object.keys(helper).sort()).toEqual(
      [
        "handle",
        "dispose",
        "listenerFor",
        "request",
        "connect",
        "notifyFileChanged",
        "changeFile",
      ].sort(),
    );
    expect(Object.isFrozen(helper)).toBe(true);
    const secondRing = createRing();
    const sibling = network.createHelper({ ring: secondRing, fetch: noFetch });
    const server = new NetHost(ring, helper.handle, undefined, { shared: true });
    const client = new NetHost(secondRing, sibling.handle, undefined, { shared: true });
    hosts.push(server, client);
    expect(server.listen("localhost", 32140)).toBeGreaterThan(0);
    expect(client.connect("localhost", 32140)).toBeGreaterThan(0);
    client.dispose();
    sibling.dispose();
    expect(helper.listenerFor(32140)).toBeDefined();
    expect(() => sibling.listenerFor(32140)).toThrow(/disposed/i);
    sibling.dispose();
    server.dispose();
    await runtime.dispose();
    expect(() => network.createHelper({ ring: createRing(), fetch: noFetch })).toThrow(/disposed/i);
    expect(() => helper.listenerFor(32140)).toThrow(/disposed/i);
    expect(() => helper.handle({ type: "close", id: 1 })).toThrow(/disposed/i);
    expect(() => helper.connect(32140, { data() {}, end() {}, error() {} })).toThrow(/disposed/i);
    expect(() =>
      helper.request(
        32140,
        { method: "GET", target: "/", headers: [], body: null },
        {
          head() {},
          data() {},
          end() {},
          error() {},
        },
      ),
    ).toThrow(/disposed/i);
    expect(() => helper.notifyFileChanged("/app")).toThrow(/disposed/i);
    expect(() => helper.changeFile("/app", "x")).toThrow(/disposed/i);
    helper.dispose();
    await expect(runtime.network()).rejects.toThrow(/disposed/i);
  } finally {
    for (const host of hosts) host.dispose();
    await runtime.dispose();
  }
});

test("invalid helper options and getter reentry cannot allocate after runtime disposal", async () => {
  const runtime = create();
  try {
    const network = await runtime.network();
    expect(() => network.createHelper({ ring: new SharedArrayBuffer(12), fetch: noFetch })).toThrow(
      TypeError,
    );
    let stopped = 0;
    const helper = network.createHelper({
      ring: createRing(),
      fetch: noFetch,
      hooks: {
        stopped() {
          stopped++;
        },
      },
    });
    expect(bind(helper, 32141)).toBe(0);
    const options = {
      get ring() {
        void runtime.dispose();
        return createRing();
      },
      fetch: noFetch,
    };
    expect(() => network.createHelper(options)).toThrow(/disposed/i);
    await runtime.dispose();
    expect(stopped).toBe(1);
  } finally {
    await runtime.dispose();
  }
});

test("disposal wins a pending network initialization without activating processes", async () => {
  const runtime = create();
  const pending = runtime.network();
  const outcome = pending.then(
    () => "resolved",
    (error: unknown) => error,
  );
  await runtime.dispose();
  expect(await outcome).toBeInstanceOf(Error);
  expect(String(await outcome)).toMatch(/disposed/i);
  const next = create();
  try {
    expect(await next.network()).toBeDefined();
  } finally {
    await next.dispose();
  }
});

test("runtime retains networking until filesystem quiescence and physical consumer stop", async () => {
  const runtime = create();
  const stopped: number[] = [];
  let releaseStop = () => {};
  const stopGate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const identity = runtime.filesystem.createIdentity();
  const section = new FilesystemSection(identity);
  let entered = false;
  let stopping = false;
  try {
    const network = await runtime.network();
    const helper = network.createHelper({
      ring: createRing(),
      fetch: noFetch,
      hooks: {
        stopped(port) {
          stopped.push(port);
        },
      },
    });
    expect(bind(helper, 32142)).toBe(0);
    runtime.retainConsumer({
      filesystem: identity,
      revoke() {},
      async stop() {
        stopping = true;
        await stopGate;
      },
    });
    section.enter();
    entered = true;
    const disposal = runtime.dispose();
    await Bun.sleep(10);
    expect(stopping).toBe(false);
    expect(stopped).toEqual([]);
    section.exit();
    entered = false;
    await Bun.sleep(10);
    expect(stopping).toBe(true);
    expect(stopped).toEqual([]);
    releaseStop();
    await disposal;
    expect(stopped).toEqual([32142]);
  } finally {
    if (entered) section.exit();
    releaseStop();
    await runtime.dispose();
  }
});

test("network cleanup failures do not skip sibling helpers or filesystem disposal", async () => {
  const runtime = create();
  const stopped: number[] = [];
  const network = await runtime.network();
  const bad = network.createHelper({
    ring: createRing(),
    fetch: noFetch,
    hooks: {
      stopped(port) {
        stopped.push(port);
        throw Error("Stopped hook failed");
      },
    },
  });
  const good = network.createHelper({
    ring: createRing(),
    fetch: noFetch,
    hooks: {
      stopped(port) {
        stopped.push(port);
      },
    },
  });
  bind(bad, 32143);
  bind(bad, 32144);
  bind(good, 32145);
  await expect(runtime.dispose()).rejects.toThrow(/Network disposal failed/);
  expect(stopped).toEqual([32143, 32144, 32145]);
  bad.dispose();
  good.dispose();
  const next = create();
  await next.dispose();
});

test("hook accessors cannot insert a helper behind runtime teardown", async () => {
  const runtime = create();
  try {
    const network = await runtime.network();
    const hooks = {
      get stopped() {
        void runtime.dispose();
        return noFetch;
      },
    };
    expect(() => network.createHelper({ ring: createRing(), fetch: noFetch, hooks })).toThrow(
      /disposed/i,
    );
  } finally {
    await runtime.dispose();
  }
});

test("helper hooks are captured before admission and sibling sessions outlive parent release", async () => {
  const runtime = create();
  const stopped: number[] = [];
  try {
    const network = await runtime.network();
    const hooks = {
      stopped(port: number) {
        stopped.push(port);
      },
    };
    const parent = network.createHelper({ ring: createRing(), fetch: noFetch });
    const child = network.createHelper({ ring: createRing(), fetch: noFetch, hooks });
    hooks.stopped = () => {
      throw Error("Replacement hook must not run");
    };
    expect(bind(child, 32147)).toBe(0);
    parent.dispose();
    expect(child.listenerFor(32147)).toBe(32147);
    expect(stopped).toEqual([]);
    await runtime.dispose();
    expect(stopped).toEqual([32147]);
  } finally {
    await runtime.dispose();
  }
});

test.each(["tcp-listen", "tcp-connect"] as const)(
  "%s snapshots request getters before final helper admission",
  async (type) => {
    const runtime = create();
    try {
      const network = await runtime.network();
      const helper = network.createHelper({ ring: createRing(), fetch: noFetch });
      const sibling = network.createHelper({ ring: createRing(), fetch: noFetch });
      expect(bind(sibling, 32203)).toBe(0);
      const reply = new SharedArrayBuffer(12);
      helper.handle({
        type,
        id: 1,
        host: "localhost",
        reply,
        get port() {
          helper.dispose();
          return type === "tcp-listen" ? 32204 : 32203;
        },
      });
      expect(Atomics.load(new Int32Array(reply), 1)).toBe(-1);
      expect(bind(sibling, 32204)).toBe(0);
      expect(bind(sibling, 49152)).toBe(0);
    } finally {
      await runtime.dispose();
    }
  },
);

test.each(["tcp-listen", "tcp-connect"] as const)(
  "%s cannot allocate after a request getter starts runtime disposal",
  async (type) => {
    const runtime = create();
    try {
      const network = await runtime.network();
      const helper = network.createHelper({ ring: createRing(), fetch: noFetch });
      const reply = new SharedArrayBuffer(12);
      const request = {
        type,
        id: 1,
        host: "localhost",
        reply,
        get port() {
          void runtime.dispose();
          return 32208;
        },
      };
      expect(() => helper.handle(request)).toThrow(/disposed/i);
      expect(Atomics.load(new Int32Array(reply), 0)).toBe(1);
      expect(Atomics.load(new Int32Array(reply), 1)).toBe(-1);
    } finally {
      await runtime.dispose();
    }
  },
);

test("host-side request and connection sink getters cannot allocate after helper revocation", async () => {
  const runtime = create();
  try {
    const network = await runtime.network();
    const serverRing = createRing();
    const server = network.createHelper({ ring: serverRing, fetch: noFetch });
    expect(bind(server, 32209)).toBe(0);
    const client = network.createHelper({ ring: createRing(), fetch: noFetch });
    const sink = {
      get data() {
        client.dispose();
        return ignoreData;
      },
      end() {},
      error() {},
    };
    expect(client.connect(32209, sink)).toBeNull();
    const requester = network.createHelper({ ring: createRing(), fetch: noFetch });
    const request = {
      get method() {
        requester.dispose();
        return "GET";
      },
      target: "/",
      headers: [],
      body: null,
    };
    expect(requester.request(32209, request, { head() {}, data() {}, end() {}, error() {} })).toBe(
      false,
    );
    expect(bind(server, 49152)).toBe(0);
  } finally {
    await runtime.dispose();
  }
});

test("listening callback revocation never publishes a successful handle", async () => {
  const runtime = create();
  try {
    const network = await runtime.network();
    const helper = network.createHelper({
      ring: createRing(),
      fetch: noFetch,
      hooks: {
        listening() {
          helper.dispose();
        },
      },
    });
    expect(bind(helper, 32210)).toBe(-1);
    const sibling = network.createHelper({ ring: createRing(), fetch: noFetch });
    expect(bind(sibling, 32210)).toBe(0);
  } finally {
    await runtime.dispose();
  }
});

test("connector options are validated, captured once and invoked only for outbound connects", async () => {
  const runtime = create();
  let host: NetHost | undefined;
  let signal: AbortSignal | undefined;
  let reads = 0;
  let calls = 0;
  try {
    const network = await runtime.network();
    for (const connect of [null, false, 1, {}]) {
      expect(() =>
        Reflect.apply(network.createHelper, undefined, [
          { ring: createRing(), fetch: noFetch, connect },
        ]),
      ).toThrow(/connect policy/);
    }
    let selected: import("../browser/net/outbound.js").NetConnect = (_target, value) => {
      signal = value;
      calls++;
      return new Promise<never>(() => {});
    };
    const ring = createRing();
    const helper = network.createHelper({
      ring,
      fetch: noFetch,
      get connect() {
        reads++;
        return selected;
      },
    });
    expect(calls).toBe(0);
    expect(reads).toBe(1);
    selected = async () => {
      throw Error("must use the captured connector");
    };
    host = new NetHost(ring, helper.handle, undefined, { shared: true });
    expect(host.connect("localhost", 65432)).toBe(-1);
    expect(calls).toBe(0);
    expect(host.connect("database.example", 5432)).toBeGreaterThan(0);
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(reads).toBe(1);
    host.dispose();
    host = undefined;
    helper.dispose();
    expect(signal?.aborted).toBe(true);
  } finally {
    host?.dispose();
    await runtime.dispose();
  }
});

test("connector option getter revocation cannot admit a helper after disposal begins", async () => {
  const runtime = create();
  try {
    const network = await runtime.network();
    expect(() =>
      network.createHelper({
        ring: createRing(),
        fetch: noFetch,
        get connect() {
          void runtime.dispose();
          return async () => {
            throw Error("must not be invoked");
          };
        },
      }),
    ).toThrow(/disposed/);
  } finally {
    await runtime.dispose();
  }
});
