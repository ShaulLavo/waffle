import { FilesystemClient, type FilesystemService } from "../../fs/index.js";
import {
  connectFilesystemIdentity,
  type FilesystemConnection,
  type FilesystemIdentity,
} from "../../fs/protocol.js";
import type { FilesystemRequestPool } from "../../fs/request-memory.js";

/** Same-agent host fixture capability, never placed in Worker data or guest options. */
export function filesystemHostConnector(
  service: Pick<FilesystemService, "connect">,
  pool: FilesystemRequestPool,
) {
  return (identity: FilesystemIdentity): FilesystemConnection => {
    const child = connectFilesystemIdentity(identity, pool);
    try {
      service.connect(child.server);
      return child.client;
    } catch (error) {
      child.client.port.close();
      child.server.port.close();
      throw error;
    }
  };
}
export function hostFilesystemClient(
  service: Pick<FilesystemService, "connect">,
  connection: { client: FilesystemConnection; pool: FilesystemRequestPool },
): FilesystemClient {
  return new FilesystemClient(connection.client, {
    connect: filesystemHostConnector(service, connection.pool),
  });
}
