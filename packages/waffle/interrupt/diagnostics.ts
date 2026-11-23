import type { InterruptRewriteProfile } from "./rewriter-internal.js";

/** Admission facts recorded only when opt-in symbol diagnostics are enabled. */
export interface AdmittedModuleDiagnostics {
  readonly sourceSha256: string;
  readonly admittedSha256: string;
  readonly profile: InterruptRewriteProfile;
  readonly originalImports: number;
  readonly originalDefinitions: number;
  readonly addedImports: number;
  readonly nonce: string;
}

const moduleDiagnostics = new WeakMap<WebAssembly.Module, AdmittedModuleDiagnostics>();

export function recordAdmittedModuleDiagnostics(
  module: WebAssembly.Module,
  diagnostics: AdmittedModuleDiagnostics,
): void {
  moduleDiagnostics.set(module, Object.freeze({ ...diagnostics }));
}

/** Return recorded admission diagnostics for a module compiled with opt-in diagnostics enabled. */
export function admittedModuleDiagnostics(
  module: WebAssembly.Module,
): AdmittedModuleDiagnostics | undefined {
  return moduleDiagnostics.get(module);
}
