import { expect, test } from "bun:test";
import { MemoryBackend } from "../fs/backend.js";
import { MemFS, type Node } from "../fs/memory.js";
import { PersistentBackend } from "../fs/persistent.js";
import { linkLifecycle, metadataGuest } from "./fixtures/metadata-enumeration-r173-wasi.js";
import { metadataWorker } from "./fixtures/metadata-enumeration-r173-service.js";
import { MetadataStore } from "./fixtures/metadata-enumeration-r173-store.js";

function assertLifetime(result: ReturnType<typeof linkLifecycle>) {
  expect(result).not.toHaveProperty("error");
  expect(result.contents).toBe("retained data");
  expect(result.closedErrno).toBe(8);
  const identities = result.stats.concat(result.descriptor, result.peer).map((stat) => stat.ino);
  expect(new Set(identities).size).toBe(1);
}
function assertLinks(result: ReturnType<typeof linkLifecycle>) {
  console.log("nlink lifecycle", result);
  assertLifetime(result);
  expect({
    path: result.stats.map((stat) => stat.nlink),
    fd: result.descriptor.map((stat) => stat.nlink),
    peer: result.peer.map((stat) => stat.nlink),
  }).toEqual({
    path: [1n, 2n, 1n],
    fd: [1n, 2n, 1n, 0n],
    peer: result.peer.length ? [1n, 2n, 1n] : [],
  });
}

test("#115 actual Wasm preserves inode and open-unlinked data as a green control", () => {
  const fs = new MemFS();
  fs.writeFile("/file", "retained data");
  assertLifetime(linkLifecycle(fs));
});

test("#115 actual Wasm reports path and fd nlink 1 -> 2 -> 1 -> 0", () => {
  const fs = new MemFS();
  fs.writeFile("/file", "retained data");
  assertLinks(linkLifecycle(fs));
});

test("#115 Worker-backed service shares nlink across clients inside a namespace", async () => {
  const backend = new MemoryBackend();
  backend.fs.writeFile("/sandbox/file", "retained data");
  const result = await metadataWorker<ReturnType<typeof linkLifecycle>>(backend, {
    scenario: "links",
    root: "/sandbox",
  });
  assertLinks(result);
});

test("#115 replacement drops only the displaced inode's name and same-inode rename is a no-op", () => {
  const fs = new MemFS();
  fs.writeFile("/file", "retained data");
  fs.writeFile("/target", "displaced");
  const h = metadataGuest(fs);
  try {
    const fd = h.open("target");
    h.link("file", "alias");
    h.rename("file", "alias");
    const same = h.stat("file");
    h.rename("file", "target");
    const displaced = h.fstat(fd);
    expect(h.read(fd)).toBe("displaced");
    expect(h.stat("target").ino).toBe(h.stat("alias").ino);
    expect(same.nlink).toBe(2n);
    expect(h.stat("target").nlink).toBe(2n);
    expect(displaced.nlink).toBe(0n);
  } finally {
    h.wasi.descriptors.dispose();
  }
});

test("#115 real persistent checkpoint rebuilds hard-link counts across reload", async () => {
  const store = new MetadataStore();
  const first = await PersistentBackend.open(store, { intervalMs: 0 });
  try {
    first.execute("writeFile", ["/file"], new TextEncoder().encode("retained data"));
    const h = metadataGuest(first.fs);
    try {
      h.link("file", "alias");
    } finally {
      h.wasi.descriptors.dispose();
    }
    await first.flush();
  } finally {
    await first.close();
  }
  const second = await PersistentBackend.open(store, { intervalMs: 0 });
  try {
    type Stat = ReturnType<ReturnType<typeof metadataGuest>["stat"]>;
    const result = await metadataWorker<{
      linked: Stat;
      alias: Stat;
      remaining: Stat;
      detached: Stat;
    }>(second, { scenario: "reload" });
    console.log("nlink reload", result);
    expect(result).not.toHaveProperty("error");
    expect(new Set(Object.values(result).map((stat) => stat.ino)).size).toBe(1);
    expect(Object.values(result).map((stat) => stat.nlink)).toEqual([2n, 2n, 1n, 0n]);
  } finally {
    await second.close();
  }
});

class CountedChildren extends Map<string, Node> {
  visits = 0;
  *values(): MapIterator<Node> {
    for (const child of super.values()) {
      this.visits++;
      yield child;
    }
  }
}

test("#115 flat WASI unlink uses identity bookkeeping rather than repeated root walks", async () => {
  const count = 1000;
  const fs = new MemFS();
  for (let index = 0; index < count; index++) fs.writeFile(`/entry-${index}`, "");
  const children = new CountedChildren(fs.root.children);
  fs.root.children = children;
  const backend = new MemoryBackend(fs);
  children.visits = 0;
  const result = await metadataWorker<{ removed: number }>(backend, { scenario: "delete", count });
  expect(result).toEqual({ removed: count });
  expect(fs.root.children.size).toBe(0);
  console.log("unlink counter", { removed: count, directoryEntriesVisited: children.visits });
  expect(children.visits).toBeLessThanOrEqual(count * 2);
});

function resolved(fs: MemFS, path: string) {
  const value = fs.resolveAbsolute(path);
  if (typeof value === "number") throw new Error(`resolve failed ${value}`);
  return value;
}

for (const planned of [false, true]) {
  test(`#115 recursive removal preserves outside aliases and open data, planned=${planned}`, () => {
    const backend = new MemoryBackend();
    const fs = backend.fs;
    fs.writeFile("/tree/sub/file", "retained data");
    expect(fs.link(resolved(fs, "/tree/sub/file"), resolved(fs, "/alias"))).toBe(0);
    const file = resolved(fs, "/alias").node!;
    backend.retain(file);
    try {
      expect(fs.stat(file).nlink).toBe(2);
      if (planned) backend.execute("remove", ["/tree"], new Uint8Array());
      else fs.remove("/tree");
      expect(fs.stat(file).nlink).toBe(1);
      expect(fs.hasNode(fs.nodeForHandle(file))).toBe(true);
      backend.execute("remove", ["/alias"], new Uint8Array());
      expect(fs.stat(file).nlink).toBe(0);
      expect(backend.shared.stat(file)?.nlink).toBe(0);
      expect(fs.hasNode(fs.nodeForHandle(file))).toBe(false);
      const bytes = backend.execute("read", [file, 32, 0], new Uint8Array());
      expect(bytes).toBeInstanceOf(Uint8Array);
      if (!(bytes instanceof Uint8Array)) throw new Error("expected file bytes");
      expect(new TextDecoder().decode(bytes)).toBe("retained data");
    } finally {
      backend.release(file);
    }
  });
}

test("#115 symlink aliases count names and reconstruction preserves identity counts", () => {
  const fs = new MemFS();
  expect(fs.symlink(resolved(fs, "/link"), "missing-target")).toBe(0);
  expect(fs.link(resolved(fs, "/link"), resolved(fs, "/alias"))).toBe(0);
  const restored = new MemFS(fs.root);
  const handle = resolved(restored, "/alias").node!;
  restored.retain(handle);
  try {
    expect(restored.stat(handle).nlink).toBe(2);
    expect(restored.removePath(resolved(restored, "/link"), false)).toBe(0);
    expect(restored.stat(handle).nlink).toBe(1);
    expect(restored.removePath(resolved(restored, "/alias"), false)).toBe(0);
    expect(restored.stat(handle).nlink).toBe(0);
    expect(restored.readlink(handle)).toBe("missing-target");
  } finally {
    restored.release(handle);
  }
});

test("#115 count-only shared metadata updates neither require write access nor advance content revision", () => {
  const backend = new MemoryBackend();
  backend.fs.writeFile("/file", "data");
  const handle = resolved(backend.fs, "/file").node!;
  backend.fs.setMode(handle, 0o400);
  backend.retain(handle);
  try {
    const revision = backend.shared.revision(handle);
    backend.shared.setNlink(handle, 2);
    expect(backend.shared.stat(handle)?.nlink).toBe(2);
    expect(backend.shared.snapshot(handle)?.stat.nlink).toBe(2);
    expect(backend.shared.info(handle)?.nlink).toBe(2);
    expect(backend.shared.revision(handle)).toBe(revision);
  } finally {
    backend.release(handle);
  }
});
