import { threadServiceCommand } from "../thread/service-worker.js";
import { FilesystemSection, isRevoked, type FilesystemConnection } from "../fs/protocol.js";
import type { ThreadServiceCommand } from "../thread/runtime-protocol.js";
let section: FilesystemSection | undefined;
let connection: FilesystemConnection | undefined;
self.onmessage = ({ data }: MessageEvent<ThreadServiceCommand | { kind: "fixture-release" }>) => {
  if (data.kind === "fixture-release") {
    section?.exit();
    section = undefined;
    self.postMessage({ kind: "fixture-released" });
    return;
  }
  if (data.kind === "thread-service") {
    connection = data.filesystem;
    section = new FilesystemSection(connection);
    section.enter();
    self.postMessage({ kind: "fixture-held", sections: connection.sections });
  }
  if (data.kind === "drain")
    self.postMessage({ kind: "fixture-draining", revoked: connection && isRevoked(connection) });
  void threadServiceCommand(data).catch((error: unknown) =>
    self.postMessage({ kind: "service-error", message: String(error) }),
  );
};
