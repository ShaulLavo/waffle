import { FilesystemService, MemoryBackend, type FilesystemConnection } from "../../fs";

class ReadlinkBackend extends MemoryBackend {
  constructor(private readonly calls: Int32Array) {
    super();
  }
  override execute(operation: string, args: unknown[], data: Uint8Array): unknown {
    if (operation === "readlink") Atomics.add(this.calls, 0, 1);
    return super.execute(operation, args, data);
  }
}

self.onmessage = ({
  data,
}: MessageEvent<{ connection: FilesystemConnection; calls: SharedArrayBuffer }>) => {
  const service = new FilesystemService(new ReadlinkBackend(new Int32Array(data.calls)));
  service.connect(data.connection);
  self.postMessage({ ready: true });
};
