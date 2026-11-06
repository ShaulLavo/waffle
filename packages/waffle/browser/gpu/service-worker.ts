import { GpuService } from "./service.js";
import type { GpuServiceRequest } from "../display/protocol.js";

/** @browserEntry */
const host = globalThis as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<GpuServiceRequest>) => void) | null;
};
const service = new GpuService((message) => host.postMessage(message));
host.onmessage = ({ data }: MessageEvent<GpuServiceRequest>) => service.receive(data);
