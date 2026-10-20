import { expect, test } from "bun:test";
import { createRuntime, type RuntimeNetworkHelper } from "../index.js";
import { NetHost } from "../browser/net/host.js";
import { createRing } from "../browser/net/ring.js";
import { FilesystemSection } from "../fs/protocol.js";

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
    expect(Object.keys(network)).toEqual(["createHelper"]);
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
