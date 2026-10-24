import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import * as root from "waffle";
import * as fs from "waffle/fs";
import * as fsIndex from "waffle/fs/index";
import {
  exportWorkspaceArchive,
  WorkspaceExportError,
  WORKSPACE_EXPORT_LIMITS,
} from "../fs/workspace-export";
import { parseWorkspaceArchive, WorkspaceArchiveError } from "../fs/workspace-archive";
import { storeIdentity } from "../fs/file-identity";
import { MemoryBackend } from "../fs/backend";
import { MemFS } from "../fs/memory";
import { publicReadFixture } from "./fixtures/workspace-read";

function publicExporter(entry: object): typeof exportWorkspaceArchive {
  const selected = Reflect.get(entry, "exportWorkspaceArchive");
  if (selected !== exportWorkspaceArchive) throw new Error("Missing public workspace exporter");
  expect(Reflect.get(entry, "WorkspaceExportError")).toBe(WorkspaceExportError);
  expect(Reflect.get(entry, "WorkspaceArchiveError")).toBe(WorkspaceArchiveError);
  expect(Reflect.get(entry, "WORKSPACE_EXPORT_LIMITS")).toBe(WORKSPACE_EXPORT_LIMITS);
  expect(Reflect.has(entry, "importWorkspaceArchive")).toBe(false);
  expect(Reflect.has(entry, "ArchiveStagingSink")).toBe(false);
  return selected;
}

for (const [name, entry] of [["root", root], ["fs", fs], ["fs/index", fsIndex]] as const) {
  test(`public ${name} entry streams the real granted root with source identity`, async () => {
    const seed = new MemFS();
    seed.writeFile("/file", new Uint8Array(2 * 65536 + 7).fill(91));
    const value = publicReadFixture(new MemoryBackend(seed));
    try {
      const selected = await value.workspace.stat("/");
      if (selected.kind !== "ok") throw new Error(selected.kind);
      let bytes = 0, completed = false, sawRoot = false;
      const paths: string[] = [];
      const stream = publicExporter(entry)(value.workspace);
      for await (const event of parseWorkspaceArchive(stream)) {
        if (event.kind === "manifest")
          expect(event.manifest.sourceWorkspace).toBe(selected.value.cut.workspace);
        if (event.kind === "entry") paths.push(event.entry.path);
        if (event.kind === "entry" && event.entry.path === "/") {
          sawRoot = true;
          expect(event.entry.sourceIdentity).toEqual(storeIdentity(selected.value, selected.value.cut.workspace));
        }
        if (event.kind === "data") {
          bytes += event.bytes.length;
          expect(event.bytes.length).toBeLessThanOrEqual(65536);
          expect(event.bytes.every((byte) => byte === 91)).toBe(true);
        }
        if (event.kind === "complete") completed = true;
      }
      expect(sawRoot && completed).toBe(true);
      expect(paths).toEqual(["/", "/file"]);
      expect(bytes).toBe(2 * 65536 + 7);
      expect(value.service.resources()).toMatchObject({ workspaceCursors: 0, readerLeases: 0, readerOperations: 0 });
      expect((await value.workspace.read("/file", { offset: 0, length: 1 })).kind).toBe("ok");
    } finally {
      await value.close();
    }
  });
}

test("public exporter early return closes its lease but leaves the caller projection usable", async () => {
  const seed = new MemFS();
  seed.writeFile("/file", new Uint8Array(2 * 65536));
  const value = publicReadFixture(new MemoryBackend(seed));
  try {
    const parsed = parseWorkspaceArchive(publicExporter(root)(value.workspace));
    for await (const event of parsed) {
      if (event.kind === "data") break;
    }
    expect(value.service.resources()).toMatchObject({ workspaceCursors: 0, readerLeases: 0, readerOperations: 0 });
    expect((await value.workspace.stat("/")).kind).toBe("ok");
  } finally {
    await value.close();
  }
});

test("prepared Node root and fs entries expose the same bounded exporter, not import wiring", () => {
  const script = `
    import assert from "node:assert/strict";
    import * as root from "waffle";
    import * as fs from "waffle/fs";
    import * as alias from "waffle/fs/index";
    import { MemFS } from "waffle/fs/memory";
    import { parseWorkspaceArchive } from "./dist/fs/workspace-archive.js";
    assert.equal(typeof root.exportWorkspaceArchive, "function");
    assert.equal(root.exportWorkspaceArchive, fs.exportWorkspaceArchive);
    assert.equal(root.exportWorkspaceArchive, alias.exportWorkspaceArchive);
    assert.equal(root.WorkspaceArchiveError, fs.WorkspaceArchiveError);
    assert.equal("importWorkspaceArchive" in root, false);
    const seed = new MemFS();
    seed.writeFile("/file", new Uint8Array(65537).fill(47));
    const pair = fs.createFilesystemConnection(undefined, { workspace: true });
    const service = new fs.FilesystemService(new fs.MemoryBackend(seed));
    service.connect(pair.server);
    const client = new fs.FilesystemClient(pair.client);
    const workspace = fs.createWorkspaceVfs(client);
    try {
      let bytes = 0, complete = false;
      for await (const event of parseWorkspaceArchive(root.exportWorkspaceArchive(workspace))) {
        if (event.kind === "data") {
          assert(event.bytes.length <= 65536);
          assert(event.bytes.every(byte => byte === 47));
          bytes += event.bytes.length;
        }
        if (event.kind === "complete") complete = true;
      }
      assert.equal(bytes, 65537);
      assert.equal(complete, true);
      assert.equal(service.resources().workspaceCursors, 0);
      assert.equal(service.resources().readerLeases, 0);
    } finally {
      await workspace.close(); client.dispose(); await service.drainForOwner(); service.dispose();
      pair.client.port.close(); pair.server.port.close();
    }
  `;
  expect(() => execFileSync("node", ["--input-type=module", "--eval", script], {
    cwd: resolve(import.meta.dir, ".."), stdio: "pipe",
  })).not.toThrow();
});
