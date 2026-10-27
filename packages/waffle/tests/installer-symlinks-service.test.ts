import { afterEach, expect, test } from "bun:test";
import { FilesystemClient } from "../fs/client.js";
import { MemoryBackend } from "../fs/backend.js";
import { FilesystemService } from "../fs/service.js";
import { createFilesystemConnection } from "../fs/protocol.js";
import { mutationIntent } from "../fs/publication.js";
import { decodeSnapshot, encodeRecord } from "../fs/storage.js";
import type { ResolvedPath } from "../core/filesystem.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanup.splice(0).reverse()) stop();
});

function service() {
  const backend = new MemoryBackend();
  const owner = new FilesystemService(backend);
  cleanup.push(() => owner.dispose());
  const connection = createFilesystemConnection();
  cleanup.push(() => connection.server.port.close());
  cleanup.push(() => connection.client.port.close());
  const client = new FilesystemClient(connection.client);
  cleanup.push(() => client.dispose());
  owner.connect(connection.server);
  return { client, backend };
}

function resolved(value: unknown): ResolvedPath {
  if (!value || typeof value !== "object" || !("name" in value))
    throw new Error("expected resolved path");
  if (typeof value.name !== "string" || !("parent" in value) || typeof value.parent !== "number")
    throw new Error("expected parent");
  const node = "node" in value ? value.node : undefined;
  if (node !== undefined && typeof node !== "number") throw new Error("expected node");
  if (!("trailingSlash" in value) || typeof value.trailingSlash !== "boolean")
    throw new Error("expected trailing slash");
  if (!("terminalDot" in value) || typeof value.terminalDot !== "boolean")
    throw new Error("expected terminal dot");
  return {
    parent: value.parent,
    node,
    name: value.name,
    trailingSlash: value.trailingSlash,
    terminalDot: value.terminalDot,
  };
}

async function destination(client: FilesystemClient, name: string) {
  const root: number = await client.asyncCall("preopen", ["/"]);
  return resolved(await client.asyncCall("resolve", [root, name, false]));
}

test("link creation is a publication mutation before any namespace edit", () => {
  const path: ResolvedPath = {
    parent: 0,
    name: "member",
    node: undefined,
    trailingSlash: false,
    terminalDot: false,
  };
  expect(mutationIntent("symlink", [path, "../packages/member"])).toEqual({
    kind: "symlink",
    path,
    target: "../packages/member",
  });
});

test("the actual filesystem service creates links and reads live editor changes", async () => {
  const { client } = service();
  await client.asyncCall(
    "writeFile",
    ["/packages/member/index.ts"],
    new TextEncoder().encode("before"),
  );
  await client.asyncCall("mkdirp", ["/node_modules"]);
  const path = await destination(client, "node_modules/member");
  const created = await client.asyncCall("symlink", [path, "../packages/member"]);
  expect(created).toBe(0);
  expect(await client.asyncCall("readFile", ["/node_modules/member/index.ts"])).toEqual(
    new TextEncoder().encode("before"),
  );
  await client.asyncCall(
    "writeFile",
    ["/packages/member/index.ts"],
    new TextEncoder().encode("after"),
  );
  expect(await client.asyncCall("readFile", ["/node_modules/member/index.ts"])).toEqual(
    new TextEncoder().encode("after"),
  );
});

test("the service distinguishes link metadata from final-follow metadata", async () => {
  const { client } = service();
  await client.asyncCall("writeFile", ["/file"], new Uint8Array([1]));
  const path = await destination(client, "link");
  const created = await client.asyncCall("symlink", [path, "./file"]);
  expect(created).toBe(0);
  const root: number = await client.asyncCall("preopen", ["/"]);
  const link = resolved(await client.asyncCall("resolve", [root, "link", false]));
  const followed = resolved(await client.asyncCall("resolve", [root, "link", true]));
  expect(await client.asyncCall("stat", [link.node])).toMatchObject({ kind: "symlink", size: 6 });
  expect(await client.asyncCall("stat", [followed.node])).toMatchObject({ kind: "file", size: 1 });
  expect(await client.asyncCall("readlink", [link.node])).toBe("./file");
});

test("snapshot metadata stores the raw target as a link, not a payload file", async () => {
  const target = "../packages//mémber/./index.ts";
  const snapshot: import("../fs/storage.js").PersistedIndex = {
    version: 1,
    generation: 1,
    root: 1,
    nodes: [
      { ino: 1, kind: "dir", mtime: 0, size: 0, children: [["link", 2]] },
      { ino: 2, kind: "symlink", mtime: 0, size: new TextEncoder().encode(target).length, target },
    ],
  };
  expect(await decodeSnapshot(await encodeRecord(snapshot))).toEqual(snapshot);
});
