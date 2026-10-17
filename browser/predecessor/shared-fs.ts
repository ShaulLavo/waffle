import { SharedFilesystem as RuntimeFilesystem, type SharedFilesystemOptions } from "@bun-wasm/runtime/browser/shared-fs";
export type { Entry, SharedFilesystemOptions } from "@bun-wasm/runtime/browser/shared-fs";

/** Bun owns its existing persistence namespace; the runtime supplies the filesystem service. */
export class SharedFilesystem extends RuntimeFilesystem {
  constructor(options: SharedFilesystemOptions = {}) {
    super({ ...options, name: options.name ?? "bun-wasm-workspace" });
  }
}
