import {
  bootstrap,
  type RuntimeWorkerRequest,
  type WorkerExecutionContext,
} from "../../browser/worker";
import { shareFileResource } from "../../core/open-file";
import type { Resource } from "../../core/descriptors";
import { createWorkerProcessTransport } from "../../proc/worker-client";
import type { FilesystemConnection } from "../../fs/protocol";
import { integer, record, residentRequest, text } from "../../fs/publication-attachment";
import { guestFunction, publicationProcModule, publicationWasiModule } from "./publication-wasm";

let current: WorkerExecutionContext | undefined;
let resource: Extract<Resource, { kind: "file" }> | undefined;
let fd = 0,
  mode = "wasi",
  setupCount = 0;
let finish: (() => void) | undefined;
let claimGate: Int32Array | undefined;
let privateInterceptions = 0;
const nativeLoad = Atomics.load, nativeStore = Atomics.store, nativeCompare = Atomics.compareExchange;
function armDefensiveHooks(): void {
  const observe = (array: Int32Array) => {
    if (array.length === 3 && array.buffer.byteLength === 12) privateInterceptions++;
  };
  Atomics.load = ((array: Int32Array, index: number) => { observe(array); return nativeLoad(array, index); }) as typeof Atomics.load;
  Atomics.store = ((array: Int32Array, index: number, value: number) => { observe(array); return nativeStore(array, index, value); }) as typeof Atomics.store;
  Atomics.compareExchange = ((array: Int32Array, index: number, expected: number, replacement: number) => { observe(array); return nativeCompare(array, index, expected, replacement); }) as typeof Atomics.compareExchange;
}
function defensiveResult(): number {
  Atomics.load = nativeLoad;
  Atomics.store = nativeStore;
  Atomics.compareExchange = nativeCompare;
  return privateInterceptions;
}
const memory = new WebAssembly.Memory({ initial: 4 });
function call(body: unknown): unknown {
  if (!current || !resource) throw new Error("guest not started");
  const request = record(body),
    kind = text(request.kind);
  if (!Array.isArray(request.bytes)) throw new Error("missing actual guest input");
  const bytes = Uint8Array.from(request.bytes, (byte: unknown) => integer(byte, 255));
  const guestBytes = new Uint8Array(memory.buffer, 256, bytes.length);
  guestBytes.set(bytes);
  const view = new DataView(memory.buffer);
  view.setUint32(0, 256, true);
  view.setUint32(4, bytes.length, true);
  view.setUint32(32, 0xdeadbeef, true);
  resource.append = kind === "append";
  const offset = request.offset === undefined ? resource.offset : integer(request.offset);
  if (kind === "read") resource.offset = offset;
  let result: number;
  if (mode === "proc")
    result = guestFunction(current.instance, kind === "read" ? "read" : "write")(
      fd,
      256,
      bytes.length,
    );
  else if (kind === "write")
    result = guestFunction(current.instance, "fd_pwrite")(fd, 0, 1, BigInt(offset), 32);
  else
    result = guestFunction(current.instance, kind === "read" ? "fd_read" : "fd_write")(
      fd,
      0,
      1,
      32,
    );
  return {
    result,
    offset: resource.offset,
    bytes: Array.from(guestBytes),
    count: view.getUint32(32, true),
  };
}
async function start(request: { mode: string; connection: FilesystemConnection; handle?: number }): Promise<void> {
  mode = text(request.mode);
  const connection = request.connection;
  const req: RuntimeWorkerRequest = {
    filesystem: connection,
    args: [],
    env: {},
    module: mode === "proc" ? publicationProcModule() : publicationWasiModule(),
    runtimeProcess: mode === "proc" ? createWorkerProcessTransport() : undefined,
  };
  await bootstrap(req, {
    setup() {
      setupCount++;
    },
    namespaces: () => ({ env: { memory } }),
    beforeBindings(context) {
      const descriptor = connection.residentPublication;
      const handle = descriptor?.handle ?? request.handle;
      if (handle === undefined) throw new Error("missing retained handle");
      context.fs.retain(handle);
      resource = { kind: "file", handle, offset: 0, append: false };
      shareFileResource(resource, connection);
      fd = context.wasi.descriptors.open(resource, (1n << 1n) | (1n << 2n) | (1n << 6n), 0n, () =>
        context.fs.release(handle),
      );
    },
    async run(context) {
      current = context;
      const done = Promise.withResolvers<void>();
      finish = done.resolve;
      self.postMessage({ event: "ready", setupCount });
      await done.promise;
      return 0;
    },
  });
  self.postMessage({ event: "finished", setupCount });
}
function armClaim(buffer: unknown): void {
  if (!(buffer instanceof SharedArrayBuffer)) throw new Error("missing local freeze cell");
  claimGate = new Int32Array(buffer);
  const compare = Atomics.compareExchange;
  Atomics.compareExchange = function (array, index, expected, replacement) {
    const result = Reflect.apply(compare, Atomics, [array, index, expected, replacement]);
    if (array.length !== 3 || index !== 0 || expected !== 0 || replacement !== 1 || result !== 0)
      return result;
    Atomics.compareExchange = compare;
    self.postMessage({ event: "claimed" });
    while (!Atomics.load(claimGate!, 0)) Atomics.wait(claimGate!, 0, 0);
    return result;
  };
}
async function execute(operation: string, body: unknown): Promise<unknown> {
  if (operation === "armClaim") {
    armClaim(body);
    return null;
  }
  if (!current) throw new Error("guest not ready");
  if (operation === "armDefensiveHooks") { armDefensiveHooks(); return null; }
  if (operation === "defensiveResult") return defensiveResult();
  if (operation === "prepare") {
    await current.fs.residentPublicationClient().prepare(residentRequest(body));
    return null;
  }
  if (operation === "settle") return current.fs.residentPublicationClient().settle();
  if (operation === "call") return call(body);
  if (operation === "stop") {
    finish?.();
    return null;
  }
  throw new Error(`unknown guest operation ${operation}`);
}
type GuestMessage =
  | { id: string; operation: "start"; body: { mode: string; connection: FilesystemConnection; handle?: number } }
  | { id: string; operation: "armDefensiveHooks" | "defensiveResult" | "armClaim" | "prepare" | "settle" | "call" | "stop"; body: unknown };
self.onmessage = ({ data }: MessageEvent<GuestMessage>) => {
  const id = data.id;
  if (data.operation === "start") {
    void start(data.body).catch((error: unknown) =>
      self.postMessage({ event: "failure", failure: String(error) }),
    );
    self.postMessage({ id, value: null });
    return;
  }
  void execute(data.operation, data.body).then(
    (value) => self.postMessage({ id, value }),
    (error: unknown) => self.postMessage({ id, failure: String(error) }),
  );
};
