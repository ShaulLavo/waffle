import { createFilesystemIdentity, connectFilesystemIdentity } from "../../fs/protocol";
import {
  createFilesystemConnection,
  FilesystemClient,
  FilesystemService,
  MemoryBackend,
  createWorkspaceVfs,
  PersistentBackend,
} from "../../fs";
import { MemFS } from "../../fs/memory";
import type { SharedPageVersion } from "../../fs/shared-version-pages";

export async function residentReadFixture(size: number, maxBytes?: number) {
  const seed = new MemFS();
  seed.writeFile("/file", new Uint8Array(size).fill(65));
  const backend = new MemoryBackend(seed);
  const pair =
    maxBytes === undefined
      ? createFilesystemConnection(undefined, { workspace: true })
      : connectFilesystemIdentity(
          createFilesystemIdentity(undefined, maxBytes, { workspace: true }),
        );
  const service = new FilesystemService(backend);
  const retained: SharedPageVersion[] = [];
  let client: FilesystemClient | undefined;
  let workspace: ReturnType<typeof createWorkspaceVfs> | undefined;
  const close = async () => {
    for (const version of retained) version.release();
    await workspace?.close();
    client?.dispose();
    service.dispose();
    pair.client.port.close();
    pair.server.port.close();
  };
  try {
    service.connect(pair.server);
    client = new FilesystemClient(pair.client);
    workspace = createWorkspaceVfs(client);
    const directory = await client.asyncCall("preopen", ["/"]);
    const handle = (await client.asyncCall("resolve", [directory, "file"])).node;
    client.retain(handle);
    return {
      backend,
      client,
      service,
      workspace,
      handle,
      directory,
      close,
      pin(offset = 0, length = size) {
        const version = backend.shared.retainVersionPages(handle, offset, length);
        retained.push(version);
        return version;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export function publicReadFixture(backend: MemoryBackend) {
  const pair = createFilesystemConnection(undefined, { workspace: true });
  const service = new FilesystemService(backend);
  let client: FilesystemClient | undefined;
  let workspace: ReturnType<typeof createWorkspaceVfs> | undefined;
  const close = async () => {
    await workspace?.close();
    client?.dispose();
    await service.drainForOwner();
    service.dispose();
    if (backend instanceof PersistentBackend) await backend.close();
    pair.client.port.close();
    pair.server.port.close();
  };
  try {
    service.connect(pair.server);
    client = new FilesystemClient(pair.client);
    workspace = createWorkspaceVfs(client);
    return { backend, client, service, workspace, close };
  } catch (error) {
    void close();
    throw error;
  }
}
