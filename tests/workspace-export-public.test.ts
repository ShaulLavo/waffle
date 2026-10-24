import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import * as root from "waffle";
import type { WorkspaceExportOptions as RootOptions, VersionStat } from "waffle";
import * as fs from "waffle/fs";
import type { WorkspaceExportOptions as FsOptions } from "waffle/fs";
import * as fsIndex from "waffle/fs/index";
import type { WorkspaceExportOptions as AliasOptions } from "waffle/fs/index";
import {
  exportWorkspaceArchive,
  WorkspaceExportError,
  WORKSPACE_EXPORT_LIMITS,
} from "../fs/workspace-export";
import {
  parseWorkspaceArchive,
  WorkspaceArchiveError,
  type ArchiveEvent,
} from "../fs/workspace-archive";
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

interface Received {
  bytes: number;
  completed: boolean;
  sawRoot: boolean;
  paths: string[];
}
function recordEvent(event: ArchiveEvent, selected: VersionStat, received: Received): void {
  if (event.kind === "manifest")
    expect(event.manifest.sourceWorkspace).toBe(selected.cut.workspace);
  if (event.kind === "entry") received.paths.push(event.entry.path);
  if (event.kind === "entry" && event.entry.path === "/") {
    received.sawRoot = true;
    expect(event.entry.sourceIdentity).toEqual(storeIdentity(selected, selected.cut.workspace));
  }
  if (event.kind === "data") {
    received.bytes += event.bytes.length;
    expect(event.bytes.length).toBeLessThanOrEqual(65536);
    expect(event.bytes.every((byte) => byte === 91)).toBe(true);
  }
  if (event.kind === "complete") received.completed = true;
}
async function publicRoundtrip(entry: object): Promise<void> {
  const seed = new MemFS();
  seed.writeFile("/file", new Uint8Array(2 * 65536 + 7).fill(91));
  const value = publicReadFixture(new MemoryBackend(seed));
  try {
    const selected = await value.workspace.stat("/");
    if (selected.kind !== "ok") throw new Error(selected.kind);
    const received: Received = { bytes: 0, completed: false, sawRoot: false, paths: [] };
    const options: RootOptions & FsOptions & AliasOptions = {
      budget: { maxEntries: 2, maxFileBytes: 2 * 65536 + 7, maxTotalBytes: 2 * 65536 + 7 },
    };
    const stream = publicExporter(entry)(value.workspace, options);
    for await (const event of parseWorkspaceArchive(stream))
      recordEvent(event, selected.value, received);
    expect(received.sawRoot && received.completed).toBe(true);
    expect(received.paths).toEqual(["/", "/file"]);
    expect(received.bytes).toBe(2 * 65536 + 7);
    expect(value.service.resources()).toMatchObject({
      workspaceCursors: 0,
      readerLeases: 0,
      readerOperations: 0,
    });
    expect((await value.workspace.read("/file", { offset: 0, length: 1 })).kind).toBe("ok");
  } finally {
    await value.close();
  }
}
for (const [name, entry] of [
  ["root", root],
  ["fs", fs],
  ["fs/index", fsIndex],
] as const)
  test(`public ${name} entry streams the real granted root with source identity`, () =>
    publicRoundtrip(entry));

async function stopAtData(stream: AsyncIterable<Uint8Array>): Promise<void> {
  for await (const event of parseWorkspaceArchive(stream)) {
    if (event.kind === "data") break;
  }
}
test("public exporter early return closes its lease but leaves the caller projection usable", async () => {
  const seed = new MemFS();
  seed.writeFile("/file", new Uint8Array(2 * 65536));
  const value = publicReadFixture(new MemoryBackend(seed));
  try {
    await stopAtData(publicExporter(root)(value.workspace));
    expect(value.service.resources()).toMatchObject({
      workspaceCursors: 0,
      readerLeases: 0,
      readerOperations: 0,
    });
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
    let bytes = 0, complete = false;
    function inspect(event) {
      if (event.kind === "data") {
        assert(event.bytes.length <= 65536);
        assert(event.bytes.every(byte => byte === 47));
        bytes += event.bytes.length;
      }
      if (event.kind === "complete") complete = true;
    }
    try {
      for await (const event of parseWorkspaceArchive(root.exportWorkspaceArchive(workspace))) inspect(event);
      assert.equal(bytes, 65537);
      assert.equal(complete, true);
      assert.equal(service.resources().workspaceCursors, 0);
      assert.equal(service.resources().readerLeases, 0);
    } finally {
      await workspace.close(); client.dispose(); await service.drainForOwner(); service.dispose();
      pair.client.port.close(); pair.server.port.close();
    }
  `;
  expect(() =>
    execFileSync("node", ["--input-type=module", "--eval", script], {
      cwd: resolve(import.meta.dir, ".."),
      stdio: "pipe",
    }),
  ).not.toThrow();
});
