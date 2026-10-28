import { expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { FilesystemService, MemoryBackend, createFilesystemConnection } from "../fs/index.js";
import { HEADER, unpack } from "../fs/protocol.js";
import { createWorkerProcessTransport } from "../proc/worker-client.js";
import type { FilesystemReadyWorkerData } from "./fixtures/filesystem-ready-worker.js";

async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const failure = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(Error("filesystem readiness test stalled")), 3000);
  });
  try {
    return await Promise.race([pending, failure]);
  } finally {
    clearTimeout(timer);
  }
}

function recordRequests(
  connection: ReturnType<typeof createFilesystemConnection>["server"],
  service: FilesystemService,
  flags: Int32Array,
  operations: string[],
): void {
  service.connect(connection);
  const receive = connection.port.onmessage!;
  connection.port.onmessage = (event) => {
    if (!event.data.buffer) {
      receive.call(connection.port, event);
      return;
    }
    const cells = new Int32Array(event.data.buffer, 0, HEADER / 4);
    const request = unpack(new Uint8Array(event.data.buffer, HEADER, cells[1]!));
    operations.push(request.operation);
    if (request.operation === "connectionReady") Atomics.store(flags, 0, 1);
    receive.call(connection.port, event);
  };
}

for (const process of [false, true])
  for (const stage of ["setup", "namespaces", "preopens"] as const)
    test(`the first synchronous ${stage} filesystem operation follows a real connection round trip, process=${process}`, async () => {
      const connection = createFilesystemConnection();
      const service = new FilesystemService(new MemoryBackend());
      const flags = new Int32Array(new SharedArrayBuffer(4));
      const operations: string[] = [];
      const messages: { type: string; code?: number; message?: string }[] = [];
      const worker = new Worker(new URL("./fixtures/filesystem-ready-worker.ts", import.meta.url), {
        workerData: {
          connection: connection.client,
          flags: flags.buffer,
          stage,
          process: process ? createWorkerProcessTransport() : undefined,
        } satisfies FilesystemReadyWorkerData,
        transferList: [connection.client.port],
      });
      const result = Promise.withResolvers<void>();
      worker.on("error", result.reject);
      worker.on("message", (message) => {
        messages.push(message);
        if (message.type === "connect")
          recordRequests(connection.server, service, flags, operations);
        if (message.type === "exit" || message.type === "error") result.resolve();
      });
      try {
        await bounded(result.promise);
        expect(messages.filter((message) => message.type === "error")).toEqual([]);
        expect(messages.find((message) => message.type === "exit")).toMatchObject({ code: 0 });
        expect(operations[0]).toBe("connectionReady");
        expect(operations).toContain("preopen");
      } finally {
        await worker.terminate();
        service.dispose();
        connection.client.port.close();
        connection.server.port.close();
      }
    }, 10000);
