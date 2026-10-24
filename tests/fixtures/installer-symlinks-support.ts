import { MemoryBackend } from "../../fs/backend.js";
import { FilesystemClient } from "../../fs/client.js";
import type { MemFS, Node } from "../../fs/memory.js";
import { createFilesystemConnection } from "../../fs/protocol.js";
import { FilesystemService } from "../../fs/service.js";

export function symlinkSnapshotValue(node: Node) {
  if (node.kind === "file") return Array.from(node.data);
  if (node.kind === "symlink") return node.target;
  return Array.from(node.children.keys());
}

export function filesystemServiceFixture(fs: MemFS, cleanup: (stop: () => void) => void) {
  const backend = new MemoryBackend(fs);
  const owner = new FilesystemService(backend);
  cleanup(() => owner.dispose());
  const connection = createFilesystemConnection();
  cleanup(() => connection.server.port.close());
  cleanup(() => connection.client.port.close());
  const client = new FilesystemClient(connection.client);
  cleanup(() => client.dispose());
  owner.connect(connection.server);
  return { client, backend };
}
