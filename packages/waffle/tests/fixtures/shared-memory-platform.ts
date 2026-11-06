import { SharedMemoryLedger, declareSharedMemoryPlatform } from "../../memory/reservations.js";
/** Explicit unbounded declaration for deterministic ledger unit tests. */
export const testSharedMemory = declareSharedMemoryPlatform({ kind: "unbounded" });
export function testReservations() {
  return new SharedMemoryLedger(testSharedMemory).openRuntime(testSharedMemory);
}
