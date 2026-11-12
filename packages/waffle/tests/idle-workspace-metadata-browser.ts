import type { IdleWorkspaceWalk, StoredWorkspaceEntry } from "../index.js";
import type { PersistenceBatch } from "../fs/storage.js";
import { idle } from "./idle-workspace-fixtures.js";
import { assert, bytes, rejects, type StorageContractCase } from "./storage-browser-helpers.js";

function tree(): PersistenceBatch {
  const source = bytes("binary\0source");
  const target = "/app/source";
  return {
    generation: 1,
    root: 1,
    removes: [],
    data: new Map([["source", source]]),
    upserts: [
      {
        ino: 1,
        kind: "dir",
        size: 0,
        mtime: 17.25,
        children: [
          ["app", 2],
          ["link", 4],
          ["socket", 5],
          ["empty", 6],
          ["hard", 3],
        ],
      },
      {
        ino: 2,
        kind: "dir",
        size: 0,
        mode: 0o1700,
        mtime: 18,
        children: [
          ["source", 3],
          ["node_modules", 7],
          ["node_modules-old", 8],
        ],
      },
      { ino: 3, kind: "file", size: source.length, mode: 0o400, mtime: 19, data: "source" },
      { ino: 4, kind: "symlink", size: bytes(target).length, mtime: 20, target },
      { ino: 5, kind: "socket", size: 0, mtime: 21 },
      { ino: 6, kind: "dir", size: 0, mtime: 22, children: [] },
      { ino: 7, kind: "dir", size: 0, mtime: 23, children: [["pruned-sentinel", 9]] },
      { ino: 8, kind: "dir", size: 0, mtime: 24, children: [] },
      { ino: 9, kind: "dir", size: 0, mtime: 25, children: [] },
    ],
  };
}

async function collect(cursor: IdleWorkspaceWalk): Promise<StoredWorkspaceEntry[]> {
  const entries: StoredWorkspaceEntry[] = [];
  try {
    for (;;) {
      const page = await cursor.next();
      assert(page.entries.length <= 256, "fixed metadata page bound");
      for (const entry of page.entries) entries.push(entry);
      if (page.done) return entries;
    }
  } finally {
    await cursor.close();
  }
}

function throws(action: () => unknown, type: typeof TypeError | typeof RangeError): void {
  try {
    action();
  } catch (error) {
    assert(error instanceof type, `Expected ${type.name}, got ${error}`);
    return;
  }
  throw new Error(`Expected ${type.name}`);
}

export function idleMetadataCases(): StorageContractCase[] {
  return [
    {
      label: "idle workspace metadata includes empty directories, links and preservation fields",
      async run(name, open) {
        const storage = await open();
        await storage.persist(tree());
        await storage.close();
        const owner = await idle(name);
        try {
          const entries = await collect(owner.walk());
          const byPath = new Map(entries.map((entry) => [entry.path, entry]));
          assert(
            entries.length === 10 && byPath.get("/")?.mtime === 17.25,
            "whole stored tree including selected root",
          );
          assert(
            byPath.get("/")?.mode === 0o700 && byPath.get("/link")?.mode === 0o600,
            "legacy defaults resolved",
          );
          assert(byPath.get("/app")?.mode === 0o1700, "stored directory mode preserved");
          const source = byPath.get("/app/source");
          assert(
            source?.kind === "file" &&
              source.mode === 0o400 &&
              source.mtime === 19 &&
              source.size === bytes("binary\0source").length,
            "file metadata",
          );
          assert(
            source.nlink === 2 && byPath.get("/hard")?.ino === source.ino,
            "whole-tree hardlink identity and count",
          );
          assert(
            byPath.get("/link")?.target === "/app/source" &&
              byPath.get("/socket")?.kind === "socket",
            "unsupported entry kinds observable",
          );
          assert(byPath.get("/empty")?.kind === "dir", "empty directory observable");
          const link = await collect(owner.walk("/link"));
          assert(
            link.length === 1 && link[0]?.kind === "symlink",
            "walk does not follow selected symlink",
          );
          assert(
            new TextDecoder().decode(await owner.readFile("/link")) === "binary\0source",
            "convenience read follows runtime semantics",
          );
        } finally {
          await owner.close();
        }
      },
    },
    {
      label: "idle workspace walk prunes exact roots before scanning descendants",
      async run(name, open) {
        const storage = await open();
        await storage.persist(tree());
        await storage.close();
        const owner = await idle(name);
        const nativeIterator = Map.prototype[Symbol.iterator];
        try {
          const ignoreRoots = [
            "/app/node_modules",
            "/app/node_modules/pruned-sentinel",
            "/else",
            "/app/node_modules",
          ];
          const cursor = owner.walk("/", { ignoreRoots });
          ignoreRoots[0] = "/hard";
          Map.prototype[Symbol.iterator] = function () {
            assert(!this.has("pruned-sentinel"), "pruned child map must never be traversed");
            return nativeIterator.call(this);
          };
          const entries = await collect(cursor);
          const paths = entries.map((entry) => entry.path);
          assert(
            !paths.includes("/app/node_modules") &&
              !paths.some((path) => path.startsWith("/app/node_modules/")),
            "ignored root and descendants absent",
          );
          assert(paths.includes("/") && paths.includes("/app"), "shared ancestors remain");
          assert(
            paths.includes("/app/node_modules-old") && paths.includes("/hard"),
            "exact boundary and options snapshot",
          );
          for (const selected of ["/app", "/app/source"])
            throws(() => owner.walk(selected, { ignoreRoots: ["/app"] }), RangeError);
          throws(() => owner.walk("/", { ignoreRoots: ["/"] }), RangeError);
          for (const invalid of [
            "",
            "relative",
            "//app",
            "/app/",
            "/app//source",
            "/app/./source",
            "/app/../source",
            "/a\0b",
          ])
            throws(() => owner.walk("/", { ignoreRoots: [invalid] }), TypeError);
        } finally {
          Map.prototype[Symbol.iterator] = nativeIterator;
          await owner.close();
        }
      },
    },
    {
      label: "idle workspace walk pages, cancellation and closure are bounded",
      async run(name, open) {
        const storage = await open();
        const saved = tree();
        const root = saved.upserts[0];
        assert(root?.kind === "dir" && root.children, "fixture root");
        for (let ino = 10; ino < 610; ino++) {
          root.children.push([`empty-${ino}`, ino]);
          saved.upserts.push({ ino, kind: "file", size: 0, mtime: ino });
        }
        await storage.persist(saved);
        await storage.close();
        const owner = await idle(name);
        try {
          const cursor = owner.walk();
          const first = await cursor.next();
          assert(
            first.entries.length === 256 && !first.done && first.entries[0]?.path === "/",
            "selected root first and fixed page bound",
          );
          const rest = await collect(cursor);
          assert(rest.length === 354, "remaining entries exhaustive");
          assert(
            (await cursor.next()).done && (await cursor.next()).entries.length === 0,
            "terminal pages stay empty",
          );
          const cancelled = new AbortController();
          const pending = owner.walk("/", { signal: cancelled.signal });
          await pending.next();
          const reason = new Error("cancel metadata walk");
          cancelled.abort(reason);
          assert(
            (await pending.next().catch((error: unknown) => error)) === reason,
            "cursor cancellation identity",
          );
          const closed = pending.close();
          assert(pending.close() === closed, "cursor close idempotent");
          const remaining = owner.walk();
          await owner.close();
          await rejects(remaining.next(), "closed");
        } finally {
          await owner.close();
        }
      },
    },
    {
      label: "idle workspace oversized and cancelled reads allocate no payload",
      async run(name, open) {
        const storage = await open();
        const saved = tree();
        const payload = new Uint8Array(8388609);
        saved.upserts.push({
          ino: 10,
          kind: "file",
          size: payload.length,
          mtime: 26,
          data: "huge",
        });
        saved.upserts[0]!.children!.push(["huge", 10]);
        saved.data.set("huge", payload);
        await storage.persist(saved);
        await storage.close();
        const owner = await idle(name);
        const get = IDBObjectStore.prototype.get;
        let payloadReads = 0;
        IDBObjectStore.prototype.get = function (key) {
          if (this.name === "data" && Array.isArray(key)) payloadReads++;
          return get.call(this, key);
        };
        try {
          await rejects(owner.readFile("/huge"), "maxBytes");
          await rejects(owner.readFile("/app/source", { maxBytes: 1 }), "maxBytes");
          for (const maxBytes of [-1, 1.5, NaN, Infinity, 8388609])
            await rejects(owner.readFile("/app/source", { maxBytes }), "maxBytes");
          const reason = new Error("cancel bounded read");
          assert(
            (await owner
              .readFile("/app/source", { signal: AbortSignal.abort(reason) })
              .catch((error: unknown) => error)) === reason,
            "read cancellation identity",
          );
          assert(payloadReads === 0, "refusal and abort precede payload allocation");
          assert((await owner.readFile("/missing")) === undefined, "missing ordinary file");
          assert(
            (await owner.readFile("/app/source", { maxBytes: bytes("binary\0source").length }))
              ?.length === bytes("binary\0source").length,
            "exact bounded read is complete",
          );
        } finally {
          IDBObjectStore.prototype.get = get;
          await owner.close();
        }
      },
    },
  ];
}
