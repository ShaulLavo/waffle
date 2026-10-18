import { type RuntimeWorkerMessage } from "../browser/worker.js";
import { DIAGNOSTIC_STALL_TIMEOUT_MS } from "../browser/diagnostic.js";
import { createFilesystemConnection } from "../fs/index.js";
import { readOutcome } from "../proc/outcome.js";
import { PipeController } from "../proc/pipes.js";
import { createWorkerProcessTransport, workerProcessState } from "../proc/worker-client.js";

const module = new WebAssembly.Module(new Uint8Array([
  0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,5,3,1,0,1,
  7,19,2,6,109,101,109,111,114,121,2,0,6,95,115,116,97,114,116,0,0,
  10,4,1,2,0,11,
]));
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
export type DiagnosticReader = "draining" | "slow" | "stalled" | "closed";

/** The same real-Worker control runs under Bun and the three browser engines. */
export async function browserRuntimeDiagnostic(workerUrl = "/child-diagnostic-worker.js", mode: DiagnosticReader = "draining"): Promise<void> {
  const connection = createFilesystemConnection(), runtimeProcess = createWorkerProcessTransport();
  const pid = workerProcessState(runtimeProcess).pid;
  const pipe = new PipeController({ capacity: 64, maxWriters: 2, maxReaders: 2, relay: "manual" });
  const reader = pipe.retain(pid + 1, "read"), writer = pipe.retain(pid, "write");
  runtimeProcess.resources.push({ kind: "pipe", endpoint: writer.handle() });
  runtimeProcess.bindings.push({ fd: 2, reference: 0, rightsBase: 1n << 6n, rightsInheriting: 0n });
  const diagnostic = "pipe diagnostic " + "λ".repeat(8192), expected = `Error: ${diagnostic}\n`;
  // This run owns only one Worker, one RPC connection, pipe endpoints and its deadline.
  let worker: Worker | undefined, draining: Promise<void> | undefined;
  let stopped = false;
  const deadline = async <T>(operation: Promise<T>, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timeout`)), 12_000); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  try {
    worker = new Worker(workerUrl, { type: "module" });
    const done = Promise.withResolvers<Extract<RuntimeWorkerMessage, { type: "error" }>>();
    worker.onerror = event => done.reject(event.error ?? new Error(event.message));
    worker.onmessage = ({ data }: MessageEvent<RuntimeWorkerMessage>) => { if (data.type === "error") done.resolve(data); };
    if (mode === "closed") reader.close();
    const started = performance.now();
    worker.postMessage({ module, args: [], env: {}, filesystem: connection.client, runtimeProcess, diagnostic }, [connection.client.port]);
    const chunks: Uint8Array[] = [];
    let received = 0, pauses = 0;
    const drain = async () => {
      while (!stopped) {
        const buffer = new Uint8Array(31), count = reader.tryRead([buffer]);
        if (count === 0) break;
        if (count > 0) { chunks.push(buffer.slice(0, count)); received += count; }
        // Two sub-deadline pauses prove progress resets the deadline without multiplying
        // hundreds of browser timer clamps into an unrelated wall-clock timeout.
        if (mode === "slow" && ((pauses === 0 && received > 0) || (pauses === 1 && received > 8_192))) {
          pauses++;
          await new Promise(resolve => setTimeout(resolve, DIAGNOSTIC_STALL_TIMEOUT_MS / 2 + 100));
        } else if (count < 0) await new Promise(resolve => setTimeout(resolve, 1));
      }
    };
    draining = mode === "draining" || mode === "slow" ? drain() : undefined;
    const [message] = await deadline(Promise.all([done.promise, draining]), "child diagnostic acknowledgement and EOF");
    const elapsed = performance.now() - started;
    const outcome = readOutcome(workerProcessState(runtimeProcess).signals.outcome);
    check(outcome?.kind === "exited" && outcome.code === 1, "diagnostic delivery changed the runtime error outcome");
    if (mode === "stalled") {
      check(elapsed >= DIAGNOSTIC_STALL_TIMEOUT_MS && elapsed < DIAGNOSTIC_STALL_TIMEOUT_MS + 3_000, `stalled reader deadline: ${elapsed}ms`);
      check(message.cleanupErrors?.length === 1 && message.cleanupErrors[0]!.includes("reader made no progress for five seconds"), "missing stalled diagnostic delivery report");
      await deadline(drain(), "stalled child diagnostic EOF");
    } else if (mode === "closed") {
      check(elapsed < 3_000, `closed reader retained a dead child for ${elapsed}ms`);
      check(message.cleanupErrors?.length === 1 && message.cleanupErrors[0]!.includes("diagnostic write failed (-64)"), "missing closed diagnostic delivery report");
      return;
    } else {
      check(!message.cleanupErrors, `draining reader delivery failed: ${message.cleanupErrors?.join("; ")}`);
      if (mode === "slow") check(elapsed > DIAGNOSTIC_STALL_TIMEOUT_MS, "slow reader did not exercise progress beyond one deadline");
    }
    const bytes = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
    let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const wanted = new TextEncoder().encode(expected), length = mode === "stalled" ? 64 : wanted.length;
    check(bytes.length === length && bytes.every((byte, index) => byte === wanted[index]), "diagnostic bytes were lost, duplicated or reordered before EOF");
  } finally {
    stopped = true;
    worker?.terminate(); reader.close(); writer.close(); pipe.dispose();
    await draining?.catch(() => {});
    connection.client.port.close(); connection.server.port.close();
  }
}
