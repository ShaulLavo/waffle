export {
  bytes,
  pages,
  declareSharedMemoryPlatform,
  SharedMemoryAdmissionError,
} from "./reservations.js";
export type {
  ReservedBytes,
  WasmPages,
  CountedKinds,
  SharedMemoryPlatform,
  SharedMemoryDeclaration,
  SharedMemorySnapshot,
  SharedMemoryRefusal,
  ProcessPlan,
  ProcessGuestPlan,
} from "./reservations.js";
export { declareModuleMemory } from "./declarations.js";
export type { MemoryDeclaration } from "./declarations.js";
export { createSharedControlAllocator } from "./control.js";
export type { SharedControlGrant } from "./control.js";
