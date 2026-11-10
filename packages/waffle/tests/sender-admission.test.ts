import { expect, spyOn, test } from "bun:test";
import { BrowserProcessBroker } from "../browser/process-broker.js";
import { DescriptorTable } from "../core/descriptors.js";
import {
  connectFilesystemIdentity,
  createFilesystemIdentity,
  reapFilesystem,
  revokeFilesystem,
  type FilesystemIdentity,
} from "../fs/protocol.js";
import type { ProcessAdmissionEvent } from "../proc/admission.js";
import { ProcessIdentityAllocator } from "../proc/identity.js";
import { claimOutcome, OutcomeCell, readOutcome } from "../proc/outcome.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { ProcessTable } from "../proc/table.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
  type WorkerProcessTransport,
} from "../proc/worker-client.js";
import { WorkerPipeHost } from "../proc/worker-pipes.js";
import { testReservations } from "./fixtures/shared-memory-platform.js";

type Delivery = "runtimeMessage" | "worker dispatch";
type Transition = "ordinary exit" | "revocation" | "signal";
type Timing = "before delivery" | "before outcome load" | "after outcome load";

class AdmissionWorker {
  static instances: AdmissionWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminations = 0;
  constructor() {
    AdmissionWorker.instances.push(this);
  }
  postMessage() {}
  terminate() {
    this.terminations++;
  }
  emit(data: WorkerProcessMessage) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

async function admissionFixture() {
  const previousWorker = globalThis.Worker;
  AdmissionWorker.instances = [];
  globalThis.Worker = AdmissionWorker as unknown as typeof Worker;
  const identities = new ProcessIdentityAllocator();
  const table = new ProcessTable(identities);
  const registry = new ExecutableRegistry();
  registry.register("fixture", {
    adapter: "fixture",
    module: new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
    interruptible: true,
  });
  const events: ProcessAdmissionEvent[] = [];
  const errors: unknown[] = [];
  const ports: MessagePort[] = [];
  const descriptors: DescriptorTable[] = [];
  const messages: WorkerProcessMessage[] = [];
  const filesystems = new Map<number, FilesystemIdentity>();
  const broker = new BrowserProcessBroker({
    reservations: testReservations(),
    identities,
    table,
    registry,
    onError: (error) => errors.push(error),
    onProcessAdmission(event) {
      events.push(event);
    },
    filesystem: {
      connect(identity) {
        const { client, server } = connectFilesystemIdentity(identity);
        ports.push(client.port, server.port);
        return client;
      },
      revoke: revokeFilesystem,
      reap: reapFilesystem,
      async quiesce() {},
    },
    launch: (context) =>
      broker.launchWorker(context, {
        workerUrl: "http://localhost/admission-fixture.js",
        request: { module: context.module, args: [], env: {} },
      }),
  });
  const dispose = async () => {
    try {
      for (const entry of descriptors) entry.dispose();
      await broker.dispose();
    } finally {
      for (const port of ports) port.close();
      globalThis.Worker = previousWorker;
    }
  };
  const clientFor = (transport: WorkerProcessTransport) => {
    const entry = new DescriptorTable();
    descriptors.push(entry);
    const postMessage = (message: WorkerProcessMessage) => {
      messages.push(message);
    };
    const host = new WorkerPipeHost({ transport, postMessage });
    return new WorkerProcessClient({
      transport,
      descriptors: entry,
      codec: host.codec(),
      postMessage,
      prepareSpawn(pid) {
        const filesystem = createFilesystemIdentity();
        filesystems.set(pid, filesystem);
        return { data: { filesystem } };
      },
    });
  };
  try {
    const root = createWorkerProcessTransport({
      pid: identities.pid(),
      job: identities.job(),
      identity: identities.buffer,
    });
    root.data = { filesystem: createFilesystemIdentity() };
    await broker.adoptRuntimeRoot(root, { memory: [] });
    const parent = clientFor(root);
    const senderPid = spawn(parent);
    await broker.runtimeMessage(takeSpawn(messages), parent.pid);
    const supervisor = await broker.ready();
    await supervisor.start(senderPid);
    const transport = broker.transportFor(senderPid)!;
    const sender = clientFor(transport);
    const filesystem = filesystems.get(senderPid)!;
    const pid = spawn(sender);
    const notice = takeSpawn(messages);
    events.length = 0;
    return { broker, supervisor, table, sender, filesystem, pid, notice, events, errors, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

function spawn(client: WorkerProcessClient): number {
  return client.spawn(client.pid, {
    executable: "fixture",
    argv: [],
    env: {},
    cwd: "/",
    job: -1,
    fds: [],
  });
}

function takeSpawn(messages: WorkerProcessMessage[]) {
  const message = messages.shift();
  if (message?.operation !== "spawn") throw new Error("missing spawn notice");
  return message;
}

async function checkAdmission(delivery: Delivery, transition: Transition, timing: Timing) {
  const fixture = await admissionFixture();
  const outcome = fixture.sender.signals.outcome;
  const change = () => {
    if (transition !== "revocation")
      claimOutcome(outcome, {
        kind: transition === "signal" ? "signaled" : "exited",
        code: transition === "signal" ? 9 : 0,
      });
    if (transition === "ordinary exit") reapFilesystem(fixture.filesystem);
    else revokeFilesystem(fixture.filesystem);
  };
  let dispatched: Promise<void> | undefined;
  const receive = fixture.broker.runtimeMessage.bind(fixture.broker);
  const dispatch = spyOn(fixture.broker, "runtimeMessage").mockImplementation((message, pid) => {
    dispatched = receive(message, pid);
    return dispatched;
  });
  let checks = 0;
  let armed = timing !== "before delivery";
  const originalCheck = OutcomeCell.prototype.check;
  // The second incarnation check follows the real atomic outcome load. Scheduling
  // claim/reap there exercises either read order without a filesystem getter seam.
  const guard = spyOn(OutcomeCell.prototype, "check").mockImplementation(function (
    this: OutcomeCell,
  ) {
    originalCheck.call(this);
    if (!armed || this.pid !== fixture.sender.pid) return;
    checks++;
    if (checks !== (timing === "before outcome load" ? 1 : 2)) return;
    armed = false;
    change();
  });
  try {
    if (timing === "before delivery") change();
    if (delivery === "runtimeMessage")
      await fixture.broker.runtimeMessage(fixture.notice, fixture.sender.pid);
    else {
      AdmissionWorker.instances[0]!.emit(fixture.notice);
      await dispatched;
    }
    guard.mockRestore();
    expect(armed).toBe(false);
    expect(readOutcome(outcome)?.kind).toBe(
      transition === "ordinary exit" ? "exited" : transition === "signal" ? "signaled" : undefined,
    );
    if (transition === "ordinary exit") {
      expect(fixture.events.map((event) => event.stage)).toEqual([
        "received",
        "queued",
        "reserved",
        "bound",
        "starting",
      ]);
      expect(fixture.supervisor.get(fixture.pid)?.parentPid).toBe(fixture.sender.pid);
      await fixture.supervisor.start(fixture.pid);
      expect(AdmissionWorker.instances).toHaveLength(2);
    } else {
      expect(fixture.events.map((event) => event.stage)).toEqual(["received", "rejected"]);
      expect(fixture.events[1]?.reason).toBe(
        transition === "signal" ? "sender-signaled" : "sender-revoked",
      );
      expect(fixture.supervisor.get(fixture.pid)).toBeUndefined();
      expect(AdmissionWorker.instances).toHaveLength(1);
    }
    expect(fixture.errors).toEqual([]);
  } finally {
    guard.mockRestore();
    dispatch.mockRestore();
    await fixture.dispose();
  }
  expect(Array.from(fixture.table.values())).toEqual([]);
  for (const worker of AdmissionWorker.instances) {
    expect(worker.terminations).toBe(1);
    expect(worker.onmessage).toBeNull();
    expect(worker.onerror).toBeNull();
  }
}

for (const delivery of ["runtimeMessage", "worker dispatch"] as const) {
  for (const timing of ["before delivery", "before outcome load", "after outcome load"] as const)
    test(`${delivery} admits a posted spawn when ordinary exit reaps ${timing}`, () =>
      checkAdmission(delivery, "ordinary exit", timing));
  test(`${delivery} rejects a posted spawn after genuine revocation`, () =>
    checkAdmission(delivery, "revocation", "before delivery"));
  for (const timing of ["before delivery", "before outcome load"] as const)
    test(`${delivery} rejects a posted spawn with a signal ${timing}`, () =>
      checkAdmission(delivery, "signal", timing));
}
