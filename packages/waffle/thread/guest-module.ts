import { compileInterruptible } from "../interrupt/loader.ts";

/** Internal trusted embedding. Ordinary admission deliberately continues rejecting raw waits. */
export function compileThreadGuest(source: Uint8Array): Promise<WebAssembly.Module> {
  return compileInterruptible(source, "supervised-thread");
}
