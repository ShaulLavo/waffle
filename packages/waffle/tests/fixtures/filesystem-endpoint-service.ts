import { FilesystemService, MemoryBackend, type FilesystemConnection } from "../../fs/index.js";
import { observeFilesystemEndpoint } from "./filesystem-endpoint-observer.js";

export type ServiceCommand =
  | { kind: "connect"; connection: FilesystemConnection; tree: string }
  | { kind: "fault"; owner: number }
  | { kind: "snapshot" }
  | { kind: "dispose" };
declare const self: Worker;
const service = new FilesystemService(new MemoryBackend());
const sessions = new Map<
  number,
  {
    connection: FilesystemConnection;
    observer: ReturnType<typeof observeFilesystemEndpoint>;
  }
>();
self.onmessage = ({ data }: MessageEvent<ServiceCommand & { id: number }>) => {
  try {
    const snapshots = execute(data);
    self.postMessage({ id: data.id, snapshots });
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error) });
  }
};
function execute(command: ServiceCommand) {
  if (command.kind === "connect") {
    const connection = command.connection;
    const observer = observeFilesystemEndpoint(connection, {
      tree: command.tree,
      realm: "dedicated-service-worker",
      endpoint: "service",
      workerURL: import.meta.url,
    });
    sessions.set(connection.owner, { connection, observer });
    service.connect(connection);
    observer.qualifyHandlers();
  }
  if (command.kind === "fault") {
    const session = sessions.get(command.owner);
    if (!session) throw Error("unknown service endpoint");
    session.connection.port.dispatchEvent(new MessageEvent("messageerror"));
  }
  const snapshots = Array.from(sessions.values(), ({ observer }) => observer.snapshot());
  if (command.kind !== "dispose") return snapshots;
  service.dispose();
  for (const { connection, observer } of sessions.values()) {
    observer.dispose();
    connection.port.close();
  }
  sessions.clear();
  return snapshots;
}
