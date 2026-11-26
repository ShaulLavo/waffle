import { FilesystemService } from "../fs/service.js";
import { MemoryBackend } from "../fs/backend.js";
import { createFilesystemConnection } from "../fs/protocol.js";
import { hostFilesystemClient } from "../testing/fixtures/filesystem-host.js";
import { PipeController } from "../proc/pipes.js";
import { createRing, RingReader, RingWriter } from "../browser/net/ring.js";
import { Kind } from "../browser/net/protocol.js";
import { createNotificationBridge } from "../browser/notification-relay.js";
import type { TrafficRequest } from "./fixtures/notification-traffic-worker.js";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

class Notices {
  private events = new Map<string, Record<string, unknown>[]>();
  private pending = new Map<string, (data: Record<string, unknown>) => void>();
  private reject = new Map<string, (error: Error) => void>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private failure: Error | undefined;
  private history: string[] = [];
  constructor(worker: Worker) {
    worker.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (typeof data === "string") this.accept({ type: data });
      else if (data && typeof data === "object") this.accept(data);
    };
    worker.onerror = (event) => this.accept({ type: "error", message: event.message });
  }
  accept(data: object): void {
    if (!("type" in data) || typeof data.type !== "string") return;
    this.history.push(data.type);
    if (data.type === "error") {
      this.failure = new Error("message" in data ? String(data.message) : "Worker failed");
      for (const reject of this.reject.values()) reject(this.failure);
      this.close();
      return;
    }
    const notice = { ...data };
    const pending = this.pending.get(data.type);
    if (pending) pending(notice);
    else this.events.set(data.type, (this.events.get(data.type) ?? []).concat([notice]));
  }
  wait(type: string): Promise<Record<string, unknown>> {
    if (this.failure) return Promise.reject(this.failure);
    const queued = this.events.get(type)?.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(type);
        this.reject.delete(type);
        this.timers.delete(timer);
        reject(
          new Error(
            `notification fairness handshake ${type} timed out; received ${this.history.join(", ")}`,
          ),
        );
      }, 10_000);
      this.timers.add(timer);
      this.reject.set(type, reject);
      this.pending.set(type, (data) => {
        clearTimeout(timer);
        this.timers.delete(timer);
        this.pending.delete(type);
        this.reject.delete(type);
        resolve(data);
      });
    });
  }
  close(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
    this.reject.clear();
  }
}

async function withTraffic<T>(
  urls: FairnessUrls,
  mode: TrafficRequest["mode"],
  run: (resources: TrafficResources) => Promise<T>,
): Promise<T> {
  const service = new FilesystemService(new MemoryBackend());
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const fs = hostFilesystemClient(service, pair);
  const wake = new Int32Array(new SharedArrayBuffer(4));
  const pipe = new PipeController({ capacity: 8, wake });
  const reader = pipe.retain(1, "read");
  const writer = pipe.retain(2, "write");
  const ring = createRing();
  const progress = new Int32Array(new SharedArrayBuffer(12));
  const producer = new Worker(urls.traffic, { type: "module" });
  const notices = new Notices(producer);
  let watch: number | undefined;
  let stopped = false;
  const stop = async () => {
    Atomics.store(progress, 0, 1);
    Atomics.store(progress, 2, 1);
    Atomics.notify(progress, 2);
    if (stopped) return;
    await notices.wait("stopped");
    stopped = true;
  };
  try {
    await fs.asyncCall("writeFile", ["/traffic", false], new Uint8Array([0]));
    const root = await fs.asyncCall("preopen", ["/"]);
    watch = await fs.asyncCall("watchOpen", [root, true]);
    const connection = fs.fork();
    producer.postMessage(
      {
        filesystem: connection,
        pipe: { reader: reader.handle(), writer: writer.handle() },
        ring,
        progress,
        mode,
      } satisfies TrafficRequest,
      [connection.port],
    );
    await notices.wait("ready");
    const start = async () => {
      Atomics.store(progress, 2, 1);
      Atomics.notify(progress, 2);
      await notices.wait("running");
    };
    return await run({ fs, ring, wake, progress, start, stop });
  } finally {
    try {
      await stop();
    } finally {
      await producer.terminate();
      notices.close();
      reader.close();
      writer.close();
      pipe.dispose();
      if (watch !== undefined) await fs.asyncCall("watchClose", [watch]);
      fs.dispose();
      await service.shutdown();
    }
  }
}

interface FairnessUrls {
  traffic: string;
  probe: string;
  helper: string;
  guest: string;
}
interface TrafficResources {
  fs: ReturnType<typeof hostFilesystemClient>;
  ring: SharedArrayBuffer;
  wake: Int32Array;
  progress: Int32Array;
  start(): Promise<void>;
  stop(): Promise<void>;
}

async function relayFairness(urls: FairnessUrls, mode: "queued" | "empty") {
  return withTraffic(urls, mode, (resources) => relayTraffic(urls, mode, resources));
}

async function relayTraffic(
  urls: FairnessUrls,
  mode: "queued" | "empty",
  { fs, ring, wake, progress, start, stop }: TrafficResources,
) {
  const worker = new Worker(urls.probe, { type: "module" });
  const notices = new Notices(worker);
  const channel = new MessageChannel();
  const state = new Int32Array(new SharedArrayBuffer(8));
  try {
    channel.port2.onmessage = ({ data }) => notices.accept(data);
    worker.postMessage({ id: 1, port: channel.port1, state }, [channel.port1]);
    channel.port2.postMessage({
      type: "arm",
      words: [
        { cells: fs.shared.watch.cells, index: 3 },
        { cells: new RingReader(ring).notification, index: 0 },
        { cells: wake, index: 0 },
      ],
    });
    await notices.wait("armed");
    const sources = [fs.shared.watch.cells, new RingReader(ring).notification, wake];
    const values = () => sources.map((cells, index) => Atomics.load(cells, index === 0 ? 3 : 0));
    // A blocked guest parks on the values it observed and parks again after every wake.
    const guest = reparkingGuest(state, () =>
      channel.port2.postMessage({ type: "park", values: values() }),
    );
    // The park and the probe travel on different channels: probe until the park has landed.
    let before = await probe(worker, notices, "idle-before");
    for (let attempt = 0; attempt < 100 && before.registrations !== 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      before = await probe(worker, notices, "idle-before");
    }
    worker.postMessage({ probe: "timer" });
    await notices.wait("entered");
    const quiet = await notices.wait("timer");
    check(
      before.registrations === 3 && quiet.registrations === 3,
      "idle relay rearmed without source news",
    );
    check(quiet.timers === 0 && Atomics.load(state, 0) === 0, "idle relay polled or published");
    const initialSources = values();
    await start();
    const initial = Atomics.load(progress, 1);
    const sequence = Atomics.load(state, 0);
    worker.postMessage({ probe: "timer" });
    await notices.wait("entered");
    worker.postMessage({ probe: "control" });
    const controlStart = performance.now();
    const control = await notices.wait("control");
    const controlMs = performance.now() - controlStart;
    const timer = await notices.wait("timer");
    check(Atomics.load(progress, 1) > initial, "traffic did not remain active during probes");
    check(Atomics.load(state, 0) !== sequence, "actual relay did not forward sustained traffic");
    check(
      sources.every(
        (cells, index) => Atomics.load(cells, index === 0 ? 3 : 0) !== initialSources[index],
      ),
      "traffic missed a real source",
    );
    check(
      Array.isArray(timer.sources) &&
        timer.sources.length === 3 &&
        timer.sources.every((count: unknown) => typeof count === "number" && count > 1),
      "relay did not rearm every real source during traffic",
    );
    Atomics.store(state, 1, 1);
    Atomics.add(state, 0, 1);
    Atomics.notify(state, 0);
    await guest.stopped;
    channel.port2.postMessage({ type: "dispose" });
    const disposeStart = performance.now();
    await notices.wait("disposed");
    const disposeMs = performance.now() - disposeStart;
    const disposed = Atomics.load(state, 0);
    worker.postMessage({ probe: "after-dispose" });
    await notices.wait("after-dispose");
    await stop();
    check(Atomics.load(state, 0) === disposed, "stale relay completion published after disposal");
    return {
      mode,
      rounds: Atomics.load(progress, 1),
      publications: disposed,
      control,
      controlMs,
      disposeMs,
      timer,
      idle: quiet,
    };
  } finally {
    Atomics.store(state, 1, 1);
    channel.port1.close();
    channel.port2.close();
    await worker.terminate();
    notices.close();
  }
}

function probe(worker: Worker, notices: Notices, name: string) {
  worker.postMessage({ probe: name });
  return notices.wait(name);
}

/** Parks once, then again after each publication, until the fence closes. */
function reparkingGuest(state: Int32Array, park: () => void) {
  const loop = async () => {
    while (!Atomics.load(state, 1)) {
      const sequence = Atomics.load(state, 0);
      park();
      // Timed, because this page loop is not the relay under test and WebKit can lose
      // untimed async wakes; a repeated park on unchanged values registers nothing new.
      const waiting = Atomics.waitAsync(state, 0, sequence, 50);
      if (waiting.async) await waiting.value;
    }
  };
  return { stopped: loop() };
}

async function deadlineFairness(urls: FairnessUrls) {
  return withTraffic(urls, "filesystem", (resources) => deadlineTraffic(urls, resources));
}

async function deadlineTraffic(
  urls: FairnessUrls,
  { fs, ring, progress, start, stop }: TrafficResources,
) {
  const guest = new Worker(urls.guest, { type: "module" });
  const notices = new Notices(guest);
  let later: Worker | undefined;
  let laterNotices: Notices | undefined;
  const bridge = createNotificationBridge(urls.helper);
  const replacement = createNotificationBridge(urls.helper);
  const network = new RingWriter(ring);
  try {
    const connection = fs.fork();
    guest.postMessage(
      {
        type: "init",
        mode: "deadline",
        filesystem: connection,
        ring,
        progress,
        connection: bridge.connection,
      },
      [connection.port, bridge.connection.port],
    );
    await notices.wait("armed");
    await start();
    guest.postMessage({ type: "deadline" });
    await notices.wait("waiting");
    const deadline = await notices.wait("deadline");
    await stop();
    await bridge.dispose();
    await guest.terminate();
    notices.close();
    later = new Worker(urls.guest, { type: "module" });
    laterNotices = new Notices(later);
    const next = fs.fork();
    later.postMessage(
      {
        type: "init",
        mode: "replacement",
        filesystem: next,
        ring,
        progress,
        connection: replacement.connection,
      },
      [next.port, replacement.connection.port],
    );
    await laterNotices.wait("armed");
    await laterNotices.wait("replacement-waiting");
    // A late completion/cancel from the old scope must not close the new one.
    Atomics.add(bridge.connection.state, 0, 1);
    Atomics.notify(bridge.connection.state, 0);
    await bridge.dispose();
    await network.write(1, Kind.Head, new Uint8Array([123, 125]));
    await network.write(1, Kind.Data, new Uint8Array([81]));
    await laterNotices.wait("complete");
    return { deadline, rounds: Atomics.load(progress, 1), replacement: true };
  } finally {
    await bridge.dispose();
    await replacement.dispose();
    await guest.terminate();
    await later?.terminate();
    notices.close();
    laterNotices?.close();
    network.dispose();
  }
}

/** @browserEntry Loaded by the bounded notification browser runner. */
export async function notificationFairnessCases(urls: FairnessUrls) {
  const queued = await relayFairness(urls, "queued");
  const empty = await relayFairness(urls, "empty");
  const deadline = await deadlineFairness(urls);
  return { queued, empty, deadline };
}
