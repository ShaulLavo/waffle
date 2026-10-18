import type { StartupDiagnosticRequest } from "./fixtures/startup-diagnostic-request.js";
import { BrowserProcessBroker } from "../browser/process-broker.js";
import { DescriptorTable } from "../core/descriptors.js";
import { connectFilesystemIdentity, createFilesystemIdentity } from "../fs/protocol.js";
import { ProcessIdentityAllocator } from "../proc/identity.js";
import { PipeController } from "../proc/pipes.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { ProcessTable } from "../proc/table.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessMessage,
} from "../proc/worker-client.js";
import { createWorkerPipeCodec } from "../proc/worker-pipes.js";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export async function browserStartupDiagnostic(
  workerUrl = "/startup-diagnostic-worker.js",
  mode: "drain" | "stalled" | "closed" | "dispose" | "normal" = "drain",
  legacy = false,
): Promise<void> {
  const module = new WebAssembly.Module(
    new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 7, 19, 2, 6, 109,
      101, 109, 111, 114, 121, 2, 0, 6, 95, 115, 116, 97, 114, 116, 0, 0, 10, 4, 1, 2, 0, 11,
    ]),
  );
  const identities = new ProcessIdentityAllocator(),
    table = new ProcessTable(identities),
    registry = new ExecutableRegistry();
  registry.register("fixture", { module, adapter: "fixture" });
  const pipe = new PipeController({ capacity: 64, maxReaders: 2, maxWriters: 2, relay: "manual" });
  const ports: MessagePort[] = [],
    errors: unknown[] = [],
    notices: WorkerProcessMessage[] = [];
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const diagnostic = "startup diagnostic " + "λ".repeat(8192);
  let ready!: () => void,
    reject!: (error: unknown) => void,
    closed = 0,
    duplicate = false;
  const pending = new Promise<void>((resolve, fail) => {
    ready = resolve;
    reject = fail;
  });
  const timer = setTimeout(() => reject(new Error("startup diagnostic worker timeout")), 10_000);
  const broker = new BrowserProcessBroker({
    identities,
    table,
    registry,
    onError: (error) => errors.push(error),
    filesystem: {
      connect(identity) {
        const pair = connectFilesystemIdentity(identity);
        ports.push(pair.client.port, pair.server.port);
        return pair.client;
      },
      revoke() {},
      reap() {},
      async quiesce() {},
    },
    launch(context) {
      const writer = context.descriptors.get(2)!.resource;
      assert(writer.kind === "pipe", "inherited stderr must be the transferred pipe");
      const close = writer.close!.bind(writer);
      writer.close = () => {
        closed++;
        close();
      };
      return broker.launchWorker<StartupDiagnosticRequest>(context, {
        workerUrl,
        request: {
          module,
          args: [],
          env: {},
          diagnostic,
          diagnosticGate: gate.buffer,
          legacy,
          normal: mode === "normal",
        },
        onMessage(message) {
          if (typeof message !== "object" || message === null || !("type" in message)) return;
          if (
            message.type === "startup-diagnostic-pending" ||
            message.type === "startup-stderr-closed"
          )
            ready();
          if (message.type === "legacy-startup-diagnostic") duplicate = true;
        },
      });
    },
  });
  const root = createWorkerProcessTransport({
    pid: identities.pid(),
    job: identities.job(),
    identity: identities.buffer,
  });
  root.data = { filesystem: createFilesystemIdentity() };
  const descriptors = new DescriptorTable();
  const codec = createWorkerPipeCodec();
  descriptors.openAt(2, pipe.retain(root.pid, "write"), 1n << 6n, 0n);
  const parent = new WorkerProcessClient({
    transport: root,
    descriptors,
    codec,
    postMessage(message) {
      notices.push(message);
    },
    prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity() } }),
  });
  const reader = pipe.retain(parent.pid, "read");
  try {
    await broker.adoptRuntimeRoot(root);
    const pid = parent.spawn(parent.pid, {
      executable: "fixture",
      argv: [],
      env: {},
      cwd: "/",
      job: -1,
      fds: [{ parent: 2, child: 2 }],
    });
    descriptors.close(2);
    for (const notice of notices) await broker.runtimeMessage(notice, parent.pid);
    const supervisor = await broker.ready();
    supervisor.onChildExit((event) => {
      if (event.pid === pid) ready();
    });
    await supervisor.start(pid);
    await pending;
    if (mode === "normal") {
      assert(supervisor.startStatus(parent.pid, pid) === 0, "normal child must have entered");
      assert(
        supervisor.wait(parent.pid, pid) === null,
        "child must still be running while stderr closes",
      );
      assert(
        reader.tryRead([new Uint8Array(1)]) === 0,
        "diagnostic-only writer delayed normal stderr EOF",
      );
      Atomics.store(gate, 0, 1);
      const result = await supervisor.waitForExit(parent.pid, pid);
      assert(result.kind === "exited" && result.code === 0, "normal child did not exit normally");
      assert(closed === 1 && errors.length === 0, "normal stderr cleanup reported an error");
      return;
    }
    // A worker-selected outcome alone must not release inherited stderr before the ordered
    // error acknowledgement. Its eventual diagnostic belongs solely to the host, not fd 2.
    supervisor.exit(pid, 126);
    assert(supervisor.startStatus(parent.pid, pid) > 0, "worker must have selected START_FAILED");
    assert(supervisor.wait(parent.pid, pid) === null, "wait preceded error acknowledgement");
    assert(
      !closed && !supervisor.get(pid)!.revoked,
      "stderr released before error acknowledgement",
    );
    assert(reader.tryRead([new Uint8Array(1)]) === -6, "diagnostic emitted before acknowledgement");
    if (mode === "closed") reader.close();
    Atomics.store(gate, 0, 1);
    const result = await supervisor.waitForExit(parent.pid, pid);
    assert(
      result.kind === "start-failed" && result.error === "EIO",
      "host reporting changed startup outcome",
    );
    assert(closed === 1, "suppressed diagnostic retained stderr");
    assert(!duplicate, "legacy worker emitted a duplicate startup diagnostic");
    if (mode !== "closed")
      assert(
        reader.tryRead([new Uint8Array(1)]) === 0,
        "runtime_proc child received Waffle diagnostic bytes",
      );
    assert(
      errors.length === 1 && String(errors[0]).includes(diagnostic),
      "full startup error must reach host once",
    );
    if (mode === "dispose") await broker.dispose();
  } finally {
    Atomics.store(gate, 0, 1);
    clearTimeout(timer);
    reader.close();
    descriptors.dispose();
    try {
      await broker.dispose();
    } finally {
      pipe.dispose();
      for (const port of ports) port.close();
    }
  }
}
