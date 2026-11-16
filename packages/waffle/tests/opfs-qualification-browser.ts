import type { OpfsStorage, OpfsStorageOptions } from "../fs/opfs.js";
import type { PersistenceBatch } from "../fs/storage.js";
import { PersistentBackend } from "../fs/persistent.js";
import { assert, batch, bytes } from "./storage-browser-helpers.js";

type Open = (options?: OpfsStorageOptions) => Promise<OpfsStorage>;
type NativeAccess = {
  truncate(size: number): void;
  write(bytes: Uint8Array, options: { at: number }): number;
  close(): void;
};
type SyncFile = FileSystemFileHandle & { createSyncAccessHandle(): Promise<NativeAccess> };

function observeSlice(
  blob: Blob,
  failed: (error: unknown) => void,
  restore: () => Promise<void>,
): Blob {
  const read = blob.arrayBuffer;
  blob.arrayBuffer = function () {
    return read
      .call(this)
      .catch((error: unknown) => {
        failed(error);
        throw error;
      })
      .finally(restore);
  };
  return blob;
}

function observeSnapshot(
  file: File,
  failed: (error: unknown) => void,
  restore: () => Promise<void>,
): File {
  const slice = file.slice;
  file.slice = function (start, end, type) {
    return observeSlice(slice.call(this, start, end, type), failed, restore);
  };
  return file;
}

async function restoreSnapshot(handle: SyncFile, contents: Uint8Array): Promise<void> {
  const access = await handle.createSyncAccessHandle();
  try {
    access.truncate(contents.length);
    assert(access.write(contents, { at: 0 }) === contents.length, "restore complete native bytes");
  } finally {
    access.close();
  }
}

async function invalidatedSnapshot(open: Open): Promise<void> {
  const seed = await open();
  await seed.persist(batch(1, "native snapshot bytes"));
  await seed.flush();
  await seed.close();
  const storage = await open();
  await storage.load();
  const retention = storage.retainPayload("file:1", bytes("native snapshot bytes").length);
  const prototype = FileSystemFileHandle.prototype;
  const original = prototype.getFile;
  let acquisitions = 0,
    nativeFailure: { error: unknown } | undefined;
  prototype.getFile = async function () {
    const file = await original.call(this);
    if (!this.name.startsWith("p-") || ++acquisitions !== 1) return file;
    const contents = new Uint8Array(await file.arrayBuffer());
    const handle = this as SyncFile;
    const writable = await this.createWritable();
    try {
      await writable.write(contents);
      await writable.write(new Uint8Array([99]));
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
    return observeSnapshot(
      file,
      (error) => {
        nativeFailure = { error };
      },
      () => restoreSnapshot(handle, contents),
    );
  };
  try {
    const read = () => storage.readRange("file:1", { offset: 7, length: 8 });
    let result: Uint8Array;
    try {
      result = await read();
    } catch (error) {
      assert(
        nativeFailure && error === nativeFailure.error,
        "unrelated native failure stays exact",
      );
      assert(
        error instanceof DOMException && error.name !== "NotReadableError",
        "recoverable invalidation retries",
      );
      assert(acquisitions === 1, "unrelated native error does not retry");
      result = await read();
    }
    assert(new TextDecoder().decode(result) === "snapshot", "read exact bytes after modification");
    assert(acquisitions === (nativeFailure ? 2 : 1), "reacquire only an invalidated native File");
    console.log(
      `OPFS qualification native error=${String(nativeFailure?.error)} acquisitions=${acquisitions}`,
    );
  } finally {
    prototype.getFile = original;
    retention.release();
    await storage.close();
  }
}

async function appendLifecycle(open: Open): Promise<void> {
  const backend = await PersistentBackend.open(await open(), { intervalMs: 0 });
  const chunks = [
    new Uint8Array(4093).fill(11),
    new Uint8Array(7).fill(22),
    new Uint8Array(4099).fill(33),
    new Uint8Array(8193).fill(44),
  ];
  const expected = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  const snapshot = backend.shared.snapshot;
  let offset = 0;
  try {
    // Resident append writes pages in place. Full immutable revisions are copied only
    // at checkpoints, not for every appended chunk.
    backend.shared.snapshot = () => {
      throw new Error("append copied the complete old file");
    };
    for (const chunk of chunks) {
      await backend.prepare("writeFile", ["/append", true]);
      await backend.execute("writeFile", ["/append", true], chunk);
      expected.set(chunk, offset);
      offset += chunk.length;
    }
    backend.shared.snapshot = snapshot;
    await backend.flush();
  } finally {
    backend.shared.snapshot = snapshot;
    await backend.close();
  }
  const reopened = await PersistentBackend.open(await open(), { intervalMs: 0 });
  try {
    await reopened.prepare("readFile", ["/append"]);
    const result = await reopened.execute("readFile", ["/append"], new Uint8Array());
    assert(
      result instanceof Uint8Array &&
        result.length === expected.length &&
        result.every((byte, i) => byte === expected[i]),
      "append crosses page capacities and reopens byte-exactly",
    );
  } finally {
    await reopened.close();
  }
}

function revision(generation: number, contents: Uint8Array): PersistenceBatch {
  const value = batch(generation);
  value.upserts[1]!.size = contents.length;
  value.data.set(`file:${generation}`, contents);
  return value;
}

async function payloadLifecycle(open: Open): Promise<void> {
  const storage = await open({ createConcurrency: 2, handleCacheSize: 1 });
  const large = Uint8Array.from({ length: 8 * 1024 * 1024 + 3 }, (_, i) => i % 251);
  try {
    const first = revision(1, large);
    first.upserts[0]!.children!.push(["other", 3]);
    first.upserts.push({ ino: 3, kind: "file", mtime: 1, size: large.length, data: "other" });
    first.data.set("other", large);
    await storage.persist(first);
    await storage.flush();
    const retained = storage.retainPayload("file:1", large.length);
    try {
      const result = await storage.readRange("file:1", { offset: large.length - 3, length: 8 });
      assert(
        result.length === 3 && result.every((byte, i) => byte === large[large.length - 3 + i]),
        "retained range reads beside a cached exclusive handle",
      );
    } finally {
      retained.release();
    }
    // Reuse a known immutable key after caching its original sync handle. Verification
    // must evict that original before acquiring another exclusive handle.
    assert(
      (await storage.readRange("file:1", { offset: large.length - 3, length: 8 })).length === 3,
      "large file EOF range",
    );
    const identical = revision(2, large);
    identical.removes.push(3);
    identical.upserts[1]!.data = "file:1";
    identical.data = new Map([["file:1", large]]);
    await storage.persist(identical);
    await storage.persist(revision(3, bytes("small")));
    await storage.flush();
    await storage.close();
    const reopened = await open();
    try {
      assert((await reopened.load())?.generation === 3, "smaller overwrite generation survives");
      assert(
        new TextDecoder().decode(await reopened.read("file:3")) === "small",
        "smaller overwrite has no old tail",
      );
      await reopened.persist(revision(4, new Uint8Array()));
      await reopened.flush();
    } finally {
      await reopened.close();
    }
    const empty = await open();
    try {
      await empty.load();
      assert((await empty.read("file:4")).length === 0, "zero-byte payload physically exists");
      await empty.persist({
        generation: 5,
        root: 1,
        upserts: [{ ino: 1, kind: "dir", mtime: 5, size: 0, children: [] }],
        removes: [2],
        data: new Map(),
      });
      await empty.flush();
    } finally {
      await empty.close();
    }
    const deleted = await open();
    try {
      const index = await deleted.load();
      assert(
        index?.nodes.length === 1 && index.nodes[0]?.children?.length === 0,
        "zero-byte deletion survives reopen",
      );
      // Rollback can still retain file:4 physically; it must not reappear in the current tree.
    } finally {
      await deleted.close();
    }
  } finally {
    await storage.close();
  }
}

export function opfsQualificationCases() {
  return [
    {
      label: "OPFS qualification native File invalidation reacquires exact bytes",
      run: (_name: string, open: Open) => invalidatedSnapshot(open),
    },
    {
      label: "OPFS qualification large overwrite and zero-byte lifecycle reopen exactly",
      run: (_name: string, open: Open) => payloadLifecycle(open),
    },
    {
      label: "OPFS qualification resident append crosses capacity without full snapshots",
      run: (_name: string, open: Open) => appendLifecycle(open),
    },
  ];
}
