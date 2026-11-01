import { threadServiceCommand } from "../thread/service-worker.ts";
import { FilesystemSection, isRevoked, type FilesystemConnection } from "../fs/protocol.ts";
import { closeRequestMemory } from "../fs/request-memory.ts";
import { createSharedControlAllocator, consumedControlBytes } from "../memory/control.ts";
import type { ThreadServiceCommand } from "../thread/runtime-protocol.ts";

let connection: FilesystemConnection;
let section: FilesystemSection | undefined;
let selected: string;
function release(): void {
  section?.exit();
  section = undefined;
  self.postMessage({ kind: "fixture-released" });
}
function exhaustGrant(request: Extract<ThreadServiceCommand, { kind: "thread-service" }>): void {
  if (request.controlGrant.kind !== "bounded") throw new Error("expected an issued bounded grant");
  const allocate = createSharedControlAllocator(request.controlGrant, (buffer) =>
    self.postMessage({ kind: "control-allocation", buffer }),
  );
  const remaining = request.controlGrant.limit - consumedControlBytes(request.controlGrant);
  allocate(remaining);
  self.postMessage({
    kind: "fixture-grant-full",
    consumed: consumedControlBytes(request.controlGrant),
  });
  allocate(1);
  throw new Error("exhausted control grant accepted another allocation");
}
async function command(data: ThreadServiceCommand & { fixture?: string }): Promise<void> {
  if (data.kind === "thread-service") {
    connection = data.filesystem;
    selected = data.fixture ?? "";
    section = new FilesystemSection(connection);
    section.enter();
    self.postMessage({ kind: "fixture-held" });
    if (selected === "control-exhaustion") exhaustGrant(data);
  }
  if (data.kind === "drain") {
    self.postMessage({ kind: "fixture-drain-started", revoked: isRevoked(connection) });
    if (selected === "drain-failure") closeRequestMemory(connection.requests, "protocol");
  }
  await threadServiceCommand(data);
  if (data.kind === "drain") self.postMessage({ kind: "fixture-drain-completed" });
}
self.onmessage = ({
  data,
}: MessageEvent<
  ThreadServiceCommand | { kind: "fixture-release" } | { kind: "fixture-probe" }
>) => {
  if (data.kind === "fixture-release") return release();
  if (data.kind === "fixture-probe") return self.postMessage({ kind: "fixture-probed" });
  void command(data).catch((error: unknown) => {
    self.postMessage({ kind: "fixture-failure", error: String(error) });
    self.postMessage({ kind: "service-error", message: String(error) });
  });
};
