import { Wasi } from "../core/wasi.js";
import { createFilesystemConnection } from "../fs/protocol.js";
import { MemFS } from "../fs/memory.js";
import { ProcessABI } from "../proc/abi.js";
import {
  createWorkerProcessTransport,
  WorkerProcessClient,
  type WorkerProcessTransport,
} from "../proc/worker-client.js";
import { createWorkerPipeCodec } from "../proc/worker-pipes.js";
import {
  assertPipeFilestat,
  pipeFilestatModule,
  pipeReadRights,
  pipeWriteRights,
  type PipeFilestatGuest,
} from "./fixtures/pipe-filestat-guest.js";
import type { RuntimeWorkerMessage } from "../browser/worker.js";

function childMessage(
  message: RuntimeWorkerMessage,
  done: { resolve(): void; reject(reason: Error): void },
): void {
  if (message.type === "error") done.reject(new Error(message.message));
  if (message.type !== "exit") return;
  if (message.code !== 0) {
    done.reject(new Error(`pipe filestat child exited ${message.code}`));
    return;
  }
  done.resolve();
}

/** Same guest and real child Worker run on Bun and all three browser engines. */
export async function browserPipeFilestat(workerUrl = "/pipe-filestat-worker.js"): Promise<void> {
  const fs = new MemFS(),
    transport = createWorkerProcessTransport(),
    codec = createWorkerPipeCodec();
  const processImports: Record<string, (...args: number[]) => number> = {};
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens: {},
    namespaces: { runtime_proc: processImports },
    stdout() {},
    stderr() {},
    sleep() {},
  });
  let child: WorkerProcessTransport | undefined;
  const service = new WorkerProcessClient({
    transport,
    descriptors: wasi.descriptors,
    codec,
    postMessage(message) {
      if (message.operation === "spawn") child = message.transport;
    },
  });
  const abi = new ProcessABI({
    memory: () => guest.memory,
    descriptors: wasi.descriptors,
    fs,
    pid: service.pid,
    service,
    signals: service.signals,
  });
  const module = pipeFilestatModule();
  Object.assign(processImports, abi.imports);
  const imports = wasi.imports(module);
  const instance = new WebAssembly.Instance(module, imports);
  const guest = instance.exports as unknown as PipeFilestatGuest;
  let worker: Worker | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let connection: ReturnType<typeof createFilesystemConnection> | undefined;
  try {
    connection = createFilesystemConnection();
    wasi.start(instance);
    if (guest.pipe(32) !== 0) throw new Error("guest pipe creation failed");
    const view = new DataView(guest.memory.buffer),
      reader = view.getUint32(32, true),
      writer = view.getUint32(36, true);
    assertPipeFilestat(guest, reader, pipeReadRights);
    assertPipeFilestat(guest, writer, pipeWriteRights);
    const request = new TextEncoder().encode(
      JSON.stringify({
        executable: "pipe-filestat",
        argv: [],
        env: {},
        cwd: "/",
        job: 0,
        fds: [
          { parent: reader, child: 17 },
          { parent: writer, child: 18 },
        ],
      }),
    );
    new Uint8Array(guest.memory.buffer).set(request, 1024);
    if (guest.spawn(1024, request.length) <= 0 || !child) throw new Error("guest spawn failed");
    wasi.descriptors.close(reader);
    wasi.descriptors.close(writer);
    worker = new Worker(workerUrl, { type: "module" });
    const done = Promise.withResolvers<void>();
    timer = setTimeout(
      () => done.reject(new Error("inherited pipe filestat worker timeout")),
      10_000,
    );
    worker.onerror = (event) => done.reject(event.error ?? new Error(event.message));
    worker.onmessage = ({ data }: MessageEvent<RuntimeWorkerMessage>) => childMessage(data, done);
    worker.postMessage(
      { module, args: [], env: {}, filesystem: connection.client, runtimeProcess: child },
      [connection.client.port],
    );
    await done.promise;
  } finally {
    clearTimeout(timer);
    worker?.terminate();
    wasi.descriptors.dispose();
    for (const token of child?.resources ?? []) codec.discard(token);
    connection?.client.port.close();
    connection?.server.port.close();
  }
}
