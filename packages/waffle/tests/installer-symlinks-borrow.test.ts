import { afterEach, expect, test } from "bun:test";
import { FilesystemError, type ResolvedPath } from "../core/filesystem.js";
import { MemoryBackend } from "../fs/backend.js";
import { FilesystemClient } from "../fs/client.js";
import { MemFS, type Node } from "../fs/memory.js";
import {
  CAPABILITY_HEADER,
  CAPABILITY_WORDS,
  State,
  reapFilesystem,
  createProcessFilesystemIdentity,
  createFilesystemConnection,
} from "../fs/protocol.js";
import { FilesystemService } from "../fs/service.js";

const cleanups: (() => void | Promise<void>)[] = [];
const rawTarget = "../ordinary//é/雪/🙂";
afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "borrow fixture cleanup failed");
});

class TrackingBackend extends MemoryBackend {
  readonly pins = new Map<number, number>();
  retain(handle: number): void {
    super.retain(handle);
    this.pins.set(handle, (this.pins.get(handle) ?? 0) + 1);
  }
  release(handle: number): void {
    super.release(handle);
    const count = this.pins.get(handle);
    if (!count) throw new Error("unbalanced backend pin");
    if (count === 1) this.pins.delete(handle);
    else this.pins.set(handle, count - 1);
  }
}
function edge(value: unknown): ResolvedPath {
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    !("trailingSlash" in value) ||
    !("terminalDot" in value) ||
    typeof value.name !== "string" ||
    typeof value.trailingSlash !== "boolean" ||
    typeof value.terminalDot !== "boolean"
  )
    throw new Error("expected resolved path");
  const parent = "parent" in value ? value.parent : undefined;
  const handle = "node" in value ? value.node : undefined;
  if (
    (parent !== undefined && typeof parent !== "number") ||
    (handle !== undefined && typeof handle !== "number")
  )
    throw new Error("expected identities");
  return {
    parent,
    node: handle,
    name: value.name,
    trailingSlash: value.trailingSlash,
    terminalDot: value.terminalDot,
  };
}
function snapshotNode(node: Node): unknown {
  const metadata = { ino: node.ino, mtime: node.mtime, mode: node.mode, kind: node.kind };
  if (node.kind === "dir")
    return {
      ...metadata,
      children: Array.from(node.children, ([name, child]) => [name, snapshotNode(child)]),
    };
  return { ...metadata, value: node.kind === "file" ? Array.from(node.data) : node.kind === "symlink" ? node.target : undefined };
}
function node(path: ResolvedPath): number {
  if (path.node === undefined) throw new Error("missing node");
  return path.node;
}
function references(client: Pick<FilesystemClient, "connection">, handle: number): number {
  const cells = new Int32Array(client.connection.capabilities);
  for (let key = CAPABILITY_HEADER; key < cells.length; key += CAPABILITY_WORDS) {
    if (Atomics.load(cells, key) === handle && Atomics.load(cells, key + 1) >= 0)
      return Atomics.load(cells, key + 1);
  }
  return -1;
}
async function barrier(client: FilesystemClient): Promise<void> {
  await client.asyncCall("listFiles", ["/"]);
}
async function fixture<T extends TrackingBackend>(Backend: new (fs: MemFS) => T) {
  const fs = new MemFS();
  fs.writeFile("/ordinary.txt", "unchanged text");
  const path = fs.resolveAbsolute("/link");
  if (typeof path === "number") throw new FilesystemError(path);
  fs.symlink(path, rawTarget);
  const backend = new Backend(fs);
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection();
  const other = createFilesystemConnection(createProcessFilesystemIdentity(pair.client));
  const client = new FilesystemClient(pair.client);
  const sibling = new FilesystemClient(other.client);
  cleanups.push(() => {
    client.dispose();
    sibling.dispose();
    service.dispose();
    expect(backend.pins.size).toBe(0);
    expect(service.resources()).toMatchObject({ clients: 0, retained: 0, responses: 0 });
  });
  service.connect(pair.server);
  service.connect(other.server);
  const root: unknown = await client.asyncCall("preopen", ["/"]);
  if (typeof root !== "number") throw new Error("missing root");
  return { fs, backend, service, client, sibling, root };
}

for (const capacity of [1024, 1])
  test(`N5 direct ready unconsumed resolve survives sibling unlink with capacity=${capacity}`, async () => {
    const f = await fixture(TrackingBackend);
    const completion = f.client.submit("resolve", [f.root, "link"], new Uint8Array(), capacity);
    cleanups.push(() => completion.release());
    await barrier(f.client);
    expect(completion.ready).toBe(true);
    expect(completion.cells[0]).toBe(capacity === 1 ? State.Overflow : State.Complete);
    expect(await f.sibling.asyncCall("remove", ["/link"])).toBe(true);
    const tree = snapshotNode(f.fs.root);
    const path = edge(await completion.value());
    const handle = node(path);
    f.client.retain(handle);
    expect(await f.client.asyncCall("readlink", [handle])).toBe(rawTarget);
    expect(references(f.client, f.root)).toBe(1);
    expect(references(f.client, handle)).toBe(2);
    expect(f.service.resources().responses).toBe(1);
    completion.release();
    await barrier(f.client);
    expect(references(f.client, f.root)).toBe(0);
    expect(references(f.client, handle)).toBe(1);
    f.client.release(handle);
    await barrier(f.client);
    expect(f.backend.pins.has(handle)).toBe(false);
    expect(f.service.resources().responses).toBe(0);
    expect(() => f.client.retain(handle)).toThrow(new FilesystemError(8));
    expect(new TextDecoder().decode(f.fs.readFile("/ordinary.txt"))).toBe("unchanged text");
    expect(snapshotNode(f.fs.root)).toEqual(tree);
  });

const disposals: readonly ("release" | "releaseReady" | "cancel")[] = [
  "release",
  "releaseReady",
  "cancel",
];
for (const capacity of [1024, 1])
  for (const disposal of disposals)
    test(`N5 direct ${disposal} drops ready unconsumed refs with capacity=${capacity}`, async () => {
      const f = await fixture(TrackingBackend);
      const handle = node(edge(f.fs.resolve(f.root, "link")));
      const completion = f.client.submit("resolve", [f.root, "link"], undefined, capacity);
      cleanups.push(() => completion.release());
      await barrier(f.client);
      expect(references(f.client, f.root)).toBe(1);
      expect(references(f.client, handle)).toBe(1);
      expect(f.service.resources().responses).toBe(1);
      expect(await f.sibling.asyncCall("remove", ["/link"])).toBe(true);
      completion[disposal]();
      completion[disposal]();
      await barrier(f.client);
      expect(references(f.client, f.root)).toBe(0);
      expect(f.backend.pins.has(handle)).toBe(false);
      expect(f.service.resources().responses).toBe(0);
      expect(() => f.client.retain(handle)).toThrow(new FilesystemError(8));
    });

test("N5 direct cancellation before execution owns no result refs", async () => {
  const f = await fixture(TrackingBackend);
  const tree = snapshotNode(f.fs.root);
  const completion = f.client.submit("resolve", [f.root, "link"]);
  cleanups.push(() => completion.release());
  completion.cancel();
  await barrier(f.client);
  await expect(completion.value()).rejects.toMatchObject({ errno: 11 });
  expect(references(f.client, f.root)).toBe(0);
  expect(f.service.resources().responses).toBe(0);
  expect(f.backend.pins.size).toBe(1);
  expect(f.fs.root.children.get("link")?.kind).toBe("symlink");
  expect(snapshotNode(f.fs.root)).toEqual(tree);
});

test("N5 direct root and missing-node replies hold only their defined unique identities", async () => {
  const f = await fixture(TrackingBackend);
  const root = f.client.submit("resolve", [f.root, "."]);
  const missing = f.client.submit("resolve", [f.root, "missing"]);
  cleanups.push(() => {
    root.release();
    missing.release();
  });
  await barrier(f.client);
  const rootPath = edge(await root.value());
  const missingPath = edge(await missing.value());
  expect(rootPath.node).toBe(f.root);
  expect(missingPath).toMatchObject({ parent: f.root, node: undefined, name: "missing" });
  expect(references(f.client, f.root)).toBe(2);
  expect(f.service.resources().responses).toBe(2);
  root.release();
  await barrier(f.client);
  expect(references(f.client, f.root)).toBe(1);
  missing.release();
  await barrier(f.client);
  expect(references(f.client, f.root)).toBe(0);
  expect(f.fs.lookup("/missing")).toBeUndefined();
});

class FailingBackend extends TrackingBackend {
  refuse: number | undefined;
  override retain(handle: number): void {
    if (handle === this.refuse) throw new FilesystemError(28);
    super.retain(handle);
  }
}

test("N5 direct partial service acquisition rolls back the parent hold", async () => {
  const f = await fixture(FailingBackend);
  f.backend.refuse = node(edge(f.fs.resolve(f.root, "link")));
  const completion = f.client.submit("resolve", [f.root, "link"]);
  cleanups.push(() => completion.release());
  await barrier(f.client);
  expect(completion.cells[0]).toBe(State.Failed);
  await expect(completion.value()).rejects.toMatchObject({ errno: 28 });
  await barrier(f.client);
  expect(references(f.client, f.root)).toBe(0);
  expect(f.backend.pins.size).toBe(1);
  expect(f.service.resources().responses).toBe(0);
  expect(f.fs.root.children.get("link")?.kind).toBe("symlink");
});

class RevokingBackend extends TrackingBackend {
  revoke: (() => void) | undefined;
  override retain(handle: number): void {
    super.retain(handle);
    const revoke = this.revoke;
    this.revoke = undefined;
    revoke?.();
  }
}

test("N5 direct reentrant session close during result pin releases every partial hold once", async () => {
  const f = await fixture(RevokingBackend);
  f.backend.revoke = () => f.service.dispose();
  const completion = f.client.submit("resolve", [f.root, "link"]);
  cleanups.push(() => completion.release());
  await expect(completion.value()).rejects.toMatchObject({ errno: 11 });
  expect(f.backend.pins.size).toBe(0);
  expect(f.service.resources()).toMatchObject({ clients: 0, retained: 0, responses: 0 });
});

function workerMessage(
  worker: Worker,
  command: unknown,
  ports: Transferable[] = [],
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }: MessageEvent<unknown>) => resolve(data);
    worker.onerror = reject;
    worker.postMessage(command, ports);
  });
}
async function borrower(f: Awaited<ReturnType<typeof fixture>>) {
  const module = new URL("../fs/client.ts", import.meta.url).href;
  const errors = new URL("../fs/protocol.ts", import.meta.url).href;
  const source = `import { FilesystemClient, type BorrowedResolvedPath } from ${JSON.stringify(module)};
    import { FilesystemError, errno, type FilesystemConnection } from ${JSON.stringify(errors)};
    class Client extends FilesystemClient {
      failAt = 0;
      override retain(handle: number): void {
        if (this.failAt && --this.failAt === 0) throw new FilesystemError(8);
        super.retain(handle);
      }
    }
    type Command = {kind: "init"; connection: FilesystemConnection}
      | {kind: "borrow"; path: string; failAt?: number}
      | {kind: "read" | "release" | "retain" | "independentRelease" | "transient" | "close"};
    let client: Client, root: number, borrow: BorrowedResolvedPath | undefined, handle: number, closed = false;
    function execute(data: Command): unknown {
      if (data.kind === "init") { client = new Client(data.connection); root = client.preopen("/"); return root; }
      if (data.kind === "borrow") {
        client.failAt = data.failAt ?? 0;
        const result = client.resolveBorrowed(root, data.path);
        if (typeof result === "number") return result;
        borrow = result;
        if (result.path.node !== undefined) handle = result.path.node;
        return result.path;
      }
      if (data.kind === "read") return client.readlink(handle);
      if (data.kind === "release") { borrow?.release(); return undefined; }
      if (data.kind === "retain") { client.retain(handle); return undefined; }
      if (data.kind === "independentRelease") { client.release(handle); return undefined; }
      if (data.kind === "transient") return client.resolve(root, "link");
      client.dispose();
      closed = true;
      return undefined;
    }
    self.onmessage = ({data}: MessageEvent<Command>) => {
      try {
        const result = execute(data);
        if (!closed) client.call("listFiles", ["/"]);
        self.postMessage(result);
      } catch (error) { self.postMessage({errno: errno(error)}); }
    };`;
  const pair = createFilesystemConnection(createProcessFilesystemIdentity(f.client.connection));
  cleanups.push(() => {
    reapFilesystem(pair.server);
    pair.server.port.close();
    pair.client.port.close();
  });
  const worker = new Worker(new URL(`data:application/typescript,${encodeURIComponent(source)}`));
  cleanups.push(async () => {
    await worker.terminate();
  });
  f.service.connect(pair.server);
  const root = await workerMessage(worker, { kind: "init", connection: pair.client }, [
    pair.client.port,
  ]);
  if (typeof root !== "number") throw new Error("worker did not preopen root");
  return {
    connection: pair.server,
    root,
    call: (command: unknown) => workerMessage(worker, command),
  };
}

test("N5 direct explicit borrow spans rename, unlink and replacement without consuming an independent ref", async () => {
  const f = await fixture(TrackingBackend);
  const b = await borrower(f);
  const path = edge(await b.call({ kind: "borrow", path: "link" }));
  const handle = node(path);
  expect(path.parent).toBe(b.root);
  expect(references(b, b.root)).toBe(1);
  expect(references(b, handle)).toBe(1);
  const stat = f.fs.stat(handle);
  await b.call({ kind: "retain" });
  expect(await f.sibling.asyncCall("move", ["/link", "/moved"])).toBe(0);
  expect(await f.sibling.asyncCall("remove", ["/moved"])).toBe(true);
  const replacement = edge(f.fs.resolveAbsolute("/link"));
  expect(f.fs.symlink(replacement, "ordinary.txt")).toBe(0);
  const tree = snapshotNode(f.fs.root);
  expect(await b.call({ kind: "read" })).toBe(rawTarget);
  expect(f.fs.stat(handle)).toEqual({ ...stat, nlink: 0 });
  expect(node(edge(f.fs.resolveAbsolute("/link")))).not.toBe(handle);
  await b.call({ kind: "release" });
  await b.call({ kind: "release" });
  expect(references(b, handle)).toBe(1);
  expect(references(b, b.root)).toBe(0);
  expect(await b.call({ kind: "read" })).toBe(rawTarget);
  await b.call({ kind: "independentRelease" });
  expect(f.backend.pins.has(handle)).toBe(false);
  expect(await b.call({ kind: "read" })).toEqual({ errno: 8 });
  expect(f.service.resources().responses).toBe(0);
  expect(new TextDecoder().decode(f.fs.readFile("/ordinary.txt"))).toBe("unchanged text");
  expect(snapshotNode(f.fs.root)).toEqual(tree);
});

test("N5 direct borrow rolls back partial client adoption and handles ordinary error and missing results", async () => {
  const f = await fixture(TrackingBackend);
  const b = await borrower(f);
  expect(await b.call({ kind: "borrow", path: "link", failAt: 2 })).toBe(8);
  expect(references(b, b.root)).toBe(0);
  const handle = node(edge(f.fs.resolveAbsolute("/link")));
  expect(references(b, handle)).toBe(0);
  expect(f.service.resources().responses).toBe(0);
  expect(await b.call({ kind: "borrow", path: "ordinary.txt/child" })).toBe(54);
  const missing = edge(await b.call({ kind: "borrow", path: "missing" }));
  expect(missing.node).toBeUndefined();
  expect(references(b, b.root)).toBe(1);
  await b.call({ kind: "release" });
  expect(references(b, b.root)).toBe(0);
  const file = edge(await b.call({ kind: "borrow", path: "ordinary.txt" }));
  expect(await b.call({ kind: "read" })).toEqual({ errno: 28 });
  await b.call({ kind: "release" });
  expect(references(b, node(file))).toBe(0);
  expect(f.fs.lookup("/missing")).toBeUndefined();
  expect(new TextDecoder().decode(f.fs.readFile("/ordinary.txt"))).toBe("unchanged text");
});

for (const capacity of [1024, 1])
  test(`N5 direct session disposal clears ready replies and adopted refs with capacity=${capacity}`, async () => {
    const f = await fixture(TrackingBackend);
    const b = await borrower(f);
    const path = edge(await b.call({ kind: "borrow", path: "link" }));
    const completion = f.client.submit("resolve", [f.root, "link"], undefined, capacity);
    cleanups.push(() => completion.release());
    await barrier(f.client);
    expect(await f.sibling.asyncCall("remove", ["/link"])).toBe(true);
    f.client.dispose();
    await b.call({ kind: "close" });
    f.service.sweep();
    await barrier(f.sibling);
    expect(f.backend.pins.has(node(path))).toBe(false);
    expect(f.service.resources().responses).toBe(0);
    expect(await b.call({ kind: "release" })).toBeUndefined();
    expect(await b.call({ kind: "release" })).toBeUndefined();
    expect(await b.call({ kind: "read" })).toEqual({ errno: 11 });
    await expect(completion.value()).rejects.toMatchObject({ errno: 11 });
  });

test("N5 direct resident refusal happens before submission", () => {
  const pair = createFilesystemConnection();
  const client = new FilesystemClient({
    ...pair.client,
    residentPublication: {
      kind: "file",
      workspace: "test",
      instance: "test",
      epoch: 1,
      description: "test",
      handle: 0,
    },
  });
  cleanups.push(() => {
    client.dispose();
    pair.server.port.close();
  });
  client.submit = () => {
    throw new Error("resident borrow must not submit");
  };
  expect(client.resolveBorrowed(0, "ordinary.txt")).toBe(58);
  expect(client.completions.size).toBe(0);
});

test("N5 direct transient and cached resolution remain non-owning after completion disposal", async () => {
  const f = await fixture(TrackingBackend);
  const b = await borrower(f);
  const first = edge(await b.call({ kind: "transient" }));
  expect(await b.call({ kind: "transient" })).toEqual(first);
  expect(references(b, node(first))).toBe(0);
  expect(await f.sibling.asyncCall("remove", ["/link"])).toBe(true);
  expect(f.backend.pins.has(node(first))).toBe(false);
});
