import { restoreIdentity } from "./file-identity.js";
import { MemFS, type Node } from "./memory.js";
import type { PersistedIndex, PersistedNode } from "./storage.js";

function restoreNode(entry: PersistedNode): Node {
  const metadata = {
    ino: entry.ino,
    identity: entry.identity && restoreIdentity(entry.identity),
    mtime: entry.mtime,
  };
  if (entry.kind === "dir")
    return { ...metadata, kind: "dir", mode: entry.mode ?? 0o700, children: new Map() };
  if (entry.kind === "socket") return { ...metadata, kind: "socket", mode: entry.mode ?? 0o600 };
  if (entry.kind === "symlink")
    return { ...metadata, kind: "symlink", mode: entry.mode ?? 0o600, target: entry.target };
  return {
    ...metadata,
    kind: "file",
    mode: entry.mode ?? 0o600,
    size: entry.size,
    data: new Uint8Array(),
  };
}

export function restoreTree(index: PersistedIndex): MemFS {
  const nodes = new Map(index.nodes.map((entry) => [entry.ino, restoreNode(entry)]));
  for (const entry of index.nodes) {
    const node = nodes.get(entry.ino);
    if (node?.kind !== "dir") continue;
    for (const [name, ino] of entry.children ?? []) {
      const child = nodes.get(ino);
      if (!child) throw new Error(`persisted filesystem references missing inode ${ino}`);
      node.children.set(name, child);
    }
  }
  const root = nodes.get(index.root);
  if (root?.kind !== "dir") throw new Error("persisted filesystem has no root directory");
  return new MemFS(root);
}
