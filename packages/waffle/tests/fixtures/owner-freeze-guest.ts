import { bootstrap, type WorkerExecutionContext } from "../../browser/worker";
import { record, text, integer } from "../../fs/publication-attachment";
import type { FilesystemConnection } from "../../fs/protocol";
import type { Resource } from "../../core/descriptors";
import { shareFileResource } from "../../core/open-file";
import { guestFunction, publicationWasiModule } from "./publication-wasm";

const memory = new WebAssembly.Memory({ initial: 4 });
let current: WorkerExecutionContext | undefined;
let fd = 0;
let finish: (() => void) | undefined;
async function start(connection: FilesystemConnection): Promise<void> {
  await bootstrap(
    {
      controlGrant: { kind: "unbounded" },
      filesystem: connection,
      args: [],
      env: {},
      module: publicationWasiModule(),
    },
    {
      namespaces: () => ({ env: { memory } }),
      beforeBindings(context) {
        const directory = context.fs.preopen("/");
        const found = context.fs.resolve(directory, "dir/a");
        if (typeof found === "number" || found.node === undefined) throw new Error("missing file");
        context.fs.retain(found.node);
        const handle = found.node;
        const resource: Extract<Resource, { kind: "file" }> = {
          kind: "file",
          handle,
          offset: 0,
          append: true,
        };
        shareFileResource(resource, connection);
        fd = context.wasi.descriptors.open(resource, (1n << 1n) | (1n << 6n), 0n, () =>
          context.fs.release(handle),
        );
      },
      async run(context) {
        current = context;
        const done = Promise.withResolvers<void>();
        finish = done.resolve;
        self.postMessage({ event: "ready" });
        await done.promise;
        return 0;
      },
    },
  );
  self.postMessage({ event: "finished" });
}
function append(byte: number): unknown {
  if (!current) throw new Error("guest not ready");
  const view = new DataView(memory.buffer);
  view.setUint32(0, 256, true);
  view.setUint32(4, 1, true);
  view.setUint32(32, 0xdeadbeef, true);
  view.setUint8(256, byte);
  const result = guestFunction(current.instance, "fd_write")(fd, 0, 1, 32);
  return { result, count: view.getUint32(32, true) };
}
type Message =
  | { id: string; operation: "start"; connection: FilesystemConnection }
  | { id: string; operation: "append"; byte: number }
  | { id: string; operation: "stop" };
self.onmessage = ({ data }: MessageEvent<Message>) => {
  if (data.operation === "start") {
    void start(data.connection).catch((error: unknown) =>
      self.postMessage({ event: "failure", failure: String(error) }),
    );
    return;
  }
  const id = text(record(data).id);
  try {
    if (data.operation === "stop") finish?.();
    const value = data.operation === "append" ? append(integer(data.byte, 255)) : null;
    self.postMessage({ id, value });
  } catch (error) {
    self.postMessage({ id, failure: String(error) });
  }
};
