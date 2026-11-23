import type { InterruptRewriteProfile } from "./rewriter-internal.js";
import {
  admittedModuleDiagnostics,
  compileInterruptible as compileInterruptibleInternal,
  InterruptModuleCache,
  type AdmittedModuleDiagnostics,
  type InterruptCompileOptions,
  type InterruptModuleCacheOptions,
} from "./loader-internal.js";

export {
  admittedModuleDiagnostics,
  InterruptModuleCache,
  type AdmittedModuleDiagnostics,
  type InterruptCompileOptions,
  type InterruptModuleCacheOptions,
};

/** Called through the existing lazy loader import, not on the synchronous spawn path. */
export function compileInterruptible(
  bytes: Uint8Array,
  profile: InterruptRewriteProfile = "ordinary",
  options?: InterruptCompileOptions,
): Promise<WebAssembly.Module> {
  return compileInterruptibleInternal(bytes, profile, options);
}

export { programStage } from "./admitted-store.js";
