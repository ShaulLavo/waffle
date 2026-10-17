import { expect, test } from "bun:test";
import { SharedFilesystem } from "../browser/shared-fs";

// The application, not the package's physical install path, owns worker URLs and workspace names.
test("page filesystem accepts a consumer-owned worker URL and storage namespace", () => {
  const previous = globalThis.Worker;
  const messages: any[] = [];
  let script: string | URL | undefined;
  let terminated = 0;
  globalThis.Worker = class {
    constructor(url: string | URL) { script = url; }
    addEventListener() {}
    postMessage(message: any) { messages.push(message); }
    terminate() { terminated++; }
  } as unknown as typeof Worker;
  let fs: SharedFilesystem | undefined;
  try {
    fs = new SharedFilesystem({ workerURL: "https://example.test/assets/filesystem.js", name: "editor-workspace", storage: "opfs" });
    expect(script).toBe("https://example.test/assets/filesystem.js");
    expect(messages[0]).toMatchObject({ name: "editor-workspace", persistence: true, storage: "opfs" });
  } finally {
    fs?.dispose();
    messages[0]?.connect.port.close();
    globalThis.Worker = previous;
  }
  expect(terminated).toBe(1);
});
