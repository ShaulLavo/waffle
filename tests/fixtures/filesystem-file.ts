import {
  FilesystemClient,
  FilesystemService,
  MemoryBackend,
  createFilesystemConnection,
} from "../../fs";

export async function filesystemFileFixture(cleanups: (() => void)[]) {
  const backend = new MemoryBackend();
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection();
  service.connect(connection.server);
  const client = new FilesystemClient(connection.client);
  cleanups.push(() => {
    client.dispose();
    service.dispose();
  });
  await client.asyncCall("writeFile", ["/file"], new TextEncoder().encode("abcdef"));
  const root = await client.asyncCall("preopen", ["/"]);
  const { node: handle } = await client.asyncCall("resolve", [root, "file"]);
  client.retain(handle);
  return { backend, service, client, handle };
}
