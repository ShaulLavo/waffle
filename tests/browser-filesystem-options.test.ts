import { expect, test } from "bun:test";
import { SharedFilesystem } from "../browser/shared-fs";

// The application, not the package's physical install path, owns worker URLs and workspace names.
test("page filesystem accepts a consumer-owned worker URL and storage namespace", async () => {
  const previous = globalThis.Worker;
  const messages: any[] = [];
  let script: string | URL | undefined;
  let terminated = 0;
  globalThis.Worker = class {
    constructor(url: string | URL) { script = url; }
    listener?: (event: MessageEvent) => void;
    addEventListener(type: string, listener: (event: MessageEvent) => void) { if (type === "message") this.listener = listener; }
    postMessage(message: any) {
      messages.push(message);
      if (message.dispose) queueMicrotask(() => this.listener?.({ data: { type: "filesystem-disposed" } } as MessageEvent));
    }
    terminate() { terminated++; }
  } as unknown as typeof Worker;
  let fs: SharedFilesystem | undefined;
  try {
    fs = new SharedFilesystem({ workerURL: "https://example.test/assets/filesystem.js", name: "editor-workspace", storage: "opfs" });
    expect(script).toBe("https://example.test/assets/filesystem.js");
    expect(messages[0]).toMatchObject({ name: "editor-workspace", persistence: true, storage: "opfs" });
  } finally {
    await fs?.dispose();
    messages[0]?.connect.port.close();
    globalThis.Worker = previous;
  }
  expect(terminated).toBe(1);
});


test("page filesystem exposes typed waiting and ready state transitions", () => {
  const previous = globalThis.Worker;
  let message: ((event: MessageEvent) => void) | undefined;
  const states: string[] = [];
  globalThis.Worker = class {
    constructor() {}
    addEventListener(type: string, listener: (event: MessageEvent) => void) { if (type === "message") message = listener; }
    postMessage() {}
    terminate() {}
  } as unknown as typeof Worker;
  let fs: SharedFilesystem | undefined;
  try {
    fs = new SharedFilesystem({ workerURL: "https://example.test/fs.js", storage: "opfs", onStateChange: state => { states.push(state.status); } });
    message!({ data: { type: "filesystem-state", status: "waiting" } } as MessageEvent);
    expect(fs.state.status).toBe("waiting");
    message!({ data: { type: "filesystem-state", status: "ready" } } as MessageEvent);
    expect(fs.state.status).toBe("ready");
  } finally {
    fs?.dispose();
    globalThis.Worker = previous;
  }
  expect(states).toEqual(["waiting", "ready", "disposed"]);
});
