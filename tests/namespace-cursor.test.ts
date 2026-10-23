import { expect, test } from "bun:test";
import { FilesystemError } from "../core/filesystem";
import { MemoryBackend } from "../fs/backend";
import { FilesystemClient } from "../fs/client";
import { MemFS, type DirNode, type Node } from "../fs/memory";
import { NamespaceCursor, type NamespaceSource } from "../fs/namespace-cursor";
import { createFilesystemConnection } from "../fs/protocol";
import { FilesystemService } from "../fs/service";
import { namespaceCut, type NamespacePage, type NamespaceRecord } from "../fs/workspace-protocol";
import { WORKSPACE_LIMITS } from "../fs/workspace-types";

function fixture(fs = new MemFS()) {
  const backend = new MemoryBackend(fs);
  const pair = createFilesystemConnection(undefined, { workspace: true });
  const service = new FilesystemService(backend);
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  const domain = backend.shared.publication!;
  let reads = 0;
  let stopped = false;
  const source: NamespaceSource = {
    root: fs.root,
    current: () => (stopped ? undefined : namespaceCut(backend.workspaceId, domain.cut())),
    metadata(node) {
      reads++;
      return {
        ...backend.ensureIdentity(node),
        size: node.kind === "file" ? (node.size ?? node.data.length) : 0,
        mtime: node.mtime,
        mode: node.mode,
      };
    },
  };
  return {
    backend,
    fs,
    source,
    get reads() {
      return reads;
    },
    change() {
      return client.asyncCall("writeFile", ["/changed"], new Uint8Array());
    },
    stop() {
      stopped = true;
    },
    dispose() {
      client.dispose();
      service.dispose();
    },
  };
}

function entries(cursor: NamespaceCursor) {
  let paths: string[] = [];
  for (;;) {
    const page = cursor.next();
    if (page.kind === "complete") return paths;
    if (page.kind !== "entries") throw new Error(`unexpected ${page.kind}`);
    paths = paths.concat(page.entries.filter((entry) => entry.selected).map((entry) => entry.path));
  }
}

function countKinds(records: readonly NamespaceRecord[]) {
  let files = 0,
    directories = 0;
  for (const record of records) {
    if (record.kind === "file") files++;
    else directories++;
  }
  return { files, directories };
}

function expectTerminal(
  cursor: NamespaceCursor,
  expected: Exclude<NamespacePage, { kind: "entries" }>,
) {
  expect(cursor.next()).toEqual(expected);
  expect(cursor.next()).toEqual(expected);
  expect(cursor.resources()).toEqual({ frames: 0, pending: 0, pathUnits: 0 });
}

test("streams the actual tree in insertion order, preserving hardlinks and metadata", () => {
  const fs = new MemFS();
  fs.writeFile("/b/x", new Uint8Array([1, 2]));
  fs.writeFile("/a", new Uint8Array([3]));
  const current = fixture(fs);
  fs.root.children.set("alias", fs.root.children.get("a")!);
  const cursor = new NamespaceCursor(current.source);
  try {
    const page = cursor.next();
    expect(page.kind).toBe("entries");
    if (page.kind !== "entries") throw new Error("missing entries");
    expect(page.entries.map((entry) => entry.path)).toEqual(["/", "/b", "/b/x", "/a", "/alias"]);
    expect(page.entries[3]!.id).toBe(page.entries[4]!.id);
    expect(page.entries[2]).toMatchObject({
      size: 2,
      mode: 0o600,
      kind: "file",
      name: "x",
      parent: page.entries[1]!.id,
    });
    const terminal = cursor.next();
    expect(terminal.kind).toBe("complete");
    if (terminal.kind !== "complete") throw new Error("missing complete");
    expectTerminal(cursor, terminal);
  } finally {
    cursor.close();
    current.dispose();
  }
});

test("selected prefixes still enumerate all authority records, including missing prefixes", () => {
  const fs = new MemFS();
  fs.writeFile("/dir/file", new Uint8Array());
  fs.writeFile("/dir2/file", new Uint8Array());
  const current = fixture(fs);
  try {
    const cursor = new NamespaceCursor(current.source, {
      prefix: "/dir/../dir/",
      includeDirs: false,
    });
    expect(entries(cursor)).toEqual(["/dir/file"]);
    expect(entries(new NamespaceCursor(current.source, { prefix: "/missing" }))).toEqual([]);
    const missing = new NamespaceCursor(current.source, { prefix: "/missing" });
    const page = missing.next();
    expect(page.kind === "entries" && page.entries.length).toBe(5);
    missing.close();
  } finally {
    current.dispose();
  }
});

test("prefix and whole-tree traversal enforce real permissions and file-parent errors", () => {
  const fs = new MemFS();
  fs.writeFile("/dir/file", new Uint8Array());
  const current = fixture(fs);
  try {
    const fileParent = new NamespaceCursor(current.source, { prefix: "/dir/file/../" });
    expect(() => fileParent.next()).toThrow(FilesystemError);
    expectTerminal(fileParent, { kind: "cancelled" });
    fs.root.children.get("dir")!.mode = 0;
    const denied = new NamespaceCursor(current.source);
    expect(() => denied.next()).toThrow(expect.objectContaining({ errno: 2 }));
    expectTerminal(denied, { kind: "cancelled" });
    const missing = new NamespaceCursor(current.source, { prefix: "/dir/missing" });
    expect(() => missing.next()).toThrow(expect.objectContaining({ errno: 2 }));
    expectTerminal(missing, { kind: "cancelled" });
  } finally {
    current.dispose();
  }
});

test("byte-full pages retain one pending edge without duplicate metadata or omissions", () => {
  const fs = new MemFS();
  fs.writeFile("/a", new Uint8Array());
  fs.writeFile("/b/file", new Uint8Array());
  const current = fixture(fs);
  const cursor = new NamespaceCursor(current.source, {}, undefined, { pageBytes: 216 });
  try {
    expect(entries(cursor)).toEqual(["/", "/a", "/b", "/b/file"]);
    expect(current.reads).toBe(4);
    expect(cursor.resources()).toEqual({ frames: 0, pending: 0, pathUnits: 0 });
  } finally {
    cursor.close();
    current.dispose();
  }
});

test("depth, path and page pressure are sticky and free all traversal references", () => {
  const fs = new MemFS();
  fs.writeFile("/a/b/file", new Uint8Array());
  const current = fixture(fs);
  try {
    expectTerminal(new NamespaceCursor(current.source, {}, undefined, { depth: 1 }), {
      kind: "pressure",
      resource: "depth",
    });
    expectTerminal(new NamespaceCursor(current.source, {}, undefined, { pathUnits: 2 }), {
      kind: "pressure",
      resource: "path",
    });
    expectTerminal(new NamespaceCursor(current.source, {}, undefined, { pageBytes: 192 }), {
      kind: "pressure",
      resource: "page",
    });
    expectTerminal(
      new NamespaceCursor(current.source, { prefix: "/aaa" }, undefined, { pathUnits: 2 }),
      { kind: "pressure", resource: "path" },
    );
  } finally {
    current.dispose();
  }
});

test("cut changes restart partial scans, while stopped sources never return complete", async () => {
  const fs = new MemFS();
  fs.writeFile("/file", new Uint8Array());
  const current = fixture(fs);
  try {
    const cursor = new NamespaceCursor(current.source, {}, undefined, { pageEntries: 1 });
    expect(cursor.next().kind).toBe("entries");
    await current.change();
    expectTerminal(cursor, { kind: "restart", current: current.source.current()! });
    const stopped = new NamespaceCursor(current.source);
    current.stop();
    expectTerminal(stopped, { kind: "stopped" });
  } finally {
    current.dispose();
  }
});

test("abort before admission, between pages and during metadata suppresses later output", () => {
  const current = fixture();
  try {
    const before = new AbortController();
    before.abort();
    expectTerminal(new NamespaceCursor(current.source, {}, before.signal), { kind: "cancelled" });
    expect(current.reads).toBe(0);
    const between = new AbortController();
    const cursor = new NamespaceCursor(current.source, {}, between.signal, { pageEntries: 1 });
    expect(cursor.next().kind).toBe("entries");
    between.abort();
    expectTerminal(cursor, { kind: "cancelled" });
    const during = new AbortController();
    const source = {
      ...current.source,
      metadata(node: Node) {
        during.abort();
        return current.source.metadata(node);
      },
    };
    expectTerminal(new NamespaceCursor(source, {}, during.signal), { kind: "cancelled" });
    expect(entries(new NamespaceCursor(current.source))).toEqual(["/"]);
  } finally {
    current.dispose();
  }
});

test("close is idempotent, stops iterators, removes abort listeners and borrows the source", () => {
  const current = fixture();
  const abort = new AbortController();
  let listeners = 0;
  const add = abort.signal.addEventListener.bind(abort.signal);
  const remove = abort.signal.removeEventListener.bind(abort.signal);
  abort.signal.addEventListener = (...args: Parameters<typeof add>) => {
    listeners++;
    add(...args);
  };
  abort.signal.removeEventListener = (...args: Parameters<typeof remove>) => {
    listeners--;
    remove(...args);
  };
  const cursor = new NamespaceCursor(current.source, {}, abort.signal, { pageEntries: 1 });
  try {
    cursor.next();
    expect(listeners).toBe(1);
    cursor.close();
    cursor.close();
    expect(listeners).toBe(0);
    expectTerminal(cursor, { kind: "cancelled" });
    expect(entries(new NamespaceCursor(current.source))).toEqual(["/"]);
  } finally {
    cursor.close();
    current.dispose();
  }
});

class CountedChildren extends Map<string, Node> {
  steps = 0;
  override entries(): MapIterator<[string, Node]> {
    const iterator = super.entries();
    const next = iterator.next.bind(iterator);
    iterator.next = () => {
      this.steps++;
      return next();
    };
    return iterator;
  }
}

test("visited-edge credits include empty-directory unwind, with no work between pulls", async () => {
  const fs = new MemFS();
  fs.mkdirp("/a/b/c/d");
  const maps: CountedChildren[] = [];
  function instrument(node: DirNode): void {
    const children = new CountedChildren(node.children);
    node.children = children;
    maps.push(children);
    for (const child of children.values()) if (child.kind === "dir") instrument(child);
  }
  instrument(fs.root);
  const current = fixture(fs);
  const cursor = new NamespaceCursor(current.source, {}, undefined, { visitedEdges: 2 });
  const steps = () => maps.reduce((sum, map) => sum + map.steps, 0);
  try {
    for (;;) {
      const before = steps();
      const page = cursor.next();
      expect(steps() - before).toBeLessThanOrEqual(2);
      const after = steps();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(steps()).toBe(after);
      if (page.kind === "complete") break;
      expect(page.kind).toBe("entries");
    }
  } finally {
    cursor.close();
    current.dispose();
  }
});

test("W1 traversal has depth-sized state and page-sized metadata, not corpus-sized arrays", () => {
  const fs = new MemFS();
  for (let dir = 0; dir < 5000; dir++) {
    const parent = `/d${dir.toString().padStart(5, "0")}`;
    for (let at = 0; at < 10; at++)
      fs.writeFile(`${parent}/f${(dir * 10 + at).toString().padStart(5, "0")}`, new Uint8Array());
    if (dir < 32) fs.writeFile(`${parent}/large`, new Uint8Array());
  }
  const current = fixture(fs);
  const cursor = new NamespaceCursor(current.source);
  let files = 0,
    directories = 0,
    pages = 0;
  try {
    for (;;) {
      const before = current.reads;
      const page = cursor.next();
      expect(current.reads - before).toBeLessThanOrEqual(WORKSPACE_LIMITS.pageEntries);
      expect(cursor.resources().frames).toBeLessThanOrEqual(2);
      expect(cursor.resources().pending).toBeLessThanOrEqual(1);
      expect(cursor.resources().pathUnits).toBeLessThanOrEqual(2 * WORKSPACE_LIMITS.pathUnits);
      if (page.kind === "complete") break;
      if (page.kind !== "entries") throw new Error(`unexpected ${page.kind}`);
      pages++;
      expect(page.entries.length).toBeLessThanOrEqual(128);
      expect(
        page.entries.reduce(
          (sum, entry) => sum + 192 + 2 * (entry.name.length + entry.path.length),
          0,
        ),
      ).toBeLessThanOrEqual(65536);
      const counts = countKinds(page.entries);
      files += counts.files;
      directories += counts.directories;
    }
    expect({ files, directories }).toEqual({ files: 50032, directories: 5001 });
    expect(current.reads).toBe(55033);
    expect(pages).toBeGreaterThan(400);
    expect(cursor.resources()).toEqual({ frames: 0, pending: 0, pathUnits: 0 });
  } finally {
    cursor.close();
    current.dispose();
  }
});

test("oversized prefixes never become retained cursor state and limits can only tighten", () => {
  const current = fixture();
  try {
    const cursor = new NamespaceCursor(current.source, {
      prefix: "/".repeat(WORKSPACE_LIMITS.pathUnits + 1),
    });
    expect(cursor.resources()).toEqual({ frames: 0, pending: 0, pathUnits: 0 });
    expectTerminal(cursor, { kind: "pressure", resource: "path" });
    for (const pageEntries of [0, -1, NaN, Infinity, 1.5, WORKSPACE_LIMITS.pageEntries + 1]) {
      expect(() => new NamespaceCursor(current.source, {}, undefined, { pageEntries })).toThrow(
        RangeError,
      );
    }
  } finally {
    current.dispose();
  }
});

test("abort inside source callbacks stops prefix work and admission without a missed signal", () => {
  const fs = new MemFS();
  fs.writeFile("/a/b/c/file", new Uint8Array());
  const current = fixture(fs);
  try {
    const admission = new AbortController();
    const source: NamespaceSource = {
      ...current.source,
      current() {
        admission.abort();
        return current.source.current();
      },
    };
    expectTerminal(new NamespaceCursor(source, {}, admission.signal), { kind: "cancelled" });
    expect(current.reads).toBe(0);
    const prefix = new AbortController();
    const prefixed: NamespaceSource = {
      ...current.source,
      metadata(node) {
        prefix.abort();
        return current.source.metadata(node);
      },
    };
    expectTerminal(new NamespaceCursor(prefixed, { prefix: "/a/b/c/file" }, prefix.signal), {
      kind: "cancelled",
    });
    expect(current.reads).toBe(1);
  } finally {
    current.dispose();
  }
});

test("metadata failures release references and cold files need no payload access", () => {
  const fs = new MemFS();
  fs.writeFile("/cold", new Uint8Array());
  const cold = fs.root.children.get("cold");
  if (!cold || cold.kind !== "file") throw new Error("missing fixture");
  cold.size = 128 * 1024 * 1024;
  Object.defineProperty(cold, "data", {
    get() {
      throw new Error("cold payload accessed");
    },
  });
  const current = fixture(fs);
  try {
    const cursor = new NamespaceCursor(current.source);
    const page = cursor.next();
    expect(page.kind === "entries" && page.entries[1]?.size).toBe(cold.size);
    cursor.close();
    const failure = new NamespaceCursor({
      ...current.source,
      metadata() {
        throw new Error("metadata failed");
      },
    });
    expect(() => failure.next()).toThrow("metadata failed");
    expectTerminal(failure, { kind: "cancelled" });
  } finally {
    current.dispose();
  }
});

test("a cut change during a pull discards the tentative page", async () => {
  const fs = new MemFS();
  fs.writeFile("/before", new Uint8Array());
  const current = fixture(fs);
  const original = current.source.current();
  if (!original) throw new Error("missing fixture cut");
  try {
    await current.change();
    const changed = current.source.current();
    if (!changed) throw new Error("missing changed cut");
    expect(changed.generation).not.toBe(original.generation);
    let visible = original;
    const source: NamespaceSource = {
      ...current.source,
      current: () => visible,
      metadata(node) {
        visible = changed;
        return current.source.metadata(node);
      },
    };
    expectTerminal(new NamespaceCursor(source), { kind: "restart", current: changed });
    const stopped: NamespaceSource = {
      ...current.source,
      metadata(node) {
        current.stop();
        return current.source.metadata(node);
      },
    };
    expectTerminal(new NamespaceCursor(stopped), { kind: "stopped" });
  } finally {
    current.dispose();
  }
});
