import { Worker } from "node:worker_threads";
import { FilesystemService } from "../fs/service.js";
import { MemoryBackend } from "../fs/backend.js";
import { createFilesystemConnection, revokeFilesystem } from "../fs/protocol.js";
import { createRuntimeNetwork, type RuntimeNetwork } from "../browser/net/runtime.js";
import { createPreview1Network } from "../browser/preview1-network.js";
import type { Preview1SocketBinding } from "../browser/preview1-network-types.js";
import type { NetConnect, NetOutboundStream } from "../browser/net/outbound.js";
import { nodeWorkerTransfers } from "./fixtures/node-worker-transfers.js";

export async function socketModule(name = "preview1-socket-imports.wat") {
  const { default: wabt } = await import("wabt");
  const compiler = await wabt();
  const source = await Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();
  const parsed = compiler.parseWat(name, source);
  try {
    return new WebAssembly.Module(Uint8Array.from(parsed.toBinary({}).buffer));
  } finally {
    parsed.destroy();
  }
}

export function scriptedSocket(holdWrites = false, echo = false) {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = 0,
    aborted = 0,
    finished = 0;
  const writes: Uint8Array[] = [];
  const gate = Promise.withResolvers<void>();
  const reset = Promise.withResolvers<void>();
  const stream: NetOutboundStream = {
    remote: { address: "203.0.113.7", port: 4321, family: "IPv4" },
    readable: new ReadableStream<Uint8Array>(
      {
        start(controller) {
          source = controller;
        },
        cancel() {
          cancelled++;
        },
      },
      { highWaterMark: 0 },
    ),
    writable: new WritableStream<Uint8Array>({
      start(controller) {
        controller.signal.addEventListener("abort", () => gate.resolve(), { once: true });
      },
      write(bytes) {
        writes.push(bytes.slice());
        if (echo) source.enqueue(bytes.slice());
        if (holdWrites) return gate.promise;
      },
      close() {
        finished++;
        if (echo) source.close();
      },
      abort() {
        aborted++;
        reset.resolve();
      },
    }),
  };
  return {
    stream,
    writes,
    gate,
    reset: reset.promise,
    data: (bytes: Uint8Array) => source.enqueue(bytes),
    end: () => source.close(),
    error: () => source.error(Error("target reset")),
    get cancelled() {
      return cancelled;
    },
    get aborted() {
      return aborted;
    },
    get finished() {
      return finished;
    },
  };
}

export async function socketGuest(options: {
  connect?: NetConnect;
  module?: WebAssembly.Module;
  interactive?: boolean;
  args?: string[];
  host?: string;
  hostCallFd?: number;
  sockets?: number[];
  bindings?: readonly Preview1SocketBinding[];
  network?: RuntimeNetwork;
}) {
  const owner = options.network ? undefined : await createRuntimeNetwork(() => {});
  const runtimeNetwork = options.network ?? owner?.network;
  if (!runtimeNetwork) throw Error("socket fixture needs a network");
  const network = await createPreview1Network(
    { network: async () => runtimeNetwork },
    {
      connect: options.connect,
      sockets:
        options.bindings ??
        (options.sockets ?? [3]).map((fd) => ({
          fd,
          socket: { connect: { host: options.host ?? "echo.example", port: 4321 } },
        })),
    },
  );
  if (!network) throw Error("fixture needs a socket binding");
  const backend = new MemoryBackend();
  backend.fs.writeFile("/fixture", new TextEncoder().encode("fixture"));
  const fs = new FilesystemService(backend);
  const pair = createFilesystemConnection();
  fs.connect(pair.server);
  const worker = new Worker(new URL("./fixtures/preview1-socket-worker.ts", import.meta.url));
  const ready = Promise.withResolvers<void>();
  const exit = Promise.withResolvers<{
    type: string;
    code: number;
    message?: string;
    cleanupErrors?: string[];
  }>();
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<unknown>>>();
  const output: Uint8Array[] = [];
  const stdout = Promise.withResolvers<void>();
  let next = 0;
  worker.on("message", (message) => {
    if (message.type === "ready") return ready.resolve();
    if (message.type === "stdout") {
      output.push(message.data);
      stdout.resolve();
    }
    if (message.type === "exit" || message.type === "error" || message.type === "cleanup-error") {
      ready.resolve();
      for (const call of pending.values()) call.reject(Error("socket worker exited"));
      pending.clear();
      network.dispose();
      exit.resolve(message);
    }
    if (message.type !== "result") return;
    const call = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) call?.reject(Error(message.error));
    else call?.resolve(message.value);
  });
  worker.on("error", (error) => {
    ready.reject(error);
    exit.reject(error);
  });
  const rpc = (message: Record<string, unknown>) => {
    const id = ++next;
    const result = Promise.withResolvers<unknown>();
    pending.set(id, result);
    worker.postMessage({ ...message, id });
    return result.promise;
  };
  try {
    worker.postMessage(
      {
        request: {
          module: options.module ?? (await socketModule()),
          args: options.args ?? [],
          env: {},
          controlGrant: { kind: "unbounded" },
          filesystem: pair.client,
          network: network.connection,
        },
        interactive: options.interactive ?? true,
        hostCallFd: options.hostCallFd,
      },
      nodeWorkerTransfers([pair.client.port, network.connection.port]),
    );
    await ready.promise;
  } catch (error) {
    await worker.terminate();
    network.dispose();
    fs.dispose();
    await owner?.dispose();
    throw error;
  }
  return {
    exit: exit.promise,
    cancel: () => revokeFilesystem(pair.client),
    output,
    stdout: stdout.promise,
    network,
    call: async (name: string, ...args: (number | bigint)[]) =>
      Number(await rpc({ op: "call", name, args })),
    write: async (at: number, bytes: Uint8Array) => {
      await rpc({ op: "write", at, bytes });
    },
    read: async (at: number, length: number) =>
      (await rpc({ op: "read", at, length })) as Uint8Array,
    async close() {
      await worker.terminate();
      network.dispose();
      fs.dispose();
      pair.server.port.close();
      pair.client.port.close();
      await owner?.dispose();
    },
  };
}
export type SocketGuest = Awaited<ReturnType<typeof socketGuest>>;
export const bytes = (text: string) => new TextEncoder().encode(text);
export function words(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((value, i) => view.setUint32(i * 4, value, true));
  return out;
}
export const uint = (data: Uint8Array) =>
  new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
