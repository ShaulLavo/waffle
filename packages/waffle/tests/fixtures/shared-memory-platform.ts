import { SharedMemoryLedger, declareSharedMemoryPlatform } from "../../memory/reservations.js";
/** Trusted desktop policy for deterministic unit tests, never a production default. */
export const testSharedMemory = declareSharedMemoryPlatform({ kind: "unbounded" });
export function testReservations() {
  return new SharedMemoryLedger(testSharedMemory).openRuntime(testSharedMemory);
}
