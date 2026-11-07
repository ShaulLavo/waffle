import {
  bootstrap,
  preview1Executor,
  type RuntimeWorkerRequest,
  type RuntimeWorkerHost,
} from "../../../browser/worker.js";
import { poisonProcessIntrinsics } from "../process-intrinsics.js";

const host = globalThis as unknown as {
  onmessage: (event: MessageEvent<RuntimeWorkerRequest>) => Promise<void>;
};
const send = globalThis.postMessage.bind(globalThis);
const add = globalThis.addEventListener.bind(globalThis),
  remove = globalThis.removeEventListener.bind(globalThis);
host.onmessage = async ({ data }) => {
  let poison: ReturnType<typeof poisonProcessIntrinsics> | undefined;
  const receipts: SharedArrayBuffer[] = [];
  let memory: WebAssembly.Memory | undefined;
  let actualId = 0;
  const embedding: RuntimeWorkerHost = {
    crossOriginIsolated,
    postMessage(message, transfer) {
      if (message.type === "shared-control-allocation") {
        receipts[receipts.length] = message.buffer;
        poison?.track(message.buffer);
      }
      send(message, transfer ?? []);
    },
    addEventListener: (type, listener) => add(type, listener as EventListener),
    removeEventListener: (type, listener) => remove(type, listener as EventListener),
  };
  await bootstrap(
    data,
    {
      ...preview1Executor,
      imports(imports) {
        if (data.env.GPU_FORGE !== "1" || !imports.runtime_window) return;
        const originalSurfaces = imports.runtime_window.surfaces,
          originalInfo = imports.runtime_window.surface_info;
        if (typeof originalSurfaces !== "function" || typeof originalInfo !== "function")
          throw new Error("Missing window imports");
        imports.runtime_window.surfaces = (ptr: number, length: number) => {
          const count = originalSurfaces(ptr, length);
          if (count > 0 && memory) {
            const view = new DataView(memory.buffer);
            actualId = view.getUint32(ptr, true);
            view.setUint32(ptr, 0xdead, true);
          }
          return count;
        };
        imports.runtime_window.surface_info = (_id: number, ptr: number) =>
          originalInfo(actualId, ptr);
      },
      initialize(context) {
        const exported = context.instance.exports.memory;
        if (exported instanceof WebAssembly.Memory) memory = exported;
        if (data.env.GPU_POISON !== "1") return;
        const buffers = receipts.concat(
          data.graphics?.surfaces.map((surface) => surface.info) ?? [],
          data.graphics ? [data.graphics.revocation] : [],
        );
        poison = poisonProcessIntrinsics(buffers);
      },
      beforeFinish() {
        if (!poison) return;
        const report = poison.restore();
        poison = undefined;
        send({ gpuAuthority: report, gpuAuthorityToken: data.env.GPU_AUTHORITY_TOKEN });
      },
    },
    embedding,
  );
};
