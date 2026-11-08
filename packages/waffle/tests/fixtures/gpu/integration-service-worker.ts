import {
  attachServiceAccess,
  type ServiceAccess,
} from "../../../browser/display/service-readers.js";
import { installFairnessObserver } from "./fairness-observer.js";
import { GpuService } from "../../../browser/gpu/service.js";
import type {
  GpuServiceRequest,
  ServiceBootstrap,
} from "../../../browser/display/service-protocol.js";
import { pressureBurst } from "./qualification-contract.js";
const host = globalThis as unknown as {
  postMessage(message: unknown): void;
  onmessage: (
    event: MessageEvent<GpuServiceRequest | ServiceBootstrap | { test: string; id: string }>,
  ) => void;
};
const params = new URL(location.href).searchParams;
const hold = params.get("hold");
const desktopCaps = hold === "desktop-on" ? "on" : hold === "desktop-off" ? "off" : undefined;
const fairness = desktopCaps
  ? installFairnessObserver({ caps: desktopCaps, blobThreshold: 400000 })
  : hold === "fairness"
    ? installFairnessObserver()
    : undefined;
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
let service: GpuService;
function createService(access: ServiceAccess) {
  return new GpuService((message) => host.postMessage(message), {
    access: access,
    root,
    suppressTransfer: params.get("suppress") === "1",
  });
}

const snapshot = () => ({
  ...service.snapshot(),
  held,
  lateCreated,
  lateDestroyed,
  fairness: fairness?.snapshot(),
  desktopCaps,
});
function armFairness(id: string): void {
  try {
    const coverage = fairness?.arm();
    host.postMessage({ testId: id, gpuSnapshot: { ...snapshot(), coverage } });
  } catch (error) {
    host.postMessage({ testId: id, gpuSnapshot: { observerError: String(error) } });
  }
}
function releaseGate(): void {
  gate.resolve();
  if (!delayedOpen) return;
  service.receive(delayedOpen);
  delayedOpen = undefined;
}
async function testCommand(data: { test: string; id: string }): Promise<void> {
  if (data.test === "fairness-arm") return armFairness(data.id);
  if (data.test === "fairness-settled") await fairness?.settled();
  if (data.test === "pressure") pressureBurst();
  if (data.test === "release") releaseGate();
  host.postMessage({ testId: data.id, gpuSnapshot: snapshot() });
}
host.onmessage = ({ data }) => {
  if (!("test" in data) && data.type === "bootstrap") {
    if (service) throw new Error("Duplicate fixture GPU bootstrap");
    service = createService(attachServiceAccess(data.readers));
    return;
  }
  if (!service) throw new Error("Fixture request before GPU bootstrap");
  if ("test" in data) {
    void testCommand(data);
    return;
  }
  if (hold === "open" && data.type === "open" && !held) {
    held = "open";
    delayedOpen = data;
  } else service.receive(data);
  host.postMessage({ gpuSnapshot: snapshot() });
};
