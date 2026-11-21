import type { RuntimeWorkerRequest } from "../worker.js";

export interface OperationBinding {
  readonly buffer: SharedArrayBuffer;
  readonly slot: number;
  readonly captureId: number;
}

export interface GuestOperationBinding extends OperationBinding {
  readonly origin: number;
}

export type ObservedPreview1Bootstrap = [
  request: RuntimeWorkerRequest,
  operations: GuestOperationBinding,
];
