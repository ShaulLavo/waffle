import { expect, test } from "bun:test";
import { FilesystemService, MemoryBackend, createFilesystemConnection } from "../fs/index.js";
import { CompletionOwner } from "../browser/gpu/completions.js";
import { RecordRing } from "../browser/gpu/ring.js";
import type { GraphicsOpen } from "../browser/display/protocol.js";
import { OutcomeCell, claimOutcome, serializeOutcome } from "../proc/outcome.js";
import { packedControl } from "../proc/control.js";
import type { RuntimeWorkerMessage } from "../browser/worker.js";
import type {
  CleanupMode,
  CleanupRequest,
  CleanupMetrics,
} from "./fixtures/gpu/bootstrap-cleanup-worker.js";
import { serviceAccess } from "./fixtures/gpu/service-access.js";

function release(barrier: Int32Array, index: number) {
  Atomics.store(barrier, index, 1);
  Atomics.notify(barrier, index);
}
function controls(open: GraphicsOpen) {
  return {
    status: Atomics.load(new Int32Array(open.control), 0),
    reason: Atomics.load(new Int32Array(open.control), 1),
    arena: Atomics.load(new Int32Array(open.arena), 0),
    commands: new RecordRing(open.commands, 8).terminal()?.reason,
    replies: new RecordRing(open.replies, 16).terminal()?.reason,
  };
}
async function cleanup(mode: CleanupMode, prior?: number, signal = 9) {
  const filesystem = new FilesystemService(new MemoryBackend());
  const connection = createFilesystemConnection();
  const graphics = new MessageChannel();
  const barrier = new Int32Array(new SharedArrayBuffer(8));
  const revocation = new SharedArrayBuffer(64);
  const identity = new BigInt64Array(new SharedArrayBuffer(8));
  Atomics.store(identity, 0, packedControl(7, 1));
  const cells = new BigInt64Array(new SharedArrayBuffer(8));
  Atomics.store(cells, 0, 7n << 3n);
  const outcome = new OutcomeCell(cells, 7, { buffer: identity.buffer, byteOffset: 0, id: 7 });
  const waiting = Promise.withResolvers<void>();
  const selected = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<CleanupMetrics>();
  const failure = Promise.withResolvers<never>();
  const messages: RuntimeWorkerMessage[] = [];
  const worker = new Worker(new URL("./fixtures/gpu/bootstrap-cleanup-worker.ts", import.meta.url));
  let open: GraphicsOpen | undefined;
  let completion: CompletionOwner | undefined;
  const timer = setTimeout(() => failure.reject(new Error("Bootstrap cleanup deadline")), 5000);
  graphics.port1.onmessage = ({
    data,
  }: MessageEvent<GraphicsOpen | { type: "close"; id: number }>) => {
    if (data.type !== "open") return;
    open = data;
    completion = new CompletionOwner({
      access: serviceAccess(),
      commands: new RecordRing(data.commands, 8),
      replies: new RecordRing(data.replies, 16),
      arena: new Uint8Array(data.arena),
    });
    Atomics.store(new Int32Array(data.control), 0, 1);
    Atomics.notify(new Int32Array(data.control), 0);
  };
  worker.onerror = (event) => failure.reject(new Error(event.message));
  worker.onmessage = ({
    data,
  }: MessageEvent<
    | RuntimeWorkerMessage
    | { type: "waiting" }
    | { type: "selected" }
    | { type: "finished"; metrics: CleanupMetrics }
    | { type: "fixture-error"; message: string }
  >) => {
    if (data.type === "waiting") return waiting.resolve();
    if (data.type === "selected") return selected.resolve();
    if (data.type === "finished") return finished.resolve(data.metrics);
    if (data.type === "fixture-error") return failure.reject(new Error(data.message));
    messages.push(data);
  };
  const selectTerminal = () => {
    if (!open) throw new Error("Open admission missing");
    if (prior) new RecordRing(open.commands, 8).terminate(prior);
    claimOutcome(outcome, { kind: "signaled", code: signal });
    if (mode === "unobserved-signal") Atomics.store(identity, 0, packedControl(8, 1));
    if (mode === "revoke-first") {
      Atomics.store(new Int32Array(revocation), 0, 1);
      completion!.finishRetirement(4);
    }
    release(barrier, 0);
  };
  try {
    filesystem.connect(connection.server);
    const request: CleanupRequest = {
      mode,
      barrier,
      controlGrant: { kind: "unbounded" },
      outcome: serializeOutcome(outcome),
      filesystem: connection.client,
      args: [],
      env: {},
      graphics: {
        port: graphics.port2,
        gpu: true,
        revocation,
        surfaces: [],
        commandBytes: 128,
        completionBytes: 128,
      },
    };
    worker.postMessage(request, [connection.client.port, graphics.port2]);
    if (!["normal", "exit137", "error"].includes(mode)) {
      await Promise.race([waiting.promise, failure.promise]);
      selectTerminal();
    }
    if (mode === "retained-signal") {
      await Promise.race([selected.promise, failure.promise]);
      Atomics.store(identity, 0, packedControl(8, 1));
      release(barrier, 1);
    }
    const metrics = await Promise.race([finished.promise, failure.promise]);
    if (!open) throw new Error("Missing retained GPU open");
    const beforeRevoke = controls(open);
    const errors = messages.filter((message) => message.type === "cleanup-error");
    expect(errors).toEqual([]);
    Atomics.store(new Int32Array(revocation), 0, 1);
    completion!.finishRetirement(4);
    expect(controls(open)).toEqual(beforeRevoke);
    return { metrics, controls: beforeRevoke, messages };
  } finally {
    clearTimeout(timer);
    release(barrier, 0);
    release(barrier, 1);
    await worker.terminate();
    completion?.finishRetirement(4);
    filesystem.dispose();
    connection.client.port.close();
    connection.server.port.close();
    graphics.port1.close();
    graphics.port2.close();
  }
}
function terminal(result: Awaited<ReturnType<typeof cleanup>>, reason: number) {
  expect(result.controls).toEqual({
    status: reason === 3 ? -48 : -64,
    reason,
    arena: reason,
    commands: reason,
    replies: reason,
  });
  expect(result.metrics.returned).toBe(0);
}
for (const signal of [9, 15])
  test(`bootstrap implicit GPU cleanup propagates selected signal ${signal} before grant revocation`, async () => {
    const result = await cleanup("signal", undefined, signal);
    terminal(result, 4);
    expect(result.metrics).toMatchObject({ entered: 1, signal, cleanupRevocation: 0 });
    expect(result.messages.find((message) => message.type === "exit")).toMatchObject({
      code: 128 + signal,
      signal,
    });
  });
for (const prior of [1, 2, 3, 4, 5])
  test(`bootstrap signaled GPU cleanup preserves prior ring winner ${prior}`, async () => {
    const result = await cleanup("signal", prior);
    terminal(result, prior);
    expect(result.metrics.signal).toBe(9);
  });
for (const mode of ["normal", "exit137", "error", "unobserved-signal", "explicit-close"] as const)
  test(`bootstrap GPU cleanup does not infer a new terminal from ${mode}`, async () => {
    const result = await cleanup(mode);
    terminal(result, 1);
    if (mode === "unobserved-signal")
      expect(result.metrics).toMatchObject({ signal: 0, errno: 71 });
    if (mode === "exit137")
      expect(result.messages.find((message) => message.type === "exit")).toMatchObject({
        code: 137,
        signal: undefined,
      });
  });
for (const mode of ["retained-signal", "revoke-first"] as const)
  test(`bootstrap GPU cleanup preserves authenticated ${mode}`, async () => {
    const result = await cleanup(mode);
    terminal(result, 4);
    expect(result.metrics.signal).toBe(9);
    expect(result.metrics.cleanupRevocation).toBe(mode === "revoke-first" ? 1 : 0);
  });
