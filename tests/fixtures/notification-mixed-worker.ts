import {
  NotificationWaitScope,
  type NotificationWaitSet,
} from "../../browser/notification-wait.js";
import type { NotificationConnection } from "../../browser/notification-relay.js";
import { FilesystemClient } from "../../fs/client.js";
import type { FilesystemConnection } from "../../fs/protocol.js";
import { NetHost } from "../../browser/net/host.js";
import { ProcessABI } from "../../proc/abi.js";
import { DescriptorTable } from "../../core/descriptors.js";
import { attachPipeEndpoint, type PipeEndpointHandle } from "../../proc/pipes.js";
import { WorkerProcessClient, type WorkerProcessTransport } from "../../proc/worker-client.js";

export interface MixedRequest {
  filesystem: FilesystemConnection;
  notifications: NotificationConnection;
  ring: SharedArrayBuffer;
  process: WorkerProcessTransport;
  pipe: PipeEndpointHandle;
  gate: Int32Array;
}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function waitForSource(
  set: NotificationWaitSet,
  source: "filesystem" | "network" | "process",
  gate: Int32Array,
  stage: string,
) {
  const before = set.sample();
  const deadline = performance.now() + 1500;
  globalThis.postMessage({ stage });
  Atomics.wait(gate, 0, 0, 1500);
  Atomics.store(gate, 0, 0);
  check(
    set.wait(before, deadline) === "not-equal",
    `${stage} publication racing the readiness scan was lost`,
  );
  const after = set.sample();
  check(before[source] !== after[source], `${stage} did not publish its real source`);
  if (source !== "filesystem") check(before.filesystem === after.filesystem, `${stage} changed FS`);
  return { stage, before, after };
}

function waitParked(
  set: NotificationWaitSet,
  source: "filesystem" | "network" | "process",
  stage: string,
) {
  const before = set.sample();
  const start = performance.now();
  const deadline = start + 1500;
  let current = before;
  let turns = 0;
  globalThis.postMessage({ stage: `${stage}-parked` });
  while (current[source] === before[source]) {
    check(set.wait(current, deadline) !== "timed-out", `${stage} did not wake parked Worker`);
    current = set.sample();
    check(++turns < 8, `${stage} repeatedly rescanned`);
  }
  check(performance.now() - start >= 20, `${stage} was not parked before publication`);
  return { stage: `${stage}-parked`, before, after: current, turns };
}

async function run(request: MixedRequest): Promise<void> {
  const fs = new FilesystemClient(request.filesystem);
  const descriptors = new DescriptorTable();
  const network = new NetHost(request.ring, () => {});
  const scope = new NotificationWaitScope(request.notifications, fs);
  let watch: number | undefined;
  try {
    const root = await fs.asyncCall("preopen", ["/"]);
    watch = await fs.asyncCall("watchOpen", [root, true]);
    const service = new WorkerProcessClient({
      transport: request.process,
      descriptors,
      codec: {
        export() {
          throw Error("unused");
        },
        import() {
          throw Error("unused");
        },
        discard() {},
      },
      postMessage() {},
    });
    const reader = attachPipeEndpoint(request.pipe);
    const fd = descriptors.open(reader, (1n << 29n) - 1n, (1n << 29n) - 1n);
    const process = new ProcessABI({
      memory: new WebAssembly.Memory({ initial: 1 }),
      descriptors,
      fs,
      pid: service.pid,
      service,
      signals: service.signals,
      wake: service.wake,
    });
    const set = await scope.arm({ network, process, subscriptions: [{ kind: 0, id: fd }] });
    check(set.covered, "common pipe must be covered");
    fs.call("watchRead", [watch]);
    const reports: unknown[] = [];
    reports.push(waitForSource(set, "filesystem", request.gate, "fs-service"));
    reports.push(waitParked(set, "filesystem", "fs-service"));
    check(fs.call("watchRead", [watch]).events.length > 0, "service watch batch missing");
    reports.push(waitForSource(set, "filesystem", request.gate, "fs-direct"));
    reports.push(waitParked(set, "filesystem", "fs-direct"));
    check(fs.call("watchRead", [watch]).events.length > 0, "direct watch batch missing");
    const handle = network.fetch('{"url":"https://example.invalid"}');
    reports.push(waitForSource(set, "network", request.gate, "network"));
    reports.push(waitParked(set, "network", "network"));
    check(network.poll(0) === 1, "network poll did not preserve GEN news");
    const payload = network.read(handle, 8);
    check(payload instanceof Uint8Array && payload[0] === 81, "network drain lost payload");
    reports.push(waitForSource(set, "process", request.gate, "process"));
    reports.push(waitParked(set, "process", "process"));
    check(reader.tryRead([new Uint8Array(1)]) === 1, "process pipe data missing");
    const localBefore = set.sample();
    const listener = network.listen("127.0.0.1", 49223);
    const client = network.connect("127.0.0.1", 49223);
    check(client > 0, "local connect failed");
    check(
      set.wait(localBefore, Infinity) === "not-equal",
      "localNews did not synchronously forward",
    );
    check(localBefore.network === set.sample().network, "localNews altered helper GEN");
    check(network.poll(0) === 1, "localNews was consumed by forwarding");
    network.close(client);
    network.close(listener);
    network.poll(0);
    set.setProcessSubscriptions([{ kind: 6, id: 1 }]);
    check(!set.covered, "CHILD_START must remain uncovered");
    const fallbackStart = performance.now();
    set.wait(set.sample(), Infinity);
    check(performance.now() - fallbackStart < 250, "uncovered fallback parked indefinitely");
    set.setProcessSubscriptions([{ kind: 0, id: fd }]);
    const deadline = performance.now() + 140;
    let sample = set.sample();
    globalThis.postMessage({ stage: "deadline" });
    let turns = 0;
    while (performance.now() < deadline) {
      set.wait(sample, deadline);
      network.poll(0);
      sample = set.sample();
      turns++;
    }
    check(performance.now() - deadline < 60, "absolute deadline restarted after an early wake");
    check(turns < 8, "quiet wait repeatedly rescanned");
    const quiet = set.sample();
    const start = performance.now();
    check(set.wait(quiet, start + 70) === "timed-out", "quiet wait did not expire");
    check(performance.now() >= start + 60, "quiet wait returned early");
    const beforeRevoke = set.sample();
    globalThis.postMessage({ stage: "revoke", reports, turns });
    check(
      set.wait(beforeRevoke, Infinity) === "closed",
      "external revoke did not wake blocked guest",
    );
    globalThis.postMessage({ done: true, reports, turns });
  } finally {
    scope.dispose();
    network.dispose();
    descriptors.dispose();
    if (watch !== undefined) await fs.asyncCall("watchClose", [watch]);
    fs.dispose();
  }
}

globalThis.onmessage = ({ data }: MessageEvent<MixedRequest>) => {
  void run(data).catch((error) =>
    globalThis.postMessage({ error: String(error), stack: error.stack }),
  );
};
