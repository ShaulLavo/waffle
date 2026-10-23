import type { StorageLockManager } from "../../fs/indexeddb";

type Entry =
  | { kind: "file"; name: string; bytes: Uint8Array }
  | { kind: "directory"; name: string; entries: Map<string, Entry> };
export function identityOpfsFixture() {
  const tree: Extract<Entry, { kind: "directory" }> = {
    kind: "directory",
    name: "root",
    entries: new Map(),
  };
  const events: string[] = [];
  let fault: ((stage: string, name: string) => void) | undefined;
  const visit = (stage: string, name: string) => {
    events.push(`${stage}:${name}`);
    fault?.(stage, name);
  };
  function file(entry: Extract<Entry, { kind: "file" }>) {
    return {
      kind: "file",
      name: entry.name,
      async getFile() {
        return new File([new Uint8Array(entry.bytes)], entry.name);
      },
      async createSyncAccessHandle() {
        visit("open", entry.name);
        return {
          getSize: () => entry.bytes.length,
          truncate: (size: number) => {
            entry.bytes = new Uint8Array(size);
          },
          read: (target: Uint8Array, { at }: { at: number }) => {
            const part = entry.bytes.subarray(at, at + target.length);
            target.set(part);
            return part.length;
          },
          write: (source: Uint8Array, { at }: { at: number }) => {
            entry.bytes.set(source, at);
            return source.length;
          },
          flush: () => visit("flush", entry.name),
          close: () => visit("close", entry.name),
        };
      },
    };
  }
  function directory(entry: Extract<Entry, { kind: "directory" }>): FileSystemDirectoryHandle {
    const value = {
      kind: "directory",
      name: entry.name,
      async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        let child = entry.entries.get(name);
        if (!child && options?.create) {
          child = { kind: "directory", name, entries: new Map() };
          entry.entries.set(name, child);
        }
        if (child?.kind !== "directory")
          throw new DOMException("missing directory", "NotFoundError");
        return directory(child);
      },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        let child = entry.entries.get(name);
        if (!child && options?.create) {
          child = { kind: "file", name, bytes: new Uint8Array() };
          entry.entries.set(name, child);
          visit("create", name);
        }
        if (child?.kind !== "file") throw new DOMException("missing file", "NotFoundError");
        return file(child);
      },
      async *entries() {
        for (const [name, child] of entry.entries)
          yield [name, child.kind === "directory" ? directory(child) : file(child)];
      },
      async removeEntry(name: string) {
        visit("remove", name);
        entry.entries.delete(name);
        visit("removed", name);
      },
    };
    // This fixture implements only the OPFS methods exercised by the production adapter.
    return value as unknown as FileSystemDirectoryHandle;
  }
  const locks: StorageLockManager = {
    async request(_name, _options, callback) {
      return callback({});
    },
  };
  const metadata = () => {
    const workspace = Array.from(tree.entries.values())[0];
    if (workspace?.kind !== "directory") throw new Error("missing workspace");
    const entry = workspace.entries.get("metadata");
    if (entry?.kind !== "directory") throw new Error("missing metadata");
    return entry;
  };
  return {
    root: directory(tree),
    locks,
    events,
    fault(next?: typeof fault) {
      fault = next;
    },
    markers() {
      return Array.from(metadata().entries.keys()).filter((name) => name.startsWith("identity-"));
    },
    corrupt(name: string) {
      metadata().entries.set(name, { kind: "file", name, bytes: new Uint8Array() });
    },
  };
}
