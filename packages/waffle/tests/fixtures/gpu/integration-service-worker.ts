import { GpuService } from "../../../browser/gpu/service.js";
import type { GpuServiceRequest } from "../../../browser/display/protocol.js";
import { pressureBurst } from "./qualification-contract.js";
const host = globalThis as unknown as {
  postMessage(message: unknown): void;
  onmessage: (event: MessageEvent<GpuServiceRequest | { test: string; id: string }>) => void;
};
const params = new URL(location.href).searchParams;
const hold = params.get("hold");
const gate = Promise.withResolvers<void>();
let held: string | undefined;
let delayedOpen: Extract<GpuServiceRequest, { type: "open" }> | undefined;
let lateCreated = 0,
  lateDestroyed = 0;
const nativeGpu = navigator.gpu;
const root =
  hold === "adapter" || hold === "device"
    ? {
        async requestAdapter(options?: GPURequestAdapterOptions) {
          const adapter = await nativeGpu.requestAdapter(options);
          if (!adapter) return null;
          if (hold === "adapter") {
            held = "adapter";
            await gate.promise;
          }
          return {
            async requestDevice(descriptor?: GPUDeviceDescriptor) {
              const device = await adapter.requestDevice(descriptor);
              lateCreated++;
              void device.lost.then(() => {
                lateDestroyed++;
              });
              if (hold === "device") {
                held = "device";
                await gate.promise;
              }
              return device;
            },
          };
        },
      }
    : undefined;
const service = new GpuService((message) => host.postMessage(message), {
  root,
  suppressTransfer: params.get("suppress") === "1",
});
const snapshot = () => ({ ...service.snapshot(), held, lateCreated, lateDestroyed });
host.onmessage = ({ data }) => {
  if ("test" in data) {
    if (data.test === "pressure") pressureBurst();
    if (data.test === "release") {
      gate.resolve();
      if (delayedOpen) {
        service.receive(delayedOpen);
        delayedOpen = undefined;
      }
    }
    host.postMessage({ testId: data.id, gpuSnapshot: snapshot() });
    return;
  }
  if (hold === "open" && data.type === "open" && !held) {
    held = "open";
    delayedOpen = data;
  } else service.receive(data);
  host.postMessage({ gpuSnapshot: snapshot() });
};
