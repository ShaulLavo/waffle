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
  deadlineNews: "timer" | "held" = "timer",
  networkNews: "together" | "head-first" = "together",
): Promise<unknown> {
  const idle = await mixedNotificationCase(guestUrl, helperUrl, "idle", deadlineNews, networkNews);
  const sources = await mixedNotificationCase(
    guestUrl,
    helperUrl,
    "sources",
    deadlineNews,
    networkNews,
  );
  return { done: true, idle, sources };
}

async function mixedNotificationCase(
  guestUrl: string,
  helperUrl: string,
  phase: "idle" | "sources",
  deadlineNews: "timer" | "held",
  networkNews: "together" | "head-first",
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
    const publish = sourcePublisher(
      fs,
      path.node,
      network,
      writer,
      bridge,
      timers,
      deadlineNews,
      networkNews,
    );
    return await runGuest(
      guest,
      {
        phase,
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

type MixedStage = string | { deadline: number };

type MixedReply = { error: string; stack: string } | { done: true } | { stage: MixedStage };

function receive(
  data: MixedReply,
  publish: (stage: MixedStage) => Promise<void>,
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
  stage: MixedStage,
  publish: (stage: MixedStage) => Promise<void>,
  gate: Int32Array,
  timers: ReturnType<typeof setTimeout>[],
): Promise<void> {
  if (typeof stage !== "string") {
    await publish(stage);
    return;
  }
  if (stage.endsWith("-parked")) {
    await new Promise<void>((resolve) => {
      timers.push(setTimeout(resolve, 35));
    });
    await publish(stage);
    return;
  }
  await publish(stage);
  if (stage === "revoke") return;
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
  deadlineNews: "timer" | "held",
  networkNews: "together" | "head-first",
): (stage: MixedStage) => Promise<void> {
  let completeDeadline: (() => Promise<void>) | undefined;
  return async (stage) => {
    if (typeof stage !== "string") {
      completeDeadline = deadlinePublisher(network, timers, deadlineNews, stage.deadline);
      return;
    }
    const source = stage.replace("-parked", "");
    if (source === "fs-service")
      await fs.asyncCall("writeFile", ["/control", false], new Uint8Array([1]));
    if (source === "fs-direct") fs.write(node, [new Uint8Array([2])], 0);
    if (source === "network") {
      if (stage === "network-parked" && networkNews === "head-first")
        await network.write(1, Kind.Head, new Uint8Array([123, 125]));
      else await publishNetwork(network, 1, 81);
    }
    // The process stage follows the guest's first network read.
    if (stage === "process" && networkNews === "head-first")
      await network.write(1, Kind.Data, new Uint8Array([81]));
    if (source === "process") writer.tryWrite([new Uint8Array([3])]);
    if (stage === "deadline-complete") await completeDeadline?.();
    if (stage === "revoke") await bridge.dispose();
  };
}

function deadlinePublisher(
  network: RingWriter,
  timers: ReturnType<typeof setTimeout>[],
  mode: "timer" | "held",
  handle: number,
): () => Promise<void> {
  const publish = () => publishNetwork(network, handle, 82);
  if (mode === "held") return publish;
  const pending = new Promise<void>((resolve, reject) => {
    timers.push(setTimeout(() => void publish().then(resolve, reject), 90));
  });
  return () => pending;
}

async function publishNetwork(network: RingWriter, handle: number, byte: number): Promise<void> {
  await network.write(handle, Kind.Head, new Uint8Array([123, 125]));
  await network.write(handle, Kind.Data, new Uint8Array([byte]));
}

function runGuest(
  guest: Worker,
  request: import("./fixtures/notification-mixed-worker.js").MixedRequest,
  publishSource: (stage: MixedStage) => Promise<void>,
  timers: ReturnType<typeof setTimeout>[],
  setDeadline: (timer: ReturnType<typeof setTimeout>) => void,
): Promise<unknown> {
  const gate = request.gate;
  return new Promise((resolve, reject) => {
    setDeadline(setTimeout(() => reject(Error("mixed Worker proof timed out")), 10000));
    guest.onerror = (event) => reject(Error(event.message));
    guest.onmessage = ({ data }: MessageEvent<MixedReply>) =>
      receive(data, publish, resolve, reject);

    const publish = (stage: MixedStage) => publishStage(stage, publishSource, gate, timers);
    guest.postMessage(request, [request.filesystem.port, request.notifications.port]);
  });
}
