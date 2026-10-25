import { FilesystemClient, type FilesystemConnection } from "../../fs";
import { createFilesystemDescriptorCodec, type FilesystemDescriptorToken } from "../../proc/filesystem-codec";
import { atomicHost } from "./wasi-atomic-host";

self.onmessage = ({ data }: MessageEvent<{
  connection: FilesystemConnection;
  token: FilesystemDescriptorToken;
  reads: readonly { offset: number; length: number }[];
}>) => {
  const client = new FilesystemClient(data.connection);
  const host = atomicHost(client, {});
  try {
    const description = createFilesystemDescriptorCodec(client).import(data.token, 2);
    const fd = host.wasi.descriptors.add(description, { rightsBase: 0x1fffffffn, rightsInheriting: 0n });
    const results = data.reads.map(({ offset, length }) => {
      host.iovecs([new Uint8Array(length).fill(201)]);
      const error = host.calls.fd_pread!(fd, 0, 1, BigInt(offset), 1024);
      const count = host.view().getUint32(1024, true);
      return { error, count, bytes: Array.from(new Uint8Array(host.memory.buffer, 2048, length)) };
    });
    self.postMessage({ results });
  } catch (error) {
    self.postMessage({ failure: String(error) });
  } finally {
    host.wasi.descriptors.dispose();
    client.dispose();
  }
};
