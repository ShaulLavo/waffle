import { MemoryBudget } from "../../fs/memory-budget";

export function residentMemory(): MemoryBudget {
  return new MemoryBudget({
    bytes: 64 * 1024 * 1024,
    producers: { allocations: 128, references: 256, leases: 16 },
    progress: { bytes: 0, allocations: 0, references: 0, leases: 0 },
    waiters: 0,
    serialLimit: Number.MAX_SAFE_INTEGER,
  });
}
