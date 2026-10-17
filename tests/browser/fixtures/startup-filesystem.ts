import { SharedFilesystem as Filesystem } from "@bun-wasm/runtime/browser/shared-fs";
export * from "@bun-wasm/runtime/browser/shared-fs";

const pause = new URLSearchParams(location.search).has("pause-startup") && !sessionStorage.getItem("startup-paused");
let writesUntilFailure: number | undefined;
const state = { paused: false, resume: () => {}, failWriteAfter: (count: number) => { writesUntilFailure = count; } };
Object.assign(globalThis, { startupFilesystem: state });

export class SharedFilesystem extends Filesystem {
  // Fault the real owner: page capabilities deliberately cannot be monkey-patched.
  override async writeFile(path: string, text: string | Uint8Array, append = false): Promise<void> {
    if (writesUntilFailure !== undefined && --writesUntilFailure === 0) {
      writesUntilFailure = undefined;
      throw new Error("interrupted reset");
    }
    await super.writeFile(path, text, append);
  }
  override async mkdirp(path: string): Promise<void> {
    await super.mkdirp(path);
    if (!pause || path !== "/tmp") return;
    sessionStorage.setItem("startup-paused", "1");
    state.paused = true;
    await new Promise<void>(resolve => { state.resume = resolve; });
    await this.flush();
  }
}
