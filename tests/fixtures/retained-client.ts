import { FilesystemClient, createFilesystemConnection } from "../../fs/index.js";

export function retainedClientFixture() {
  const pair = createFilesystemConnection();
  const client = new FilesystemClient(pair.client);
  client.shared.register(
    0,
    { kind: "file", ino: 1, nlink: 1, size: 4, mtime: 1 },
    new Uint8Array([65, 66, 67, 68]),
  );
  const capabilities = new Int32Array(pair.client.capabilities);
  Atomics.store(capabilities, 1, 0);
  Atomics.store(capabilities, 2, 0);
  client.retain(0);
  client.call = () => {
    throw new Error("unexpected I/O RPC");
  };
  return {
    client,
    cleanup: () => {
      client.dispose();
      pair.server.port.close();
    },
  };
}
