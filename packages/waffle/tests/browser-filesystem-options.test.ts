import { withVfsImplementation } from "../fs/vfs-internal.js";
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
    fs = new SharedFilesystem(
      withVfsImplementation("opfs-memory", {
        workerURL: "https://example.test/assets/filesystem.js",
        name: "editor-workspace",
        mode: "fast",
      }),
    );
    expect(script).toBe("https://example.test/assets/filesystem.js");
    expect(messages[0]).toMatchObject({
      name: "editor-workspace",
      mode: "fast",
      implementation: "opfs-memory",
      whenBusy: "wait",
    });
  } finally {
    await fs?.dispose();
    messages[0]?.connect.port.close();
    globalThis.Worker = previous;
  }
  expect(terminated).toBe(1);
});

test("page filesystem exposes typed waiting and ready state transitions", async () => {
  const previous = globalThis.Worker;
  let message: ((event: MessageEvent) => void) | undefined;
  let serverPort: MessagePort | undefined;
  let turn: MessageChannel | undefined;
  let fs: SharedFilesystem | undefined;
  let failure: { reason: unknown } | undefined;
  let requests = 0;
  let terminated = 0;
  const states: SharedFilesystem["state"]["status"][] = [];
  const cleanup = [
    async () => {
      const stopping = fs?.dispose();
      // Explicit fixture intervention releases the stand-in, not native storage.
      message?.(new MessageEvent("message", { data: { type: "filesystem-disposed" } }));
      await stopping;
    },
    () => fs?.client.dispose(),
    () => fs?.client.connection.port.close(),
    () => serverPort?.close(),
    () => turn?.port1.close(),
    () => turn?.port2.close(),
  ];
  const deliver = (data: unknown) => {
    if (!message) throw new Error("Filesystem Worker message listener was not installed");
    message(new MessageEvent("message", { data }));
  };
  try {
    Object.defineProperty(globalThis, "Worker", {
      value: class {
        addEventListener(type: string, listener: (event: MessageEvent) => void) {
          if (type === "message") message = listener;
        }
        postMessage(payload: { connect?: { port: MessagePort }; dispose?: boolean }) {
          serverPort ??= payload.connect?.port;
          if (payload.dispose) requests++;
        }
        terminate() {
          terminated++;
        }
      },
    });
    fs = new SharedFilesystem(
      withVfsImplementation("opfs-memory", {
        workerURL: "https://example.test/fs.js",
        mode: "fast",
        onStateChange: (state: SharedFilesystem["state"]) => {
          states.push(state.status);
        },
      }),
    );
    deliver({ type: "filesystem-state", status: "waiting" });
    expect(fs.state.status).toBe("waiting");
    deliver({ type: "filesystem-state", status: "ready" });
    expect(fs.state.status).toBe("ready");
    const stopping = fs.dispose();
    let settled = false;
    void stopping.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    expect(fs.dispose()).toBe(stopping);
    expect(requests).toBe(1);
    turn = new MessageChannel();
    const checkpoint = Promise.withResolvers<void>();
    turn.port1.onmessage = () => checkpoint.resolve();
    turn.port2.postMessage(null);
    await checkpoint.promise;
    expect(settled).toBe(false);
    expect(states).toEqual(["waiting", "ready"]);
    expect(fs.state.status).toBe("ready");
    expect(terminated).toBe(0);
    deliver({ type: "filesystem-disposed" });
    await stopping;
    expect(fs.dispose()).toBe(stopping);
    expect(states).toEqual(["waiting", "ready", "disposed"]);
    expect(fs.state.status).toBe("disposed");
    expect(requests).toBe(1);
    expect(terminated).toBe(1);
  } catch (reason) {
    failure = { reason };
  }
  try {
    const results = await Promise.allSettled(cleanup.map((run) => Promise.resolve().then(run)));
    if (failure) throw failure.reason;
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
  } finally {
    globalThis.Worker = previous;
  }
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
