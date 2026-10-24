import { expect, test } from "bun:test";
import { parseFileIdentity } from "../fs/file-identity.js";
import { decodeEffects, encodeEffects, type PublicationReceipt } from "../fs/publication.js";
import { decodeSnapshot, encodeRecord } from "../fs/storage.js";
import { FilesystemClient } from "../fs/client.js";
import { FilesystemService } from "../fs/service.js";
import { MemoryBackend } from "../fs/backend.js";
import { createFilesystemConnection } from "../fs/protocol.js";
import { publicationObserver } from "../fs/publication-internal.js";
import { workspacePublication } from "../fs/workspace-protocol.js";
import type { ResolvedPath } from "../core/filesystem.js";

const receipt: PublicationReceipt = {
  id: { session: 1, sequence: 1 },
  cut: { history: "link-test", generation: 1 },
  result: { kind: "number", value: 0 },
  durability: { kind: "untracked" },
};
const file = {
  birthHistory: "link-test",
  ino: 2,
  ...parseFileIdentity({ id: "10000000000000001", version: "10000000000000001" }),
};
function wire(changes: readonly unknown[]) {
  const header = new TextEncoder().encode(JSON.stringify({ receipt, changes }));
  const bytes = new Uint8Array(4 + header.length);
  new DataView(bytes.buffer).setUint32(0, header.length, true);
  bytes.set(header, 4);
  return bytes;
}

test("publication link codec roundtrips raw spelling and refuses malformed variants", () => {
  const target = "../packages//mémber/./index.ts";
  const effect = {
    kind: "inode",
    nodeKind: "symlink",
    target,
    file,
    mode: 0o600,
    mtime: 3,
  } as const;
  expect(decodeEffects(encodeEffects(receipt, [effect], 4096)).changes).toEqual([effect]);
  const storedFile = { ...file, id: file.id.toString(16), version: file.version.toString(16) };
  for (const invalid of [
    { ...effect, target: "" },
    { ...effect, target: "bad\0target" },
    { ...effect, target: undefined },
    { ...effect, target: 1 },
    { ...effect, nodeKind: "file" },
    { ...effect, nodeKind: "directory" },
  ])
    expect(() => decodeEffects(wire([{ ...invalid, file: storedFile }]))).toThrow();
  expect(() => encodeEffects(receipt, [{ ...effect, target: "x".repeat(4096) }], 1024)).toThrow();
});

test("durable codec rejects missing raw targets, wrong sizes and payloads on links", async () => {
  const link = { ino: 2, kind: "symlink", target: "raw", size: 3, mtime: 0 };
  const invalid = [
    { ...link, target: undefined },
    { ...link, target: "" },
    { ...link, target: "bad\0target" },
    { ...link, size: 2 },
    { ...link, data: "payload" },
    { ...link, children: [] },
    { ...link, kind: "file", data: "payload" },
  ];
  for (const node of invalid) {
    const encoded = await encodeRecord({
      version: 1,
      generation: 1,
      root: 1,
      nodes: [{ ino: 1, kind: "dir", mtime: 0, size: 0, children: [["link", 2]] }, node],
    });
    expect(await decodeSnapshot(encoded)).toBeUndefined();
  }
});

test("publication admission rolls back an oversized raw target before namespace and identity effects", async () => {
  const backend = new MemoryBackend();
  const pair = createFilesystemConnection(undefined, {
    ...workspacePublication,
    limits: { ...workspacePublication.limits, effectBytes: 1024 },
  });
  const service = new FilesystemService(backend);
  let client: FilesystemClient | undefined;
  try {
    service.connect(pair.server);
    client = new FilesystemClient(pair.client);
    const observer = publicationObserver(client);
    const root: number = await client.asyncCall("preopen", ["/"]);
    const path: ResolvedPath = await client.asyncCall("resolve", [root, "oversized", false]);
    const before = await observer.cut();
    const identity = backend.identity(root);
    const available = backend.shared.identities.available;
    const mtime = backend.fs.root.mtime;
    let error: unknown;
    try {
      await client.asyncCall("symlink", [path, "x".repeat(2048)]);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ errno: 6 });
    expect(backend.fs.root.children.has("oversized")).toBe(false);
    expect(backend.fs.root.mtime).toBe(mtime);
    expect(backend.identity(root)).toEqual(identity);
    expect(backend.shared.identities.available).toBe(available);
    expect(await observer.cut()).toEqual(before);
    expect(await client.asyncCall("symlink", [path, "raw"])).toBe(0);
    expect(backend.fs.lookup("/oversized", false)?.kind).toBe("symlink");
  } finally {
    client?.dispose();
    await service.drainForOwner();
    service.dispose();
    pair.client.port.close();
    pair.server.port.close();
  }
});
