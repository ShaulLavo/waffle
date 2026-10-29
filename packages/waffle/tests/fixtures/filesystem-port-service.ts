import { FilesystemService, MemoryBackend, type FilesystemConnection } from "../../fs/index.js";

const service = new FilesystemService(new MemoryBackend());
const connect = service.connect.bind(service);
function containsShared(value: unknown): boolean {
  if (value instanceof SharedArrayBuffer) return true;
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some(containsShared);
}
service.connect = (connection) => {
  connect(connection);
  connection.port.addEventListener("messageerror", () =>
    self.postMessage({ type: "messageerror", owner: connection.owner }),
  );
  connection.port.addEventListener("message", (event) => {
    if (containsShared(event.data))
      self.postMessage({ type: "shared-payload", owner: connection.owner });
  });
};
self.onmessage = async ({
  data,
}: MessageEvent<{ connect?: FilesystemConnection; dispose?: boolean }>) => {
  if (data.connect) service.connect(data.connect);
  else if (data.dispose) {
    try {
      await service.shutdown();
      self.postMessage({ type: "disposed" });
    } catch (error) {
      self.postMessage({ type: "error", message: String(error) });
    }
  }
};
