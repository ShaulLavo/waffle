import { expect, test } from "bun:test";
import {
  FilesystemClient,
  FilesystemService,
  MemoryBackend,
  createFilesystemConnection,
} from "../fs";

test("local publication orders real host, WASI and direct writers without a nudge", async () => {
  const service = new FilesystemService(new MemoryBackend());
  const connection = createFilesystemConnection();
  service.connect(connection.server);
  const root = new FilesystemClient(connection.client);
  const sibling = new FilesystemClient(root.fork());
  try {
    await root.asyncCall("writeFile", ["/file"], new TextEncoder().encode("host"));
    const directory = await root.asyncCall("preopen", ["/"]);
    const path = await root.asyncCall("resolve", [directory, "file"]);
    await root.asyncCall("retain", [path.node]);
    expect(root.tryWrite(path.node, [new TextEncoder().encode("direct")], 0)).toBe(6);
    const peerDirectory = await sibling.asyncCall("preopen", ["/"]);
    const peerPath = await sibling.asyncCall("resolve", [peerDirectory, "file"]);
    await sibling.asyncCall("retain", [peerPath.node]);
    const output = new Uint8Array(6);
    expect(sibling.tryRead(peerPath.node, [output], 0)).toBe(6);
    expect(new TextDecoder().decode(output)).toBe("direct");
    const cut = await root.asyncCall("publicationCut");
    expect(cut.history).toBeString();
    expect(cut.history.length).toBeGreaterThan(0);
    expect(cut.generation).toBeGreaterThan(0);
  } finally {
    sibling.dispose();
    root.dispose();
    service.dispose();
  }
});
