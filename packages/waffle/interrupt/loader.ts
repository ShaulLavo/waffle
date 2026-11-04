import type { InterruptRewriteProfile } from "./rewriter-internal.js";
import {
  compileInterruptible as compileInterruptibleInternal,
  InterruptModuleCache,
} from "./loader-internal.js";

export { InterruptModuleCache };

/** Called through the existing lazy loader import, not on the synchronous spawn path. */
export function compileInterruptible(
  bytes: Uint8Array,
  profile: InterruptRewriteProfile = "ordinary",
): Promise<WebAssembly.Module> {
  return compileInterruptibleInternal(bytes, profile);
}

export { programStage } from "./admitted-store.js";
