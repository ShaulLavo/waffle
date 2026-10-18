import { expect, test } from "bun:test";
import { VfsError } from "../fs/vfs.js";
import { SharedFilesystem } from "../browser/shared-fs";

// The application, not the package's physical install path, owns worker URLs and workspace names.
test("page filesystem accepts a consumer-owned worker URL and storage namespace", async () => {
  const previous = globalThis.Worker;
  const messages: any[] = [];
  let script: string | URL | undefined;
  let terminated = 0;
  globalThis.Worker = class {
    constructor(url: string | URL) {
      script = url;
    }
    listener?: (event: MessageEvent) => void;
    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      if (type === "message") this.listener = listener;
    }
    postMessage(message: any) {
      messages.push(message);
      if (message.dispose)
        queueMicrotask(() =>
          this.listener?.({ data: { type: "filesystem-disposed" } } as MessageEvent),
        );
    }
    terminate() {
      terminated++;
    }
  } as unknown as typeof Worker;
  let fs: SharedFilesystem | undefined;
  try {
    fs = new SharedFilesystem({
      workerURL: "https://example.test/assets/filesystem.js",
      name: "editor-workspace",
      vfs: "opfs-memory",
    });
    expect(script).toBe("https://example.test/assets/filesystem.js");
    expect(messages[0]).toMatchObject({
      name: "editor-workspace",
      vfs: "opfs-memory",
      whenBusy: "wait",
    });
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
    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      if (type === "message") message = listener;
    }
    postMessage() {}
    terminate() {}
  } as unknown as typeof Worker;
  let fs: SharedFilesystem | undefined;
  try {
    fs = new SharedFilesystem({
      workerURL: "https://example.test/fs.js",
      vfs: "opfs-memory",
      onStateChange: (state) => {
        states.push(state.status);
      },
    });
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

test("page restores a worker's typed startup failure without losing its code", async () => {
  const previous = globalThis.Worker;
  let serverPort: MessagePort | undefined;
  let receive: ((event: MessageEvent) => void) | undefined;
  globalThis.Worker = class {
    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      if (type === "message") receive = listener;
    }
    postMessage(message: { connect?: { port: MessagePort } }) {
      serverPort = message.connect?.port;
    }
    terminate() {}
  } as unknown as typeof Worker;
  let fs: SharedFilesystem | undefined;
  try {
    fs = new SharedFilesystem({ workerURL: "https://example.test/fs.js" });
    const descriptor = fs.vfs;
    const operation = fs.listFiles().catch((error) => error);
    receive!({
      data: {
        type: "filesystem-error",
        name: "VfsError",
        code: "INVALID_VFS_FORMAT",
        vfs: "indexeddb",
        message: "Cannot recover established workspace",
        stack: "worker stack",
      },
    } as MessageEvent);
    const error = await operation;
    expect(error).toBeInstanceOf(VfsError);
    expect(error).toMatchObject({ code: "INVALID_VFS_FORMAT", vfs: "indexeddb" });
    expect(error.stack).toContain("worker stack");
    expect(fs.state).toMatchObject({ status: "failed", error });
    expect(fs.vfs).toBe(descriptor);
  } finally {
    await fs?.dispose();
    serverPort?.close();
    globalThis.Worker = previous;
  }
});
