import { MemoryBackend } from "../../fs/backend.js";
import { FilesystemService } from "../../fs/service.js";
import type { FilesystemConnection } from "../../fs/protocol.js";

let service: FilesystemService | undefined;
globalThis.onmessage = ({
  data,
}: MessageEvent<{
  readonly connect?: FilesystemConnection;
  readonly sweep?: boolean;
  readonly dispose?: boolean;
  readonly resources?: number;
}>) => {
  if (data.resources !== undefined) {
    service?.sweep();
    globalThis.postMessage({
      type: "search-resources",
      id: data.resources,
      resources: service?.resources(),
    });
    return;
  }
  if (data.dispose) {
    void (service?.shutdown() ?? Promise.resolve()).then(() =>
      globalThis.postMessage({ type: "filesystem-disposed" }),
    );
    return;
  }
  service ??= new FilesystemService(new MemoryBackend());
  if (data.connect) {
    service.connect(data.connect);
    globalThis.postMessage({ type: "filesystem-state", status: "ready" });
  } else if (data.sweep) service.sweep();
};
