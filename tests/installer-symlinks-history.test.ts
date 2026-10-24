import { expect, test } from "bun:test";
import { MemoryBackend } from "../fs/backend.js";
import type { ResolvedPath } from "../core/filesystem.js";
import type { NamespaceEntry, SnapshotOptions, WorkspaceVfs } from "../fs/workspace-types.js";
import { publicReadFixture } from "./fixtures/workspace-read.js";

const bytes = (value: string) => new TextEncoder().encode(value);
type Fixture = ReturnType<typeof publicReadFixture>;
async function resolve(value: Fixture, path: string): Promise<ResolvedPath> {
  const root: number = await value.client.asyncCall("preopen", ["/"]);
  const found: ResolvedPath | number = await value.client.asyncCall("resolve", [root, path, false]);
  if (typeof found === "number") throw new Error(`resolve errno ${found}`);
  return found;
}
async function link(value: Fixture, name: string, target: string) {
  expect(await value.client.asyncCall("symlink", [await resolve(value, name), target])).toBe(0);
}
async function snapshot(workspace: WorkspaceVfs, options?: SnapshotOptions) {
  const cursor = workspace.snapshot(options);
  const entries: NamespaceEntry[] = [];
  try {
    for (;;) {
      const page = await cursor.next();
      if (page.kind === "complete") return { entries, cut: page.cut };
      if (page.kind !== "entries") throw new Error(`snapshot ${page.kind}`);
      entries.push(...page.entries);
    }
  } finally {
    await cursor.close();
  }
}
function entry(entries: readonly NamespaceEntry[], path: string) {
  const found = entries.find((item) => item.path === path);
  if (!found) throw new Error(`missing snapshot entry ${path}`);
  return found;
}

test("public snapshots and history preserve link leaves and raw targets while path reads follow", async () => {
  const value = publicReadFixture(new MemoryBackend());
  try {
    await value.client.asyncCall("writeFile", ["/packages/member/file"], bytes("before"));
    const before = await snapshot(value.workspace);
    const target = "./packages//member";
    await link(value, "member", target);
    await link(value, "cycle", "cycle");
    await link(value, "dangling", "missing");
    const changed = await value.workspace.changes(before.cut.watermark);
    if (changed.kind !== "changes") throw new Error(`changes ${changed.kind}`);
    expect(changed.batches.flatMap((batch) => batch.changes)).toContainEqual(
      expect.objectContaining({ kind: "inode", nodeKind: "symlink", target, paths: ["/member"] }),
    );
    const after = await snapshot(value.workspace);
    const alias = entry(after.entries, "/member");
    const file = entry(after.entries, "/packages/member/file");
    expect(alias).toMatchObject({ kind: "symlink", target, size: bytes(target).length });
    expect(after.entries.some((item) => item.path === "/member/file")).toBe(false);
    expect(after.entries.filter((item) => item.kind === "symlink")).toHaveLength(3);
    expect(await value.workspace.stat(alias.id)).toMatchObject({
      kind: "ok",
      value: { kind: "symlink", target, id: alias.id },
    });
    expect(await value.workspace.read(alias.id)).toEqual({ kind: "not-file" });
    expect(await value.workspace.read("/member/file")).toMatchObject({
      kind: "ok",
      value: { bytes: bytes("before"), stat: { id: file.id, kind: "file" } },
    });
    const pinned = await value.workspace.pin("/member/file");
    if (pinned.kind !== "ok") throw new Error(`pin ${pinned.kind}`);
    try {
      await value.client.asyncCall("writeFile", ["/packages/member/file"], bytes("after"));
      expect(await value.workspace.read("/member/file")).toMatchObject({
        kind: "ok",
        value: { bytes: bytes("after"), stat: { id: file.id } },
      });
      expect(await pinned.value.read()).toMatchObject({
        kind: "ok",
        value: { bytes: bytes("before"), stat: { id: file.id } },
      });
    } finally {
      await pinned.value.close();
    }
  } finally {
    await value.close();
  }
});

test("link rename unlink and recreation project historical identities without following the leaf", async () => {
  const value = publicReadFixture(new MemoryBackend());
  try {
    await value.client.asyncCall("writeFile", ["/file"], bytes("data"));
    await link(value, "link", "./file");
    const initial = await snapshot(value.workspace);
    const original = entry(initial.entries, "/link");
    expect(
      await value.client.asyncCall("rename", [
        await resolve(value, "link"),
        await resolve(value, "moved"),
      ]),
    ).toBe(0);
    expect(await value.client.asyncCall("removePath", [await resolve(value, "moved"), false])).toBe(
      0,
    );
    await link(value, "moved", "missing");
    const changed = await value.workspace.changes(initial.cut.watermark);
    if (changed.kind !== "changes") throw new Error(`changes ${changed.kind}`);
    const changes = changed.batches.flatMap((batch) => batch.changes);
    expect(changes).toContainEqual(
      expect.objectContaining({
        kind: "entry",
        name: "link",
        before: expect.objectContaining({ id: original.id }),
        beforePath: "/link",
        after: null,
      }),
    );
    expect(changes).toContainEqual(
      expect.objectContaining({
        kind: "entry",
        name: "moved",
        before: expect.objectContaining({ id: original.id }),
        beforePath: "/moved",
        after: null,
      }),
    );
    const final = await snapshot(value.workspace);
    expect(entry(final.entries, "/moved")).toMatchObject({ kind: "symlink", target: "missing" });
    expect(entry(final.entries, "/moved").id).not.toBe(original.id);
    expect(entry(final.entries, "/file").id).toBe(entry(initial.entries, "/file").id);
    expect(await value.workspace.read("/file")).toMatchObject({
      kind: "ok",
      value: { bytes: bytes("data") },
    });
    expect(value.service.resources().workspaceCursors).toBe(0);
  } finally {
    await value.close();
  }
});

test("snapshot prefixes keep final link leaves and select actual intermediate targets", async () => {
  const value = publicReadFixture(new MemoryBackend());
  try {
    await value.client.asyncCall("writeFile", ["/packages/member/file"], bytes("data"));
    await value.client.asyncCall("writeFile", ["/packages/peer"], bytes("peer"));
    await link(value, "member", "packages/member");
    const leaf = await snapshot(value.workspace, { prefix: "/member" });
    expect(leaf.entries.map((item) => item.path)).toEqual(["/member"]);
    const file = await snapshot(value.workspace, { prefix: "/member/file" });
    expect(file.entries.map((item) => item.path)).toEqual(["/packages/member/file"]);
    const peer = await snapshot(value.workspace, { prefix: "/member/../peer" });
    expect(peer.entries.map((item) => item.path)).toEqual(["/packages/peer"]);
    expect(value.service.resources().workspaceCursors).toBe(0);
  } finally {
    await value.close();
  }
});
