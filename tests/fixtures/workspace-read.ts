import {
  createFilesystemConnection,
  FilesystemClient,
  FilesystemService,
  MemoryBackend,
  createWorkspaceVfs,
} from "../../fs";
import { MemFS } from "../../fs/memory";
import type { SharedPageVersion } from "../../fs/shared-version-pages";

export async function residentReadFixture(size: number) {
  const seed = new MemFS();
  seed.writeFile("/file", new Uint8Array(size).fill(65));
  const backend = new MemoryBackend(seed);
  const pair = createFilesystemConnection(undefined, { workspace: true });
  const root = pair.client.publication!;
  const buffers = { ...root.buffers, pageReaders: new SharedArrayBuffer(16_384 * 4) };
  pair.client.publication = { ...root, buffers };
  pair.server.publication = { ...pair.server.publication!, buffers };
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
