import { expect, test } from "bun:test";
import { bootstrap, type RuntimeWorkerMessage } from "../browser/worker.js";
import { createFilesystemConnection } from "../fs/index.js";
import { PipeController } from "../proc/pipes.js";
import { createWorkerProcessTransport, workerProcessState } from "../proc/worker-client.js";

const module = new WebAssembly.Module(new Uint8Array([
  0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,5,3,1,0,1,
  7,19,2,6,109,101,109,111,114,121,2,0,6,95,115,116,97,114,116,0,0,
  10,4,1,2,0,11,
]));

test("generic child error writes the complete diagnostic before closing inherited stderr", async () => {
  const connection = createFilesystemConnection();
  const runtimeProcess = createWorkerProcessTransport();
  runtimeProcess.resources.push({ kind: "web-terminal", target: 2 });
  runtimeProcess.bindings.push({ fd: 2, reference: 0, rightsBase: 1n << 6n, rightsInheriting: 0n });
  const chunks: Uint8Array[] = [], order: string[] = [], messages: RuntimeWorkerMessage[] = [];
  const diagnostic = "child diagnostic " + "x".repeat(4096);
  const error = new Error(diagnostic); error.stack = "";
  try {
    await bootstrap({ module, args: [], env: {}, filesystem: connection.client, runtimeProcess }, {
      setup({ fs }) { fs.preopen = () => 1; fs.retain = () => {}; fs.release = () => {}; },
      resolveTerminal: () => ({ kind: "terminal", read: () => 0,
        tryWrite() { throw new Error("diagnostics must not use a nonblocking write"); },
        write(data) { order.push("write"); const part = data[0]!.slice(0, 7); chunks.push(part); return part.length; },
        close() { order.push("close"); },
        readiness: () => ({ readable: false, writable: true, hangup: false }),
      }),
      run() { throw error; },
    }, { crossOriginIsolated: true, postMessage(message) { messages.push(message); if (message.type === "error") order.push("error"); } });
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe(`Error: ${diagnostic}\n`);
    expect(order.filter(event => event === "close")).toHaveLength(1);
    expect(order.slice(-2)).toEqual(["close", "error"]);
    expect(messages.filter(message => message.type === "error")).toHaveLength(1);
  } finally { connection.client.port.close(); connection.server.port.close(); }
});

test("real child pipe drains a diagnostic larger than capacity before EOF", async () => {
  const connection = createFilesystemConnection();
  const runtimeProcess = createWorkerProcessTransport();
  const pid = workerProcessState(runtimeProcess).pid;
  const pipe = new PipeController({ capacity: 64, maxWriters: 2, maxReaders: 2, relay: "manual" });
  const reader = pipe.retain(pid + 1, "read"), writer = pipe.retain(pid, "write");
  runtimeProcess.resources.push({ kind: "pipe", endpoint: writer.handle() });
  runtimeProcess.bindings.push({ fd: 2, reference: 0, rightsBase: 1n << 6n, rightsInheriting: 0n });
  const diagnostic = "pipe diagnostic " + "λ".repeat(8192);
  const expected = new TextEncoder().encode(`Error: ${diagnostic}\n`);
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    worker = new Worker(new URL("./child-diagnostic-worker.ts", import.meta.url).href);
    const done = Promise.withResolvers<void>();
    timer = setTimeout(() => done.reject(new Error("child diagnostic timeout")), 10_000);
    worker.onerror = event => done.reject(event.error ?? new Error(event.message));
    worker.onmessage = ({ data }: MessageEvent<RuntimeWorkerMessage>) => { if (data.type === "error") done.resolve(); };
    worker.postMessage({ module, args: [], env: {}, filesystem: connection.client, runtimeProcess, diagnostic }, [connection.client.port]);
    const chunks: Uint8Array[] = [];
    await Promise.all([done.promise, (async () => {
      for (;;) {
        const buffer = new Uint8Array(31);
        const count = reader.tryRead([buffer]);
        if (count === 0) break;
        if (count > 0) chunks.push(buffer.slice(0, count));
        else await new Promise(resolve => setTimeout(resolve, 1));
      }
    })()]);
    expect(new Uint8Array(Buffer.concat(chunks))).toEqual(expected);
  } finally {
    clearTimeout(timer); worker?.terminate(); reader.close(); writer.close(); pipe.dispose();
    connection.client.port.close(); connection.server.port.close();
  }
}, 15_000);
