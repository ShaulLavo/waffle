import { BrowserProcessBroker } from "../browser/process-broker.js";
import { DescriptorTable } from "../core/descriptors.js";
import { connectFilesystemIdentity, createFilesystemIdentity } from "../fs/protocol.js";
import { ProcessIdentityAllocator } from "../proc/identity.js";
import { PipeController } from "../proc/pipes.js";
import { ExecutableRegistry } from "../proc/registry.js";
import { ProcessTable } from "../proc/table.js";
import { createWorkerProcessTransport, WorkerProcessClient, type WorkerProcessMessage } from "../proc/worker-client.js";

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

export async function browserStartupDiagnostic(workerUrl = "/startup-diagnostic-worker.js", mode: "drain" | "stalled" | "closed" | "dispose" = "drain", legacy = false): Promise<void> {
  const module = new WebAssembly.Module(new Uint8Array([
    0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,5,3,1,0,1,
    7,19,2,6,109,101,109,111,114,121,2,0,6,95,115,116,97,114,116,0,0,
    10,4,1,2,0,11,
  ]));
  const identities = new ProcessIdentityAllocator(), table = new ProcessTable(identities), registry = new ExecutableRegistry();
  registry.register("fixture", { module, adapter: "fixture" });
  const pipe = new PipeController({ capacity: 64, maxReaders: 2, maxWriters: 2, relay: "manual" });
  const ports: MessagePort[] = [], errors: unknown[] = [], notices: WorkerProcessMessage[] = [];
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const diagnostic = "startup diagnostic " + "λ".repeat(8192);
  let ready!: () => void, reject!: (error: unknown) => void, closed = 0, duplicate = false;
  const pending = new Promise<void>((resolve, fail) => { ready = resolve; reject = fail; });
  const timer = setTimeout(() => reject(new Error("startup diagnostic worker timeout")), 10_000);
  const broker = new BrowserProcessBroker({ identities, table, registry, onError: error => errors.push(error),
    filesystem: { connect(identity) { const pair = connectFilesystemIdentity(identity); ports.push(pair.client.port, pair.server.port); return pair.client; },
      revoke() {}, reap() {}, async quiesce() {} },
    launch(context) {
      const writer = pipe.retain(context.pid, "write");
      context.descriptors.openAt(2, writer, 1n << 6n, 0n, () => { closed++; writer.close(); });
      return broker.launchWorker(context, { workerUrl,
        request: { module, args: [], env: {}, diagnostic, diagnosticGate: gate.buffer, legacy },
        onMessage(message) { if (message.type === "startup-diagnostic-pending") ready(); if (message.type === "legacy-startup-diagnostic") duplicate = true; },
      });
    },
  });
  const root = createWorkerProcessTransport({ pid: identities.pid(), job: identities.job(), identity: identities.buffer });
  root.data = { filesystem: createFilesystemIdentity() };
  const descriptors = new DescriptorTable();
  const codec = { export() { throw new Error("no descriptor transfer"); }, import() { throw new Error("no descriptor transfer"); }, discard() {} };
  const parent = new WorkerProcessClient({ transport: root, descriptors, codec,
    postMessage(message) { notices.push(message); }, prepareSpawn: () => ({ data: { filesystem: createFilesystemIdentity() } }) });
  const reader = pipe.retain(parent.pid, "read");
  try {
    await broker.adoptRuntimeRoot(root);
    const pid = parent.spawn(parent.pid, { executable: "fixture", argv: [], env: {}, cwd: "/", job: -1, fds: [] });
    for (const notice of notices) await broker.runtimeMessage(notice, parent.pid);
    const supervisor = await broker.ready();
    supervisor.onChildExit(event => { if (event.pid === pid) ready(); });
    await supervisor.start(pid);
    await pending;
    // Deterministically exercise the same shared-word observation as the broker's timer pump.
    supervisor.exit(pid, 126);
    assert(supervisor.startStatus(parent.pid, pid) > 0, "worker must have selected START_FAILED");
    assert(supervisor.wait(parent.pid, pid) === null, "startup wait became collectible before diagnostic acknowledgement");
    assert(!closed && !supervisor.get(pid)!.revoked, "stderr released before the diagnostic-bearing error");
    const empty = new Uint8Array(1);
    assert(reader.tryRead([empty]) === -6, "diagnostic emitted without its error message");
    if (mode === "closed") reader.close();
    Atomics.store(gate, 0, 1);
    if (mode !== "drain") {
      if (mode === "dispose") {
        // Let the diagnostic fill the tiny ring, then cancel while a live reader is stalled.
        while ((reader.readiness().nbytes ?? 0) < 64) await new Promise(resolve => setTimeout(resolve, 1));
        await broker.dispose();
        assert(closed === 1, "disposal must release stderr while its reader is stalled");
        return;
      }
      const result = await supervisor.waitForExit(parent.pid, pid);
      assert(result.kind === "start-failed" && result.error === "EIO", "failed delivery changed startup outcome");
      assert(closed === 1, "undeliverable diagnostic retained stderr");
      assert(errors.length === 1 && (errors[0] as { errno?: number }).errno === (mode === "closed" ? 64 : 6),
        `expected one typed ${mode} delivery failure: ${errors.join("; ")}`);
      return;
    }
    const chunks: Uint8Array[] = [];
    const exited = supervisor.waitForExit(parent.pid, pid);
    await Promise.all([exited, (async () => {
      for (;;) {
        const buffer = new Uint8Array(31), count = reader.tryRead([buffer]);
        if (count === 0) break;
        if (count > 0) chunks.push(buffer.slice(0, count));
        else await new Promise(resolve => setTimeout(resolve, 1));
      }
    })()]);
    const actual = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0; for (const chunk of chunks) { actual.set(chunk, offset); offset += chunk.length; }
    assert(new TextDecoder().decode(actual) === `runtime: process start failed: Error: Error: ${diagnostic}\n`, "startup diagnostic must be complete and emitted exactly once");
    assert(!duplicate, "worker and broker both emitted the startup diagnostic");
    assert(closed === 1, "stderr must close once after diagnostic drain");
    const result = parent.wait(parent.pid, pid);
    assert(result?.kind === "start-failed" && result.error === "EIO", "diagnostic changed startup outcome");
    assert(errors.length === 0, `broker errors: ${errors.join("; ")}`);
  } finally {
    Atomics.store(gate, 0, 1); clearTimeout(timer);
    reader.close(); descriptors.dispose();
    try { await broker.dispose(); } finally { pipe.dispose(); for (const port of ports) port.close(); }
  }
}
