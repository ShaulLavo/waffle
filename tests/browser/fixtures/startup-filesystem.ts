import { SharedFilesystem as Filesystem } from "../../src/shared-fs";
export * from "../../src/shared-fs";

const pause = new URLSearchParams(location.search).has("pause-startup") && !sessionStorage.getItem("startup-paused");
const state = { paused: false, resume: () => {} };
Object.assign(globalThis, { startupFilesystem: state });

export class SharedFilesystem extends Filesystem {
  override async mkdirp(path: string): Promise<void> {
    await super.mkdirp(path);
    if (!pause || path !== "/tmp") return;
    sessionStorage.setItem("startup-paused", "1");
    state.paused = true;
    await new Promise<void>(resolve => { state.resume = resolve; });
    await this.flush();
  }
}
