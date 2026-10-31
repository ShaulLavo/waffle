export {
  bytes,
  pages,
  declareSharedMemoryPlatform,
  measureSharedMemory,
  SharedMemoryAdmissionError,
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
} from "./reservations.js";
export { declareModuleMemory } from "./declarations.js";
export type { MemoryDeclaration } from "./declarations.js";
