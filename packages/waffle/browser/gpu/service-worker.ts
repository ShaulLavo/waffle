import { GpuService } from "./service.js";
import type { GpuServiceRequest } from "../display/protocol.js";

/** @browserEntry */
const host = globalThis as unknown as {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent<GpuServiceRequest>) => void) | null;
};
let service: GpuService | undefined;
host.onmessage = ({ data }: MessageEvent<GpuServiceRequest>) => {
  service ??= new GpuService((message) => host.postMessage(message));
  service.receive(data);
};
