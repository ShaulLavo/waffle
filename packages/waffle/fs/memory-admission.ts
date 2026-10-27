import { MemoryBudgetError, type MemoryAdmission, type MemoryLease } from "./memory-budget.js";

export function admittedLease(admission: MemoryAdmission): MemoryLease {
  switch (admission.kind) {
    case "granted":
      return admission.lease;
    case "pressure":
    case "impossible":
      throw new MemoryBudgetError("capacity");
    case "exhausted":
      throw new MemoryBudgetError("serial");
    case "stopped":
      throw new MemoryBudgetError("closed");
    default: {
      const exhaustive: never = admission;
      return exhaustive;
    }
  }
}
