import { FilesystemClient } from "../fs/client.ts";
import { isRevoked, type FilesystemConnection } from "../fs/protocol.ts";
import { threadServiceCommand } from "../thread/service-worker.ts";
import type { ThreadServiceCommand } from "../thread/runtime-protocol.ts";

const delivered = Promise.withResolvers<void>();
const drain = Promise.withResolvers<void>();
let memory: WebAssembly.Memory;
let connection: FilesystemConnection;
const submit = FilesystemClient.prototype.submit;
FilesystemClient.prototype.submit = function (name, args, data) {
  const completion = submit.call(this, name, args, data);
  if (name !== "read") return completion;
  const read = completion.value.bind(completion);
  completion.value = async () => {
    const result = await read();
    self.postMessage({ kind: "fixture-read-completed" });
    await delivered.promise;
    return result;
  };
  return completion;
};
async function command(data: ThreadServiceCommand) {
  if (data.kind === "thread-service") {
    memory = data.memory;
    connection = data.filesystem;
  }
  if (data.kind === "drain") {
    self.postMessage({ kind: "fixture-drain-requested", revoked: isRevoked(connection) });
    await drain.promise;
  }
  await threadServiceCommand(data);
  if (data.kind === "call")
    self.postMessage({ kind: "fixture-read-published", byte: new Uint8Array(memory.buffer)[256] });
}
self.onmessage = ({
  data,
}: MessageEvent<
  ThreadServiceCommand | { kind: "fixture-release-read" } | { kind: "fixture-release-drain" }
>) => {
  if (data.kind === "fixture-release-read") return delivered.resolve();
  if (data.kind === "fixture-release-drain") return drain.resolve();
  void command(data).catch((error: unknown) =>
    self.postMessage({ kind: "service-error", message: String(error) }),
  );
};
