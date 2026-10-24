import { afterEach, expect, test } from "bun:test";
import { FilesystemError, type ResolvedPath } from "../core/filesystem.js";
import { MemoryBackend } from "../fs/backend.js";
import { FilesystemClient } from "../fs/client.js";
import { MemFS } from "../fs/memory.js";
import {
  CAPABILITY_HEADER,
  CAPABILITY_WORDS,
  State,
  createFilesystemConnection,
} from "../fs/protocol.js";
import { FilesystemService } from "../fs/service.js";

const cleanups: (() => void)[] = [];
const rawTarget = "../ordinary//é/雪/🙂";
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
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
    typeof value !== "object" || value === null ||
    !("parent" in value) || !("node" in value) || !("name" in value) ||
    !("trailingSlash" in value) || !("terminalDot" in value) ||
    (value.parent !== undefined && typeof value.parent !== "number") ||
    (value.node !== undefined && typeof value.node !== "number") ||
    typeof value.name !== "string" || typeof value.trailingSlash !== "boolean" ||
    typeof value.terminalDot !== "boolean"
  ) throw new Error("expected resolved path");
  return {
    parent: value.parent, node: value.node, name: value.name,
    trailingSlash: value.trailingSlash, terminalDot: value.terminalDot,
  };
}
function node(path: ResolvedPath): number {
  if (path.node === undefined) throw new Error("missing node");
  return path.node;
}
function references(client: FilesystemClient, handle: number): number {
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
async function fixture() {
  const fs = new MemFS();
  fs.writeFile("/ordinary.txt", "unchanged text");
  const path = fs.resolveAbsolute("/link");
  if (typeof path === "number") throw new FilesystemError(path);
  fs.symlink(path, rawTarget);
  const backend = new TrackingBackend(fs);
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection();
  const other = createFilesystemConnection(pair.client);
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
    const f = await fixture();
    const completion = f.client.submit("resolve", [f.root, "link", false], new Uint8Array(), capacity);
    cleanups.push(() => completion.release());
    await barrier(f.client);
    expect(completion.ready).toBe(true);
    expect(completion.cells[0]).toBe(capacity === 1 ? State.Overflow : State.Complete);
    expect(await f.sibling.asyncCall("remove", ["/link"])).toBe(true);
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
  });
