import { normalize } from "../core/path.js";

/** Process-local WASI names must be resolved by the original descriptor-aware launcher. */
export function supportsSearchOperands(operands: readonly string[], cwd: string): boolean {
  return operands.every((operand) => {
    const path = normalize(operand, cwd);
    return (
      path !== "/dev" && !path.startsWith("/dev/") && path !== "/proc" && !path.startsWith("/proc/")
    );
  });
}
