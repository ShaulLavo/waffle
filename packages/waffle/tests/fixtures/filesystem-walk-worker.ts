import type { WalkEntry } from "../../fs/walk.js";
import { FilesystemClient } from "../../fs/client.js";
import type { FilesystemConnection } from "../../fs/protocol.js";

self.onmessage = ({ data }: MessageEvent<FilesystemConnection>) => {
  const client = new FilesystemClient(data);
  const paths: string[] = [],
    bytes: number[] = [];
  const initial = client.walkOpen(client.preopen("/"), {
    include: [],
    exclude: [],
    excludeDirectories: [],
    hidden: false,
    maxDepth: null,
  });
  let cursor: typeof initial | null = initial;
  try {
    while (cursor) {
      const page = client.walkPage(cursor, { grant: true, maxEntries: 1 });
      for (const entry of page.entries) consume(client, entry, paths, bytes);
      cursor = page.next;
    }
    self.postMessage({ paths, bytes });
  } finally {
    client.walkClose(initial);
    client.dispose();
  }
};

function consume(
  client: FilesystemClient,
  entry: WalkEntry,
  paths: string[],
  bytes: number[],
): void {
  if (entry.kind !== "file" || entry.handle === null || entry.grant === null)
    throw new Error("expected file grant");
  client.retain(entry.handle);
  const buffer = new Uint8Array(entry.size);
  if (client.read(entry.handle, [buffer], 0) !== entry.size) throw new Error("short read");
  paths.push(entry.path);
  bytes.push(...buffer);
  client.release(entry.handle);
  client.walkRelease([entry.grant]);
}
