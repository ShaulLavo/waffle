export {
  bytes,
  pages,
  declareSharedMemoryPlatform,
  measureSharedMemory,
  SharedMemoryAdmissionError,
  SharedMemoryMeasurementError,
} from "./reservations.js";
export type {
  ReservedBytes,
  WasmPages,
  CountedKinds,
  SharedMemoryPlatform,
  SharedMemorySnapshot,
  SharedMemoryRefusal,
  ProcessPlan,
  ProcessGuestPlan,
  SharedMemoryMeasureOptions,
  SharedMemoryObservation,
} from "./reservations.js";
export { declareModuleMemory } from "./declarations.js";
export type { MemoryDeclaration } from "./declarations.js";
export { createSharedControlAllocator } from "./control.js";
export type { SharedControlGrant } from "./control.js";
