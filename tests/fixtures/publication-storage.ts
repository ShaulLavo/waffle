import type { PersistedIndex } from "../../fs/storage";

export function coldPublicationRoot(): PersistedIndex {
  return {
    version: 1,
    generation: 1,
    root: 100,
    nodes: [
      { ino: 100, kind: "dir", mode: 0o700, size: 0, mtime: 1, children: [["file", 101]] },
      { ino: 101, kind: "file", mode: 0o600, size: 3, mtime: 1, data: "fixture-payload" },
    ],
  };
}
