import assert from "node:assert/strict";
import { mock } from "bun:test";
const { instantiate: original } = await import("../browser/net/network.buffer.js");
import type { BufferExports } from "../browser/net/network.buffer.js";

let entries = 0,
  factories = 0;
mock.module(new URL("../browser/net/network.buffer.js", import.meta.url).pathname, () => ({
  instantiate(imports: Parameters<typeof original>[0]): BufferExports {
    factories++;
    return new Proxy(original(imports), {
      get(target, property, receiver): unknown {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: number[]) => {
          entries++;
          return value(...args);
        };
      },
    });
  },
}));
const { NetHelper, NetNamespace } = await import("../browser/net/helper.js");
const { NetHost } = await import("../browser/net/host.js");
const { createRing } = await import("../browser/net/ring.js");
const { NetworkOwnerFailure } = await import("../browser/net/buffer-module.js");
const { createRuntime, declareSharedMemoryPlatform } = await import("../index.js");
const { TCP_RESET, TCP_PIPE, TCP_REFUSED } = await import("../browser/net/tcp-status.js");
const { ENOBUFS, ECONNREFUSED } = await import("../browser/net/unix-status.js");
const Native = ArrayBuffer;
let refuse = false,
  refuseMinimum = 0;
class Refusing extends Native {
  constructor(length = 0, options?: { maxByteLength?: number }) {
    if (refuse && length > refuseMinimum) throw new RangeError("injected allocation refusal");
    super(length, options);
  }
}
globalThis.ArrayBuffer = Refusing;
const sink = () => ({ data() {}, end() {} });
const options = () => ({
  sharedMemory: declareSharedMemoryPlatform({ kind: "unbounded" }),
  filesystem: {
    mode: "memory" as const,
    workerURL: new URL("../browser/fs-worker.ts", import.meta.url),
  },
});
async function until<T>(read: () => T, ready: (value: T) => boolean): Promise<T> {
  for (let round = 0; round < 1000; round++) {
    const value = read();
    if (ready(value)) return value;
    await Bun.sleep(1);
  }
  throw Error("Network did not settle");
}

async function namespaceFailure(later: boolean): Promise<void> {
  const ns = await NetNamespace.create();
  const { PathCleanup } = await import("../browser/net/unix-paths.js");
  const cleanup = new PathCleanup();
  const bind = Promise.withResolvers<import("../browser/net/unix-paths.js").SocketLease | number>();
  let bound = false,
    unbound = false;
  const scope: import("../browser/net/unix-paths.js").SocketScope = {
    bind() {
      bound = true;
      return bind.promise;
    },
    async target() {
      return ECONNREFUSED;
    },
    async unbind(_lease, unlink) {
      assert.equal(unlink, true);
      unbound = true;
      return 0;
    },
    async close() {},
  };
  const helper = new NetHelper(
    createRing(),
    async () => new Response("external"),
    {},
    ns,
    () => {},
    undefined,
    {
      cleanup,
      async scope() {
        return scope;
      },
      retire() {
        cleanup.retire(scope);
      },
    },
  );
  const reply = new Int32Array(new SharedArrayBuffer(12));
  const accepted: import("../browser/net/namespace.js").LoopbackSocket[] = [];
  const callbackError = Error("preview reset threw");
  let resets = 0;
  const owner = {};
  let preview: { close(): void } | null = null;
  try {
    ns.listen(12345, {
      owner,
      handle: 1,
      local: { address: "127.0.0.1", family: "IPv4", port: 12345 },
      accept(_peer, _local, socket) {
        accepted.push(socket);
      },
    });
    preview = helper.connect(12345, {
      ...sink(),
      error() {
        throw callbackError;
      },
    });
    assert.ok(preview);
    const connected = ns.connect(12345, {
      ...sink(),
      reset() {
        resets++;
      },
    });
    assert.notEqual(typeof connected, "number");
    if (typeof connected === "number") throw Error("connect failed");
    const waiting = connected.socket;
    let blocked: Promise<void> = Promise.resolve();
    if (later) {
      assert.equal(waiting.write(new Uint8Array(1 << 20)), 1 << 20);
      assert.equal(waiting.writableNow(), false);
      blocked = waiting.writable();
      fillSlab(ns);
    }
    helper.handle({
      type: "unix-listen",
      id: 77,
      path: "/late",
      unlinkOnClose: true,
      reply: reply.buffer,
    });
    await until(() => bound, Boolean);
    assert.ok(ns.reservePathListener());
    const triggering = ns.connect(12345, sink());
    if (typeof triggering === "number") throw Error("trigger connect failed");
    refuse = true;
    assert.equal(triggering.socket.write(new Uint8Array([1])), TCP_RESET);
    refuse = false;
    const stoppedAt = entries;
    bind.resolve({ key: { rootIno: 1, ino: 77 }, path: "/late" });
    await until(
      () => Atomics.load(reply, 0),
      (value) => value === 1,
    );
    assert.equal(reply[1], -1);
    assert.equal(reply[2], ENOBUFS);
    await until(() => unbound, Boolean);
    const failure = ns.failed();
    assert.ok(failure instanceof NetworkOwnerFailure);
    assert.match(String(failure.cause), /injected allocation/);
    assert.deepEqual(failure.callbackErrors, [callbackError]);
    assert.equal(resets, 1);
    await blocked;
    assert.equal(waiting.write(new Uint8Array()), TCP_RESET);
    assert.equal(waiting.write(new Uint8Array([2])), TCP_RESET);
    assert.equal(waiting.writableNow(), true);
    await waiting.writable();
    waiting.consumed(100);
    waiting.shutdown();
    waiting.receive({
      ...sink(),
      reset() {
        throw Error("late reset");
      },
    });
    assert.equal(failure.callbackErrors.length, 2);
    assert.equal(ns.reservePathListener(), false);
    assert.equal(
      ns.listenPath({ rootIno: 1, ino: 2 }, { owner, handle: 2, pending: () => 0, accept() {} }),
      ENOBUFS,
    );
    assert.equal(
      ns.listenAbstract("\0late", { owner, handle: 2, pending: () => 0, accept() {} }),
      ENOBUFS,
    );
    assert.equal(ns.connectAbstract("\0late", sink()), ECONNREFUSED);
    assert.equal(ns.connectPath({ rootIno: 1, ino: 2 }, sink()), ECONNREFUSED);
    assert.equal(ns.connect(12345, sink()), TCP_REFUSED);
    assert.ok(
      ns.listen(12346, {
        owner,
        handle: 3,
        local: { address: "127.0.0.1", family: "IPv4", port: 12346 },
        accept() {},
      }) < 0,
    );
    ns.unlisten(owner, 1);
    ns.unlistenPath(owner, 2);
    ns.unlistenAbstract(owner, 2);
    ns.release(owner);
    preview.close();
    waiting.close();
    assert.equal(waiting.write(new Uint8Array()), TCP_PIPE);
    helper.dispose();
    await cleanup.dispose();
    ns.dispose();
    ns.dispose();
    assert.equal(entries, stoppedAt, "poisoned module was reentered");
    console.log(
      JSON.stringify({
        case: later ? "later-slab" : "first-slab",
        entries,
        resets,
        callbackErrors: failure.callbackErrors.length,
      }),
    );
  } finally {
    refuse = false;
    bind.resolve(ENOBUFS);
    preview?.close();
    helper.dispose();
    await cleanup.dispose();
    ns.dispose();
  }
}
function fillSlab(ns: import("../browser/net/namespace.js").NetNamespace): void {
  for (let index = 0; index < 3; index++) {
    const connection = ns.connect(12345, sink());
    if (typeof connection === "number") throw Error("fill connection refused");
    assert.equal(connection.socket.write(new Uint8Array(1 << 20)), 1 << 20);
  }
}
async function runtimeFailure(initial: boolean, metadata = false): Promise<void> {
  const runtime = createRuntime(options());
  let host: InstanceType<typeof NetHost> | undefined;
  try {
    if (initial) {
      refuseMinimum = metadata ? 17 * 65536 : 0;
      refuse = true;
      const failure = await runtime.network().then(
        () => undefined,
        (error: unknown) => error,
      );
      const stoppedAt = entries,
        factoriesAt = factories;
      assert.ok(failure instanceof NetworkOwnerFailure);
      assert.ok(failure.cause instanceof RangeError);
      assert.equal(await runtime.network().catch((error: unknown) => error), failure);
      assert.equal(await runtime.dispose().catch((error: unknown) => error), failure);
      assert.equal(entries, stoppedAt);
      assert.equal(factories, factoriesAt);
      refuse = false;
      const next = createRuntime(options());
      try {
        await next.network();
      } finally {
        await next.dispose();
      }
      console.log(
        JSON.stringify({
          case: metadata ? "metadata" : "initial",
          entries: stoppedAt,
          factories: factoriesAt,
        }),
      );
      return;
    }
    const network = await runtime.network(),
      ring = createRing();
    const helper = network.createHelper({ ring, fetch: async () => new Response("external") });
    host = new NetHost(ring, (request) => helper.handle(request), undefined, { shared: true });
    const listener = host.listen("127.0.0.1", 12345),
      client = host.connect("localhost", 12345);
    const server = await until(
      () => host?.accept(listener) ?? -2,
      (id) => id > 0,
    );
    refuse = true;
    assert.equal(host.write(client, new Uint8Array([1])), -1);
    refuse = false;
    const stoppedAt = entries;
    assert.equal(
      await until(
        () => host?.read(server, 10) ?? -2,
        (value) => value !== -2,
      ),
      -1,
    );
    assert.match(String(host.error(server)), /ECONNRESET/);
    assert.equal(host.write(server, new Uint8Array([2])), -1);
    assert.match(String(host.error(server)), /ECONNRESET/);
    assert.equal(await runtime.network(), network);
    assert.ok(network.lookup("localhost").length > 0);
    network.createHelper({ ring: createRing(), fetch: async () => new Response("later") });
    const external = host.fetch(
      JSON.stringify({ url: "https://example.test/", method: "GET", headers: [] }),
    );
    assert.ok(external > 0);
    const data = await until(
      () => host?.read(external, 100) ?? -2,
      (value) => value instanceof Uint8Array,
    );
    assert.ok(data instanceof Uint8Array);
    assert.equal(new TextDecoder().decode(data), "external");
    assert.equal(host.connect("localhost", 12345), -1);
    assert.equal(host.listen("127.0.0.1", 12346), -1);
    assert.equal(host.shutdown(client), 0);
    assert.equal(host.close(client), 0);
    host.dispose();
    await runtime.dispose();
    assert.equal(entries, stoppedAt, "runtime retirement entered poisoned Rust");
    console.log(
      JSON.stringify({
        case: "runtime",
        entries: stoppedAt,
        external: "healthy",
        disposal: "settled",
      }),
    );
  } finally {
    refuse = false;
    host?.dispose();
    await runtime.dispose().catch(() => {});
  }
}
try {
  const mode = process.argv[2];
  if (mode === "initial" || mode === "metadata" || mode === "runtime")
    await runtimeFailure(mode !== "runtime", mode === "metadata");
  else await namespaceFailure(mode === "later");
} finally {
  globalThis.ArrayBuffer = Native;
}
