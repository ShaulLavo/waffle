import { threadServiceCommand } from "../thread/service-worker.js";
import { FilesystemSection, isRevoked, type FilesystemConnection } from "../fs/protocol.js";
import type { ThreadServiceCommand } from "../thread/runtime-protocol.js";
let section: FilesystemSection | undefined;
let connection: FilesystemConnection | undefined;
let causal: Int32Array | undefined;
let localSequence = 0;
function event(kind: string, fields: Record<string, unknown> = {}): void {
  const sequence = causal ? Atomics.add(causal, 0, 1) + 1 : ++localSequence;
  self.postMessage({ kind, causalSequence: sequence, at: performance.now(), ...fields });
}
function failure(error: unknown): void {
  event("service-error", { message: String(error) });
}
self.onmessage = ({
  data,
}: MessageEvent<ThreadServiceCommand | { kind: "fixture-release" | "fixture-probe" }>) => {
  if (data.kind === "fixture-probe") {
    event("fixture-probe-received");
    return;
  }
  if (data.kind === "fixture-release") {
    event("fixture-release-received", {
      sections: connection ? Atomics.load(new Int32Array(connection.sections), 0) : undefined,
    });
    section?.exit();
    section = undefined;
    event("fixture-released");
    return;
  }
  if (data.kind === "thread-service") {
    if ("__waffleCausal" in data && data.__waffleCausal instanceof SharedArrayBuffer)
      causal = new Int32Array(data.__waffleCausal);
    connection = data.filesystem;
    section = new FilesystemSection(connection);
    section.enter();
    event("fixture-held", { sections: connection.sections });
  }
  if (data.kind === "drain") {
    const command = threadServiceCommand(data);
    event("drain-command-started", { revoked: connection && isRevoked(connection) });
    event("fixture-draining", { revoked: connection && isRevoked(connection) });
    void command.then(() => event("drain-command-resolved"), failure).catch(failure);
    return;
  }
  void threadServiceCommand(data).catch(failure);
};
