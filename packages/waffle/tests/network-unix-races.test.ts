import { expect, test } from "bun:test";
import { createRuntimeNetwork } from "../browser/net/runtime.js";
import { createRing } from "../browser/net/ring.js";
import type { FilesystemIdentity } from "../fs/protocol.js";
import { createRuntime } from "../index.js";
import { FilesystemClient } from "../fs/client.js";

function fixture() {
  const gate = Promise.withResolvers<void>();
  let targetGate = gate;
  const nodes = new Map<string, number>();
  let targets = 0;
  let binds = 0;
  const owner = createRuntimeNetwork(
    () => {},
    async () => ({
      root: 0,
      rootIno: 1,
      client: {
        async asyncCall(operation, args) {
          if (operation === "connectSocket") {
            targets++;
            await targetGate.promise;
            const ino = nodes.get(String(args[1]));
            return ino === undefined ? { error: 44 } : { ino };
          }
          if (operation === "bindSocketPath") {
            binds++;
            await gate.promise;
            const ino = nodes.size + 1;
            nodes.set(String(args[1]), ino);
            return { binding: { node: ino, parent: 0, ino, parentIno: 1 }, name: args[1] };
          }
          if (operation === "unbindSocket") {
            nodes.delete(String(args[1]));
            return 0;
          }
          throw Error(operation);
        },
        dispose() {},
      },
    }),
  );
  const helper = owner.network.createHelper({
    ring: createRing(),
    fetch: async () => {
      throw Error("No external requests");
    },
    pathScope: { filesystem: {} as FilesystemIdentity, directory: 0 },
  });
  function listen(id: number, path: string) {
    const reply = new SharedArrayBuffer(12);
    helper.handle({ type: "unix-listen", id, path, unlinkOnClose: true, reply });
    return new Int32Array(reply);
  }
  function connect(id: number, path: string) {
    const reply = new SharedArrayBuffer(12);
    helper.handle({ type: "unix-connect", id, path, reply });
    return new Int32Array(reply);
  }
  return {
    gate,
    nodes,
    owner,
    helper,
    listen,
    connect,
    targets: () => targets,
    binds: () => binds,
    gateTargets() {
      targetGate = Promise.withResolvers<void>();
      return targetGate;
    },
  };
}

test("pending connect admissions have a finite bound before filesystem work", async () => {
  const f = fixture();
  try {
    for (let id = 1; id <= 512; id++)
      f.helper.handle({
        type: "unix-connect",
        id,
        path: "/missing",
        reply: new SharedArrayBuffer(12),
      });
    await Bun.sleep(5);
    console.log(JSON.stringify({ pendingTargetCalls: f.targets() }));
    expect(f.targets()).toBeLessThanOrEqual(128);
  } finally {
    f.gate.resolve();
    f.helper.dispose();
    await f.owner.dispose();
  }
});

test("close cancels an in-flight pathname listen", async () => {
  const f = fixture();
  try {
    const reply = f.listen(1, "/late");
    await Bun.sleep(5);
    expect(f.binds()).toBe(1);
    f.helper.handle({ type: "close", id: 1 });
    f.gate.resolve();
    await Bun.sleep(5);
    console.log(
      JSON.stringify({ lateBindReply: Array.from(reply), nodeAfterClose: f.nodes.has("/late") }),
    );
    expect(f.nodes.has("/late")).toBe(false);
  } finally {
    f.gate.resolve();
    f.helper.dispose();
    await f.owner.dispose();
  }
});

test("a repeated listener handle cannot lose the first lease", async () => {
  const f = fixture();
  try {
    const first = f.listen(1, "/first");
    const second = f.listen(1, "/second");
    f.gate.resolve();
    await Bun.sleep(5);
    f.helper.dispose();
    await f.owner.dispose();
    console.log(
      JSON.stringify({
        first: Array.from(first),
        second: Array.from(second),
        retained: f.owner.retained(),
        remaining: Array.from(f.nodes.keys()),
      }),
    );
    expect(f.nodes.size).toBe(0);
  } finally {
    f.gate.resolve();
    f.helper.dispose();
    await f.owner.dispose();
  }
});

test("real FS repeated listener handle leaves no stale socket after helper disposal", async () => {
  const runtime = createRuntime({
    filesystem: { mode: "memory", workerURL: new URL("../browser/fs-worker.ts", import.meta.url) },
  });
  const identity = runtime.filesystem.createIdentity();
  const client = new FilesystemClient(runtime.filesystem.connect(identity));
  const root = await runtime.filesystem.directoryHandle("/");
  await client.asyncCall("preopen", ["/"]);
  const network = await runtime.network();
  const helper = network.createHelper({
    ring: createRing(),
    fetch: async () => {
      throw Error("No external requests");
    },
    pathScope: { filesystem: identity, directory: root.handle },
  });
  try {
    const statuses: number[][] = [];
    for (const path of ["/first", "/second"]) {
      const reply = new SharedArrayBuffer(12);
      const cells = new Int32Array(reply);
      helper.handle({ type: "unix-listen", id: 1, path, unlinkOnClose: true, reply });
      while (!Atomics.load(cells, 0)) await Atomics.waitAsync(cells, 0, 0).value;
      statuses.push(Array.from(cells));
    }
    // The handle already owns /first, so the second listen is refused and creates nothing.
    expect(statuses).toEqual([
      [1, 0, 0],
      [1, -1, 8],
    ]);
    expect(await runtime.filesystem.lookup("/second")).toBeUndefined();
    helper.dispose();
    for (let at = 0; at < 30 && (await runtime.filesystem.lookup("/first")); at++)
      await Bun.sleep(2);
    const first = await runtime.filesystem.lookup("/first");
    const second = await runtime.filesystem.lookup("/second");
    console.log(
      JSON.stringify({ realFsAfterHelperClose: { first: first?.kind, second: second?.kind } }),
    );
    expect(first).toBeUndefined();
  } finally {
    helper.dispose();
    root.release();
    client.dispose();
    await runtime.dispose();
  }
});

async function replied(cells: Int32Array): Promise<number[]> {
  while (!Atomics.load(cells, 0)) await Atomics.waitAsync(cells, 0, 0).value;
  return Array.from(cells);
}

test("admission is released exactly once on success, failure and cancellation", async () => {
  const f = fixture();
  f.gate.resolve();
  try {
    expect(await replied(f.listen(1, "/s"))).toEqual([1, 0, 0]);
    const gate = f.gateTargets();
    const waiting = Array.from({ length: 128 }, (_, i) => f.connect(100 + i, i % 2 ? "/s" : "/x"));
    expect(await replied(f.connect(999, "/s"))).toEqual([1, -1, 42]);
    // Cancel half while they wait, then let all finish: none may release twice.
    for (let i = 0; i < 64; i++) f.helper.handle({ type: "close", id: 100 + i });
    gate.resolve();
    const replies = await Promise.all(waiting.map(replied));
    expect(replies.slice(0, 64).every((cells) => cells[2] === 11)).toBe(true);
    const second = f.gateTargets();
    const again = Array.from({ length: 128 }, (_, i) => f.connect(1000 + i, "/x"));
    expect(await replied(f.connect(2000, "/x"))).toEqual([1, -1, 42]);
    second.resolve();
    await Promise.all(again.map(replied));
  } finally {
    f.helper.dispose();
    await f.owner.dispose();
  }
});

test("close during a delayed connect cancels it and allocates no stream", async () => {
  const f = fixture();
  f.gate.resolve();
  try {
    expect(await replied(f.listen(1, "/s"))).toEqual([1, 0, 0]);
    const gate = f.gateTargets();
    const pending = f.connect(7, "/s");
    await Bun.sleep(5);
    f.helper.handle({ type: "close", id: 7 });
    gate.resolve();
    expect(await replied(pending)).toEqual([1, -1, 11]);
    // The id is free again and a fresh connect to the same listener works.
    expect(await replied(f.connect(7, "/s"))).toEqual([1, 0, 0]);
  } finally {
    f.helper.dispose();
    await f.owner.dispose();
  }
});

test("runtime disposal racing a first path request's scope attach leaves nothing behind", async () => {
  const options = {
    filesystem: {
      mode: "memory" as const,
      workerURL: new URL("../browser/fs-worker.ts", import.meta.url),
    },
  };
  for (const disposeHelperFirst of [true, false]) {
    const runtime = createRuntime(options);
    await runtime.filesystem.mkdirp("/run");
    const identity = runtime.filesystem.createIdentity();
    const client = new FilesystemClient(runtime.filesystem.connect(identity));
    await client.asyncCall("preopen", ["/"]);
    const root = await runtime.filesystem.directoryHandle("/");
    const network = await runtime.network();
    const helper = network.createHelper({
      ring: createRing(),
      fetch: async () => {
        throw Error("No external requests");
      },
      pathScope: { filesystem: identity, directory: root.handle },
    });
    const reply = new SharedArrayBuffer(12);
    // The attach message is in flight to the filesystem worker; no reply has arrived yet.
    helper.handle({ type: "unix-listen", id: 1, path: "/run/s", unlinkOnClose: true, reply });
    if (disposeHelperFirst) helper.dispose();
    root.release();
    client.dispose();
    const settled = await Promise.race([
      runtime.dispose().then(() => "disposed"),
      Bun.sleep(5000).then(() => "stuck"),
    ]);
    expect(settled).toBe("disposed");
    const cells = new Int32Array(reply);
    while (!Atomics.load(cells, 0)) await Atomics.waitAsync(cells, 0, 0).value;
    expect(Array.from(cells)).toEqual([1, -1, 11]);
  }
  // The page guard was released: no retained scope, pin or cleanup debt kept the runtime.
  await createRuntime(options).dispose();
});

test("TCP requests cannot take a handle owned by a pending or live path resource", async () => {
  const f = fixture();
  try {
    const pending = f.listen(1, "/first");
    const tcpOnPending = new SharedArrayBuffer(12);
    f.helper.handle({ type: "tcp-listen", id: 1, port: 0, host: "localhost", reply: tcpOnPending });
    expect(Atomics.load(new Int32Array(tcpOnPending), 1)).toBeLessThan(0);
    f.gate.resolve();
    expect(await replied(pending)).toEqual([1, 0, 0]);
    const tcpOnListener = new SharedArrayBuffer(12);
    f.helper.handle({
      type: "tcp-connect",
      id: 1,
      port: 1,
      host: "localhost",
      reply: tcpOnListener,
    });
    expect(Atomics.load(new Int32Array(tcpOnListener), 1)).toBeLessThan(0);
    expect(await replied(f.connect(2, "/first"))).toEqual([1, 0, 0]);
    const tcpOnSocket = new SharedArrayBuffer(12);
    f.helper.handle({ type: "tcp-listen", id: 2, port: 0, host: "localhost", reply: tcpOnSocket });
    expect(Atomics.load(new Int32Array(tcpOnSocket), 1)).toBeLessThan(0);
    f.helper.dispose();
    await f.owner.dispose();
    expect(f.owner.retained()).toBe(false);
    expect(Array.from(f.nodes.keys())).toEqual([]);
  } finally {
    f.helper.dispose();
    await f.owner.dispose();
  }
});
