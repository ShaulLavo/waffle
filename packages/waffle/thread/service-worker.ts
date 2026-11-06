import { Wasi } from "../core/wasi.js";
import { FilesystemClient } from "../fs/client.js";
import { createFilesystemDescriptorCodec } from "../proc/filesystem-codec.js";
import { createWorkerPipeCodec } from "../proc/worker-pipes.js";
import { WorkerProcessClient } from "../proc/worker-client.js";
import { createSharedControlAllocator, installSharedControlAllocator } from "../memory/control.js";
import { ThreadService } from "./service.js";
import type {
  ThreadServiceCommand,
  ThreadServiceEvent,
  ThreadServiceRequest,
} from "./runtime-protocol.js";

let state:
  | {
      service: ThreadService;
      wasi: Wasi;
      fs: FilesystemClient;
      process: WorkerProcessClient;
      restore(): void;
    }
  | undefined;
function send(event: ThreadServiceEvent): void {
  self.postMessage(event);
}
function initialize(request: ThreadServiceRequest): void {
  if (state) throw new Error("thread service already initialized");
  const allocate = createSharedControlAllocator(request.controlGrant, (buffer) =>
    send({ kind: "control-allocation", buffer }),
  );
  const restore = installSharedControlAllocator(allocate);
  const fs = new FilesystemClient(request.filesystem);
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens: {},
    stdio: { 0: null, 1: null, 2: null },
    stdout() {},
    stderr() {},
    sleep() {
      throw new Error("thread service cannot block");
    },
  });
  const service = new ThreadService({
    directory: request.directory,
    pid: request.pid,
    memory: request.memory,
    filesystem: fs,
    descriptors: wasi.descriptors,
  });
  state = {
    service,
    wasi,
    fs,
    restore,
    process: new WorkerProcessClient({
      transport: request.transport,
      descriptors: wasi.descriptors,
      codec: createWorkerPipeCodec({
        fallback: createFilesystemDescriptorCodec(fs),
        allocateShared: allocate,
      }),
      postMessage() {
        throw new Error("process imports are outside the first thread profile");
      },
    }),
  };
  state.process.installBindings();
  send({ kind: "service-ready" });
}
export async function threadServiceCommand(message: ThreadServiceCommand): Promise<void> {
  if (message.kind === "thread-service") return initialize(message);
  if (!state) throw new Error("thread service is not initialized");
  const { service, wasi, fs } = state;
  if (message.kind === "call") {
    const result = await service.submit(message.call, message.request);
    send({ kind: "result", id: message.id, result });
    return;
  }
  service.cancelAll();
  await service.drain();
  if (message.kind === "drain") return send({ kind: "drained", id: message.id });
  const receipt = await service.quiesce();
  service.disposeCanonical(receipt, wasi);
  fs.dispose();
  state.restore();
  state = undefined;
  send({ kind: "disposed", id: message.id });
}
self.onmessage = ({ data }: MessageEvent<ThreadServiceCommand>) => {
  void threadServiceCommand(data).catch((error: unknown) =>
    send({ kind: "service-error", message: String(error) }),
  );
};
