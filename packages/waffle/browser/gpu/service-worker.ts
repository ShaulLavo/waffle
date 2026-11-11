import { GpuService } from "./service.js";
import { attachServiceAccess } from "../display/service-readers.js";
import type { GpuServiceRequest, ServiceBootstrap } from "../display/service-protocol.js";

/** @browserEntry */
const host = globalThis as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<GpuServiceRequest | ServiceBootstrap>) => void) | null;
};
let service: GpuService | undefined;
host.onmessage = ({ data }) => {
  if (data.type === "bootstrap") {
    if (service) throw new Error("Duplicate GPU service bootstrap");
    const access = attachServiceAccess(data.readers);
    service = new GpuService((message) => host.postMessage(message), { access });
    return;
  }
  if (!service) throw new Error("GPU service request before bootstrap");
  service.receive(data);
};
