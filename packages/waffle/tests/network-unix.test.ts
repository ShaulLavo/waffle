import { afterEach, expect, test } from "bun:test";
import { createRuntimeNetwork } from "../browser/net/runtime.js";
import { createRing } from "../browser/net/ring.js";
import { AGAIN, ERROR, OK, UNSUPPORTED } from "../browser/net/protocol.js";
import { NetHost } from "../browser/net/host.js";
import type { AttachedSocketScope } from "../browser/net/unix-paths.js";
import type { SocketBinding } from "../core/filesystem.js";
import type { FilesystemIdentity } from "../fs/protocol.js";
import { disposeLive, Guest, live } from "./network-unix-support.js";

const noFetch = async () => {
  throw Error("External fetch forbidden");
};
const EIO = 29;

/** A fake socket-only FS session: names and leases only. The real walk, permissions and
 * exact-edge cleanup are covered against the real filesystem in network-unix-fs.test.ts. */
class FakeTree {
  nodes = new Map<string, { kind: "socket" | "file"; ino: number; lease?: number }>();
  next = 1;
  unbinds: { path: string; unlink: boolean }[] = [];
  failUnbinds = 0;
  gate: Promise<void> | undefined;
  closed = 0;
  scope(rootIno: number): AttachedSocketScope {
    const calls: Record<string, (...args: any[]) => Promise<unknown>> = {
      bindSocketPath: async (_root: number, path: string, lease: number) => {
        await this.gate;
        if (this.nodes.has(path)) return { error: 20 };
        const ino = this.next++;
        this.nodes.set(path, { kind: "socket", ino, lease });
        return { binding: { node: ino, parent: 0, ino, parentIno: rootIno }, name: path };
      },
      connectSocket: async (_root: number, path: string) => {
        const node = this.nodes.get(path);
        if (!node) return { error: 44 };
        return node.kind === "socket" ? { ino: node.ino } : { error: 14 };
      },
      unbindSocket: async (
        binding: SocketBinding,
        name: string,
        lease: number,
        unlink: boolean,
      ) => {
        this.unbinds.push({ path: name, unlink });
        if (this.failUnbinds > 0) {
          this.failUnbinds--;
          return EIO;
        }
        const node = this.nodes.get(name);
        if (node?.ino !== binding.ino || node.lease !== lease) return 44;
        if (unlink) this.nodes.delete(name);
        return 0;
      },
    };
    return {
      root: 0,
      rootIno,
      client: {
        asyncCall: (operation, args) => calls[operation]!(...args),
        dispose: () => this.closed++,
      },
    };
  }
}

const identity = {} as FilesystemIdentity;
afterEach(disposeLive);

function runtime(tree = new FakeTree()) {
  const owner = createRuntimeNetwork(
    () => {},
    async (_identity, directory) => tree.scope(directory),
  );
  return { tree, owner, network: owner.network };
}

function guest(network: ReturnType<typeof runtime>["network"], directory: number | null = 1) {
  const ring = createRing();
  const helper = network.createHelper({
    ring,
    fetch: noFetch,
    pathScope: directory === null ? undefined : { filesystem: identity, directory },
  });
  live.push({ dispose: () => helper.dispose() });
  return new Guest(helper, ring);
}

async function connected(network: ReturnType<typeof runtime>["network"], path = "/run/s.sock") {
  const server = guest(network);
  const client = guest(network);
  const listener = await server.call("listenPath", path);
  expect(listener).toBeGreaterThan(0);
  const conn = await client.call("connectPath", path);
  expect(conn).toBeGreaterThan(0);
  const accepted = await server.accept(listener);
  return { server, client, listener, conn, accepted };
}

test("path streams carry FIFO bytes both ways with Unix addresses", async () => {
  const { network } = runtime();
  const { server, client, listener, conn, accepted } = await connected(network);
  expect(JSON.parse(await server.call("localAddr", listener))).toEqual({
    family: "Unix",
    path: "/run/s.sock",
  });
  expect(JSON.parse(await server.call("localAddr", accepted))).toEqual({
    family: "Unix",
    path: "/run/s.sock",
  });
  expect(JSON.parse(await server.call("peerAddr", accepted))).toEqual({
    family: "Unix",
    path: null,
  });
  expect(JSON.parse(await client.call("localAddr", conn))).toEqual({ family: "Unix", path: null });
  expect(JSON.parse(await client.call("peerAddr", conn))).toEqual({
    family: "Unix",
    path: "/run/s.sock",
  });
  expect(await client.call("localPort", conn)).toBe(UNSUPPORTED);
  expect(await server.call("localPort", listener)).toBe(UNSUPPORTED);
  expect(await client.call("write", conn, new TextEncoder().encode("abc"))).toBe(3);
  expect(await client.call("write", conn, new TextEncoder().encode("defgh"))).toBe(5);
  expect(new TextDecoder().decode(await server.readAll(accepted, 2))).toBe("ab");
  expect(new TextDecoder().decode(await server.readAll(accepted, 6))).toBe("cdefgh");
  expect(await server.call("write", accepted, new TextEncoder().encode("reply"))).toBe(5);
  expect(new TextDecoder().decode(await client.readAll(conn, 5))).toBe("reply");
});

test("1 MiB credit stops a writer with AGAIN until the reader consumes, then Writable wakes it", async () => {
  const { network } = runtime();
  const { server, client, conn, accepted } = await connected(network);
  const bytes = new Uint8Array((1 << 20) + 4096);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  expect(await client.call("write", conn, bytes)).toBe(1 << 20);
  expect(await client.call("write", conn, bytes.subarray(1 << 20))).toBe(AGAIN);
  const first = await server.readAll(accepted, 1 << 16);
  expect(first).toEqual(bytes.subarray(0, 1 << 16));
  // The blocked writer sleeps on its ring and wakes for the Writable record, without a timeout.
  expect(await client.call("poll", 5000)).toBe(1);
  expect(client.lastMs).toBeLessThan(4000);
  expect(await client.call("write", conn, bytes.subarray(1 << 20))).toBe(4096);
  const rest = await server.readAll(accepted, bytes.length - (1 << 16));
  expect(rest).toEqual(bytes.subarray(1 << 16));
});

test("half-close orders bytes before EOF and keeps the reverse direction", async () => {
  const { network } = runtime();
  const { server, client, conn, accepted } = await connected(network);
  expect(await client.call("write", conn, new Uint8Array([1, 2, 3]))).toBe(3);
  expect(await client.call("shutdown", conn)).toBe(OK);
  expect(await client.call("write", conn, new Uint8Array([4]))).toBe(ERROR);
  expect(await server.readAll(accepted, 3)).toEqual(new Uint8Array([1, 2, 3]));
  let eof = await server.call<Uint8Array | number>("read", accepted, 16);
  while (eof === AGAIN) {
    await server.call("poll", 1000);
    eof = await server.call<Uint8Array | number>("read", accepted, 16);
  }
  expect(eof).toBe(0);
  expect(await server.call("write", accepted, new Uint8Array([9, 8]))).toBe(2);
  expect(await client.readAll(conn, 2)).toEqual(new Uint8Array([9, 8]));
});

test("full close delivers earlier bytes then EOF, and the peer's next write fails EPIPE", async () => {
  const { network } = runtime();
  const { server, client, conn, accepted } = await connected(network);
  expect(await client.call("write", conn, new Uint8Array([7, 7]))).toBe(2);
  expect(await server.call("write", accepted, new Uint8Array([5]))).toBe(1);
  expect(await client.call("close", conn)).toBe(OK);
  expect(await server.readAll(accepted, 2)).toEqual(new Uint8Array([7, 7]));
  expect(await server.call("write", accepted, new Uint8Array([1]))).toBe(ERROR);
  expect((await server.error(accepted)).code).toBe("EPIPE");
});

test("listener close keeps accepted streams, ends unaccepted peers, and unlinks by default", async () => {
  const { network, tree } = runtime();
  const { server, client, listener, conn, accepted } = await connected(network);
  const late = await client.call("connectPath", "/run/s.sock");
  expect(late).toBeGreaterThan(0);
  expect(await server.call("close", listener)).toBe(OK);
  expect(tree.nodes.has("/run/s.sock")).toBe(false);
  let eof = await client.call<Uint8Array | number>("read", late, 1);
  while (eof === AGAIN) {
    await client.call("poll", 1000);
    eof = await client.call<Uint8Array | number>("read", late, 1);
  }
  expect(eof).toBe(0);
  expect(await client.call("write", conn, new Uint8Array([3]))).toBe(1);
  expect(await server.readAll(accepted, 1)).toEqual(new Uint8Array([3]));
  expect(await client.call("connectPath", "/run/s.sock")).toBe(ERROR);
  expect((await client.error()).code).toBe("ENOENT");
});

test("unlinkOnClose false leaves a stale name: connect refused, bind in use", async () => {
  const { network, tree } = runtime();
  const server = guest(network);
  const listener = await server.call("listenPath", "/stale", { unlinkOnClose: false });
  expect(await server.call("close", listener)).toBe(OK);
  expect(tree.nodes.get("/stale")?.kind).toBe("socket");
  expect(await server.call("connectPath", "/stale")).toBe(ERROR);
  expect(await server.error()).toMatchObject({ code: "ECONNREFUSED", syscall: "connect" });
  expect(await server.call("listenPath", "/stale")).toBe(ERROR);
  expect(await server.error()).toMatchObject({ code: "EADDRINUSE", syscall: "listen" });
});

test("invalid paths fail before any filesystem work", async () => {
  const { network, tree } = runtime();
  const server = guest(network);
  const cases: [string, string][] = [
    ["/a\0b", "EINVAL"],
    ["relative.sock", "EINVAL"],
    ["", "ENOENT"],
    ["/" + "x".repeat(4096), "ENAMETOOLONG"],
    ["/\uD800", "EINVAL"],
  ];
  for (const [path, code] of cases) {
    expect(await server.call("listenPath", path)).toBe(ERROR);
    expect((await server.error()).code).toBe(code);
    expect(await server.call("connectPath", path)).toBe(ERROR);
    expect((await server.error()).code).toBe(code);
  }
  expect(await server.call("listenPath", "/" + "x".repeat(4095))).toBeGreaterThan(0);
  expect(tree.nodes.size).toBe(1);
});

test("a helper without a path scope gets ENOTCAPABLE; another root cannot reach a binding", async () => {
  const { network } = runtime();
  const unscoped = guest(network, null);
  expect(await unscoped.call("listenPath", "/s")).toBe(ERROR);
  expect((await unscoped.error()).code).toBe("ENOTCAPABLE");
  expect(await unscoped.call("connectPath", "/s")).toBe(ERROR);
  expect((await unscoped.error()).code).toBe("ENOTCAPABLE");
  const server = guest(network, 1);
  expect(await server.call("listenPath", "/s")).toBeGreaterThan(0);
  const foreign = guest(network, 2);
  expect(await foreign.call("connectPath", "/s")).toBe(ERROR);
  expect((await foreign.error()).code).toBe("ECONNREFUSED");
  const second = runtime();
  const otherRuntime = guest(second.network, 1);
  second.tree.nodes.set("/s", { kind: "socket", ino: 1 });
  expect(await otherRuntime.call("connectPath", "/s")).toBe(ERROR);
  expect((await otherRuntime.error()).code).toBe("ECONNREFUSED");
});

test("standalone hosts report ENOTSUP for path calls", () => {
  const host = new NetHost(createRing(), () => {});
  expect(host.listenPath("/s")).toBe(UNSUPPORTED);
  expect(JSON.parse(host.error(0) as string)).toMatchObject({ code: "ENOTSUP", syscall: "listen" });
  expect(host.connectPath("/s")).toBe(UNSUPPORTED);
  expect(JSON.parse(host.error(0) as string)).toMatchObject({
    code: "ENOTSUP",
    syscall: "connect",
  });
  host.dispose();
});

test("a full backlog refuses; runtime pair and listener caps fail with ENOBUFS and create nothing", async () => {
  const { network, tree } = runtime();
  const server = guest(network);
  const client = guest(network);
  const listener = await server.call("listenPath", "/backlog");
  for (let i = 0; i < 64; i++)
    expect(await client.call("connectPath", "/backlog")).toBeGreaterThan(0);
  expect(await client.call("connectPath", "/backlog")).toBe(ERROR);
  expect((await client.error()).code).toBe("ECONNREFUSED");
  const second = await server.call("listenPath", "/more");
  const more: number[] = [];
  for (let i = 0; i < 64; i++) more.push(await client.call("connectPath", "/more"));
  expect(more.every((conn) => conn > 0)).toBe(true);
  // 128 pairs are live (all unaccepted); accepting frees backlog but not the pair cap.
  await server.accept(listener);
  expect(await client.call("connectPath", "/backlog")).toBe(ERROR);
  expect((await client.error()).code).toBe("ENOBUFS");
  // A pair counts until both ends close: the listener closing its unaccepted end is not enough.
  expect(await server.call("close", second)).toBe(OK);
  expect(await client.call("connectPath", "/backlog")).toBe(ERROR);
  expect(await client.call("close", more[0])).toBe(OK);
  expect(await client.call("connectPath", "/backlog")).toBeGreaterThan(0);
  for (let i = 0; i < 127; i++)
    expect(await server.call("listenPath", `/l${i}`)).toBeGreaterThan(0);
  const before = tree.nodes.size;
  expect(await server.call("listenPath", "/one-too-many")).toBe(ERROR);
  expect((await server.error()).code).toBe("ENOBUFS");
  expect(tree.nodes.size).toBe(before);
});

test("helper disposal during bind rolls the node back by lease and never publishes a handle", async () => {
  const { network, tree, owner } = runtime();
  const gate = Promise.withResolvers<void>();
  tree.gate = gate.promise;
  const server = guest(network);
  const pending = server.call("listenPath", "/late");
  await Bun.sleep(20);
  server.helper.dispose();
  gate.resolve();
  expect(await pending).toBe(ERROR);
  expect((await server.error()).code).toBe("ECANCELED");
  await owner.dispose();
  expect(tree.nodes.has("/late")).toBe(false);
  expect(tree.unbinds).toEqual([{ path: "/late", unlink: true }]);
});

test("helper disposal honors unlinkOnClose and leaves other helpers' peers at EOF", async () => {
  const { network, tree, owner } = runtime();
  const { server, client, conn } = await connected(network, "/kept-by-flag");
  await server.call("listenPath", "/stays", { unlinkOnClose: false });
  server.helper.dispose();
  let eof = await client.call<Uint8Array | number>("read", conn, 1);
  while (eof === AGAIN) {
    await client.call("poll", 1000);
    eof = await client.call<Uint8Array | number>("read", conn, 1);
  }
  expect(eof).toBe(0);
  await owner.dispose();
  expect(tree.nodes.has("/kept-by-flag")).toBe(false);
  expect(tree.nodes.get("/stays")?.kind).toBe("socket");
});

test("failed unbinds stay retained across owner dispose until a retry settles them", async () => {
  const { network, tree, owner } = runtime();
  const server = guest(network);
  await server.call("listenPath", "/retry");
  tree.failUnbinds = 2;
  server.helper.dispose();
  await expect(owner.dispose()).rejects.toThrow(/Socket cleanup failed/);
  expect(owner.retained()).toBe(true);
  expect(tree.nodes.has("/retry")).toBe(true);
  await owner.dispose();
  expect(owner.retained()).toBe(false);
  expect(tree.nodes.has("/retry")).toBe(false);
  expect(tree.unbinds).toHaveLength(3);
});

test("acknowledged close reports an unbind failure and keeps the lease for the owner", async () => {
  const { network, tree, owner } = runtime();
  const server = guest(network);
  const listener = await server.call("listenPath", "/ack");
  tree.failUnbinds = 1;
  expect(await server.call("close", listener)).toBe(ERROR);
  expect(await server.error()).toMatchObject({ code: "EUNKNOWN29", syscall: "close" });
  expect(await server.call("connectPath", "/ack")).toBe(ERROR);
  expect((await server.error()).code).toBe("ECONNREFUSED");
  expect(owner.retained()).toBe(true);
  server.helper.dispose();
  await owner.dispose();
  expect(tree.nodes.has("/ack")).toBe(false);
});

test("a blocked poll wakes for accept, data and EOF without periodic polling", async () => {
  const { network } = runtime();
  const server = guest(network);
  const client = guest(network);
  const listener = await server.call("listenPath", "/wake");
  const waiting = server.call("poll", 10_000);
  await Bun.sleep(30);
  const conn = await client.call("connectPath", "/wake");
  expect(await waiting).toBe(1);
  expect(server.lastMs).toBeLessThan(5000);
  const accepted = await server.call("accept", listener);
  expect(accepted).toBeGreaterThan(0);
  const data = server.call("poll", 10_000);
  await Bun.sleep(30);
  await client.call("write", conn, new Uint8Array([1]));
  expect(await data).toBe(1);
  expect(await server.call<Uint8Array | number>("read", accepted, 1)).toEqual(new Uint8Array([1]));
  const end = server.call("poll", 10_000);
  await Bun.sleep(30);
  await client.call("close", conn);
  expect(await end).toBe(1);
  expect(await server.call("read", accepted, 1)).toBe(0);
});

test("literal unix-* requests and reply cells", async () => {
  const { network } = runtime();
  const server = guest(network);
  const client = guest(network);
  const listener = await server.call("listenPath", "/w.sock");
  const conn = await client.call("connectPath", "/w.sock");
  expect(await client.call("connectPath", "/missing")).toBe(ERROR);
  await server.accept(listener);
  expect(await server.call("close", listener)).toBe(OK);
  expect(
    server.requests.filter((r) => String((r as { type: string }).type).startsWith("unix")),
  ).toEqual([
    { type: "unix-listen", id: listener, path: "/w.sock", unlinkOnClose: true },
    { type: "unix-close", id: listener },
  ]);
  expect(client.requests.slice(0, 2)).toEqual([
    { type: "unix-connect", id: conn, path: "/w.sock" },
    { type: "unix-connect", id: conn + 1, path: "/missing" },
  ]);
  expect(await Promise.all(client.replies)).toEqual([
    [1, 0, 0],
    [1, ERROR, 44],
  ]);
  expect(await Promise.all(server.replies)).toEqual([
    [1, 0, 0],
    [1, 0, 0],
  ]);
});

test("a scope attach that never answers does not hold owner disposal", async () => {
  const stuck = new Promise<never>(() => {});
  const owner = createRuntimeNetwork(
    () => {},
    () => stuck,
  );
  const server = guest(owner.network);
  void server.call("listenPath", "/never");
  await Bun.sleep(20);
  server.helper.dispose();
  const settled = await Promise.race([
    owner.dispose().then(() => "disposed"),
    Bun.sleep(1000).then(() => "stuck"),
  ]);
  expect(settled).toBe("disposed");
});
