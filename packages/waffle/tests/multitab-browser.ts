import { SharedFilesystem } from "../browser/shared-fs.js";
import { openIdleWorkspace, deleteWorkspace } from "../fs/idle-workspace.js";
import { withVfsImplementation } from "../fs/vfs-internal.js";
import type { FilesystemWatch } from "../fs/watch.js";
import type { VfsWhenBusy } from "../fs/vfs.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface TabHandle {
  fs: SharedFilesystem;
  states: string[];
  ownershipLost: boolean;
  watches: Map<number, FilesystemWatch>;
  nextWatchId: number;
}

const tabs = new Map<number, TabHandle>();
let nextTabId = 1;

async function waitForReady(handle: TabHandle, timeoutMs = 30000): Promise<void> {
  if (handle.fs.state.status === "ready") return;
  if (handle.fs.state.status === "failed") throw handle.fs.state.error ?? new Error("fs failed");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for ready (status=${handle.fs.state.status})`));
    }, timeoutMs);
    const prev = handle.fs.onStateChange;
    handle.fs.onStateChange = (state) => {
      prev?.(state);
      if (state.status === "ready") {
        clearTimeout(timer);
        resolve();
      } else if (state.status === "failed") {
        clearTimeout(timer);
        reject(state.error ?? new Error("fs failed"));
      }
    };
  });
}

const api = {
  async open(options: {
    name: string;
    whenBusy?: VfsWhenBusy;
    implementation?: "indexeddb" | "opfs-memory";
    waitReady?: boolean;
    workerURL?: string;
  }) {
    const id = nextTabId++;
    const states: string[] = [];
    const baseOpts = {
      mode: "fast" as const,
      name: options.name,
      whenBusy: options.whenBusy ?? ("attach" as const),
      workerURL: options.workerURL ?? "/fs-worker.js",
      onStateChange: (s: { status: string }) => {
        states.push(s.status);
      },
    };
    const fsOptions = options.implementation
      ? withVfsImplementation(options.implementation, baseOpts)
      : baseOpts;
    const fs = new SharedFilesystem(fsOptions);
    const handle: TabHandle = {
      fs,
      states,
      ownershipLost: false,
      watches: new Map(),
      nextWatchId: 1,
    };
    fs.onOwnershipLost = () => {
      handle.ownershipLost = true;
    };
    tabs.set(id, handle);
    if (options.waitReady !== false) {
      await waitForReady(handle);
    }
    return {
      id,
      status: fs.state.status,
      multiTab: fs.vfs.multiTab,
      directSharedMemory: fs.vfs.directSharedMemory,
    };
  },

  state(id: number) {
    const h = tabs.get(id)!;
    return {
      status: h.fs.state.status,
      states: h.states.slice(),
      ownershipLost: h.ownershipLost || h.fs.ownershipLost,
      error: h.fs.state.error?.message,
    };
  },

  async writeFile(id: number, path: string, text: string) {
    await tabs.get(id)!.fs.writeFile(path, text);
  },

  async writeBinary(id: number, path: string, byteLength: number, seed: number) {
    const bytes = new Uint8Array(byteLength);
    for (let i = 0; i < byteLength; i += 4096) bytes[i] = (i / 4096 + seed) & 0xff;
    bytes[byteLength - 1] = seed & 0xff;
    await tabs.get(id)!.fs.writeFile(path, bytes);
  },

  async readFileText(id: number, path: string): Promise<string | null> {
    const bytes = await tabs.get(id)!.fs.readFile(path);
    return bytes ? decoder.decode(bytes) : null;
  },

  async readBinarySummary(id: number, path: string) {
    const bytes = await tabs.get(id)!.fs.readFile(path);
    if (!bytes) return null;
    return {
      byteLength: bytes.byteLength,
      first: bytes[0],
      mid: bytes[4096],
      last: bytes[bytes.byteLength - 1],
    };
  },

  async mkdirp(id: number, path: string) {
    await tabs.get(id)!.fs.mkdirp(path);
  },

  async move(id: number, from: string, to: string) {
    await tabs.get(id)!.fs.move(from, to);
  },

  async remove(id: number, path: string, ifContent?: string) {
    if (ifContent !== undefined) {
      return tabs.get(id)!.fs.remove(path, { ifContent: encoder.encode(ifContent) });
    }
    return tabs.get(id)!.fs.remove(path);
  },

  async listFiles(id: number, prefix = "/") {
    return tabs.get(id)!.fs.listFiles(prefix);
  },

  async flush(id: number, path?: string) {
    await tabs.get(id)!.fs.flush(path);
  },

  async checkNonBlocking(id: number, path: string) {
    const fs = tabs.get(id)!.fs;
    const root: number = await fs.client.asyncCall("preopen", ["/"]);
    const resolved = await fs.client.asyncCall("resolve", [root, path.replace(/^\/+/, ""), true]);
    if (typeof resolved === "number" || resolved.node === undefined) {
      throw new Error(`resolve failed for ${path}`);
    }
    const buf = new Uint8Array(8);
    return {
      tryRead: fs.client.tryRead(resolved.node, [buf], 0),
      tryWrite: fs.client.tryWrite(resolved.node, [buf], 0),
      tryAppend: fs.client.tryAppend(resolved.node, [buf]),
      readiness: fs.client.ioReadiness(resolved.node, false),
    };
  },

  async runWorkerRedirection(id: number, seedText?: string) {
    const fs = tabs.get(id)!.fs;
    const connection = fs.fork();
    const worker = new Worker("/fd-conformance-worker.js", { type: "module" });
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("fd conformance worker timed out")), 30000);
        worker.onerror = (event) => {
          clearTimeout(timer);
          reject(new Error(event.message || "fd conformance worker error"));
        };
        worker.onmessage = ({ data }: MessageEvent<{ value?: unknown; error?: string }>) => {
          clearTimeout(timer);
          if (data.error) reject(new Error(data.error));
          else resolve(data.value);
        };
        worker.postMessage({ scenario: "proc-redirection", connection, seedText }, [
          connection.port,
        ]);
      });
    } finally {
      worker.terminate();
    }
  },

  async openWatch(id: number, path: string, recursive: boolean) {
    const h = tabs.get(id)!;
    const root: number = await h.fs.client.asyncCall("preopen", ["/"]);
    const resolved = await h.fs.client.asyncCall("resolve", [
      root,
      path.replace(/^\/+/, "") || ".",
      true,
    ]);
    if (typeof resolved === "number" || resolved.node === undefined) {
      throw new Error(`resolve failed for watch ${path}`);
    }
    const watcher = await h.fs.client.watch(resolved.node, { recursive });
    const wid = h.nextWatchId++;
    h.watches.set(wid, watcher);
    return wid;
  },

  async nextWatch(id: number, wid: number, timeoutMs = 20000) {
    const watcher = tabs.get(id)!.watches.get(wid)!;
    return Promise.race([
      watcher.next().then((batch) => ({
        kind: batch.kind,
        names: batch.events.map((e) => e.name),
      })),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("nextWatch timed out")), timeoutMs),
      ),
    ]);
  },

  async closeWatch(id: number, wid: number) {
    const h = tabs.get(id)!;
    const w = h.watches.get(wid);
    h.watches.delete(wid);
    if (w) await w.close();
  },

  async dispose(id: number) {
    const h = tabs.get(id);
    if (!h) return;
    tabs.delete(id);
    await h.fs.dispose();
  },

  async openIdleStatus(name: string) {
    const res = await openIdleWorkspace({ mode: "fast", name });
    if (typeof res === "string") return res;
    const files = await res.listFiles("/");
    await res.close();
    return { status: "opened", files };
  },

  async deleteWsStatus(name: string) {
    return deleteWorkspace({ mode: "fast", name });
  },

  async measureLegacyOpen(name: string) {
    const start = performance.now();
    const fs = new SharedFilesystem({
      mode: "fast",
      name,
      whenBusy: "takeover",
      workerURL: "/fs-worker.js",
    });
    const h: TabHandle = {
      fs,
      states: [],
      ownershipLost: false,
      watches: new Map(),
      nextWatchId: 1,
    };
    await waitForReady(h);
    const ms = performance.now() - start;
    await fs.dispose();
    return ms;
  },
};

Object.assign(globalThis, { multitabTest: api });
