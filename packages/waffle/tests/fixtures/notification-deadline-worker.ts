import { FilesystemClient } from "../../fs/client.js";
import type { FilesystemConnection } from "../../fs/protocol.js";
import {
  NotificationWaitScope,
  type NotificationWaitSet,
} from "../../browser/notification-wait.js";
import type { NotificationConnection } from "../../browser/notification-relay.js";
import { NetHost } from "../../browser/net/host.js";

type Request =
  | {
      type: "init";
      filesystem: FilesystemConnection;
      ring: SharedArrayBuffer;
      connection: NotificationConnection;
      progress: Int32Array;
      mode: "deadline" | "replacement";
    }
  | { type: "deadline" };

let fs: FilesystemClient;
let network: NetHost;
let scope: NotificationWaitScope;
let waitSet: NotificationWaitSet;
let progress: Int32Array;

async function arm(connection: NotificationConnection): Promise<void> {
  scope = new NotificationWaitScope(connection, fs);
  waitSet = await scope.arm({ network });
  network.attachNotifications(waitSet, () => undefined);
  globalThis.postMessage({ type: "armed" });
}

function deadline(): void {
  const original = Date.now;
  let calls = 0;
  let first: number | undefined;
  const wait = waitSet.wait;
  const before = waitSet.sample();
  const deadlines = new Set<number>();
  const hangCap = performance.now() + 5000;
  waitSet.wait = (sample, limit) => {
    deadlines.add(limit);
    first ??= limit;
    calls++;
    Date.now = () => (calls % 2 ? -1e12 : 1e15);
    // Complete a real FS write after the readiness sample. Every wait races
    // unrelated news, including after the original operation deadline.
    const round = Atomics.load(progress, 1);
    waitForWrites(round);
    if (performance.now() >= hangCap)
      throw new Error("finite poll hung under irrelevant writes past its absolute deadline");
    return wait(sample, limit);
  };
  try {
    const start = performance.now();
    globalThis.postMessage({ type: "waiting" });
    if (network.poll(100) !== 0) throw new Error("irrelevant filesystem wake became readiness");
    const elapsed = performance.now() - start;
    if (deadlines.size !== 1 || first === undefined || performance.now() < first)
      throw new Error("finite operation changed or ignored its monotonic deadline");
    if (calls < 2 || waitSet.sample().filesystem === before.filesystem)
      throw new Error(
        `finite operation did not receive sustained irrelevant wakes: ${JSON.stringify({ calls, before, after: waitSet.sample(), elapsed })}`,
      );
    globalThis.postMessage({ type: "deadline", elapsed, calls, deadlines: deadlines.size });
  } finally {
    waitSet.wait = wait;
    Date.now = original;
  }
}

function waitForWrites(round: number): void {
  while (Atomics.load(progress, 1) <= round + 1) {
    const seen = Atomics.load(progress, 1);
    if (Atomics.wait(progress, 1, seen, 5000) === "timed-out")
      throw new Error("irrelevant write handshake missing");
  }
}

async function receive(request: Request): Promise<void> {
  if (request.type === "init") {
    fs = new FilesystemClient(request.filesystem);
    progress = request.progress;
    network = new NetHost(request.ring, () => {});
    if (network.fetch('{"url":"https://fairness.invalid"}') !== 1)
      throw new Error("network handle missing");
    await arm(request.connection);
    if (request.mode === "replacement") complete(request.connection);
    return;
  }
  if (request.type === "deadline") {
    deadline();
    scope.dispose();
    return;
  }
}

function complete(connection: NotificationConnection): void {
  globalThis.postMessage({ type: "replacement-waiting" });
  finalReadiness();
  if (Atomics.load(connection.state, 1)) throw new Error("stale scope closed replacement");
  scope.dispose();
  network.dispose();
  fs.dispose();
  globalThis.postMessage({ type: "complete" });
}

function finalReadiness(): void {
  const limit = performance.now() + 10_000;
  for (;;) {
    if (network.poll(Math.max(0, limit - performance.now())) !== 1)
      throw new Error("replacement poll lost final readiness");
    const payload = network.read(1, 1);
    if (payload instanceof Uint8Array && payload[0] === 81) return;
    if (performance.now() >= limit) throw new Error("replacement poll lost payload");
  }
}

globalThis.onmessage = ({ data }: MessageEvent<Request>) => {
  void receive(data).catch((error: unknown) =>
    globalThis.postMessage({ type: "error", message: String(error) }),
  );
};

globalThis.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
  globalThis.postMessage({ type: "error", message: String(event.reason) });
});
