import { hostFilesystemClient } from "./fixtures/filesystem-host.js";
import { MemoryBackend } from "../fs/backend.js";
import { FilesystemService } from "../fs/service.js";
import { FilesystemClient } from "../fs/client.js";
import { createFilesystemConnection } from "../fs/protocol.js";
import {
  createNotificationBridge,
  type NotificationBridge,
} from "../browser/notification-relay.js";
import { createRing, RingWriter } from "../browser/net/ring.js";
import { Kind } from "../browser/net/protocol.js";
import { createWorkerProcessTransport, workerProcessState } from "../proc/worker-client.js";
import { PipeController, type PipeEndpoint } from "../proc/pipes.js";

export async function mixedNotificationCases(
  guestUrl: string,
  helperUrl: string,
): Promise<unknown> {
  const service = new FilesystemService(new MemoryBackend());
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const fs = hostFilesystemClient(service, pair);
  const bridge = createNotificationBridge(helperUrl);
  const guest = new Worker(guestUrl, { type: "module" });
  const transport = createWorkerProcessTransport({ capacity: 4 });
  const pipe = new PipeController({ capacity: 8, wake: workerProcessState(transport).wake });
  const reader = pipe.retain(1, "read");
  const writer = pipe.retain(2, "write");
  const ring = createRing();
  const network = new RingWriter(ring);
  const gate = new Int32Array(new SharedArrayBuffer(4));
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const timers: ReturnType<typeof setTimeout>[] = [];
  try {
    await fs.asyncCall("writeFile", ["/control", false], new Uint8Array([0]));
    const root = await fs.asyncCall("preopen", ["/"]);
    const path = await fs.asyncCall("resolve", [root, "control"]);
    fs.retain(path.node);
    const connection = fs.fork();
    const publish = sourcePublisher(fs, path.node, network, writer, bridge, timers);
    return await runGuest(
      guest,
      {
        filesystem: connection,
        notifications: bridge.connection,
        ring,
        process: transport,
        pipe: reader.handle(),
        gate,
      },
      publish,
      timers,
      (timer) => {
        deadline = timer;
      },
    );
  } finally {
    clearTimeout(deadline);
    for (const timer of timers) clearTimeout(timer);
    await bridge.dispose();
    await guest.terminate();
    network.dispose();
    reader.close();
    writer.close();
    pipe.dispose();
    fs.dispose();
    await service.shutdown();
  }
}

type MixedReply = { error: string; stack: string } | { done: true } | { stage: string };

function receive(
  data: MixedReply,
  publish: (stage: string) => Promise<void>,
  resolve: (value: unknown) => void,
  reject: (error: unknown) => void,
): void {
  if ("error" in data) {
    reject(Error(data.error + "\n" + data.stack));
    return;
  }
  if ("done" in data) {
    resolve(data);
    return;
  }
  void publish(data.stage).catch(reject);
}

async function publishStage(
  stage: string,
  publish: (stage: string) => Promise<void>,
  gate: Int32Array,
  timers: ReturnType<typeof setTimeout>[],
): Promise<void> {
  if (stage.endsWith("-parked")) {
    await new Promise<void>((resolve) => {
      timers.push(setTimeout(resolve, 35));
    });
    await publish(stage.replace("-parked", ""));
    return;
  }
  await publish(stage);
  if (stage === "deadline" || stage === "revoke") return;
  Atomics.store(gate, 0, 1);
  Atomics.notify(gate, 0);
}

function sourcePublisher(
  fs: FilesystemClient,
  node: Parameters<FilesystemClient["write"]>[0],
  network: RingWriter,
  writer: PipeEndpoint,
  bridge: NotificationBridge,
  timers: ReturnType<typeof setTimeout>[],
): (stage: string) => Promise<void> {
  return async (stage) => {
    if (stage === "fs-service")
      await fs.asyncCall("writeFile", ["/control", false], new Uint8Array([1]));
    if (stage === "fs-direct") fs.write(node, [new Uint8Array([2])], 0);
    if (stage === "network") await publishNetwork(network);
    if (stage === "process") writer.tryWrite([new Uint8Array([3])]);
    if (stage === "deadline") scheduleDeadlineNews(network, timers);
    if (stage === "revoke") await bridge.dispose();
  };
}

function scheduleDeadlineNews(network: RingWriter, timers: ReturnType<typeof setTimeout>[]): void {
  timers.push(
    setTimeout(() => {
      void network.write(1, Kind.Data, new Uint8Array([82]));
    }, 90),
  );
}

async function publishNetwork(network: RingWriter): Promise<void> {
  await network.write(1, Kind.Head, new Uint8Array([123, 125]));
  await network.write(1, Kind.Data, new Uint8Array([81]));
}

function runGuest(
  guest: Worker,
  request: import("./fixtures/notification-mixed-worker.js").MixedRequest,
  publishSource: (stage: string) => Promise<void>,
  timers: ReturnType<typeof setTimeout>[],
  setDeadline: (timer: ReturnType<typeof setTimeout>) => void,
): Promise<unknown> {
  const gate = request.gate;
  return new Promise((resolve, reject) => {
    setDeadline(setTimeout(() => reject(Error("mixed Worker proof timed out")), 10000));
    guest.onerror = (event) => reject(Error(event.message));
    guest.onmessage = ({ data }: MessageEvent<MixedReply>) =>
      receive(data, publish, resolve, reject);

    const publish = (stage: string) => publishStage(stage, publishSource, gate, timers);
    guest.postMessage(request, [request.filesystem.port, request.notifications.port]);
  });
}
