import { expect, test } from "bun:test";
import { FilesystemClient, FilesystemService, MemoryBackend, createFilesystemConnection } from "../fs";
import { publicationObserver, type PublicationLimits } from "../fs/publication-internal";

const limits: PublicationLimits = {
  sessions: 8,
  operations: 8,
  inputBytes: 64,
  argumentBytes: 512,
  effectBytes: 4096,
  effects: 16,
  resultBytes: 256,
  logRecords: 4,
  logBytes: 16384,
  pins: 2,
  pinBytes: 256,
};

test("the production service issues a private retained resident descriptor", async () => {
  const backend = new MemoryBackend();
  backend.fs.writeFile("/file", new Uint8Array([1, 2, 3]));
  const service = new FilesystemService(backend);
  const connection = createFilesystemConnection(undefined, { limits, observe: true });
  service.connect(connection.server);
  const root = new FilesystemClient(connection.client);
  try {
    const directory: number = await root.asyncCall("preopen", ["/"]);
    const path: { node: number } = await root.asyncCall("resolve", [directory, "file"]);
    root.retain(path.node);
    const before = await publicationObserver(root).cut();
    const descriptor: unknown = await root.asyncCall("publicationResident", [
      connection.client.publication!.observer,
      path.node,
      "resident-red-control",
    ]);
    expect(descriptor).toMatchObject({ workspace: "resident-red-control", handle: path.node });
    expect(await publicationObserver(root).cut()).toEqual(before);
  } finally {
    root.dispose();
    service.dispose();
  }
});
