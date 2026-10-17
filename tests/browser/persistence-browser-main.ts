import { SharedFilesystem, WORKSPACE_TAKEN_OVER, UNSAVED_CHANGES_LOST } from "../src/shared-fs";

let fs: SharedFilesystem | undefined;
let worker: Worker | undefined;
let next = 0;
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
const state = { commitStarted: false, boundary: undefined as string | undefined, partialWrite: false, progress: "idle", ownershipLost: false, ownershipMessage: "" };
function direct(command: string, args?: unknown): Promise<any> {
  if (!worker) {
    worker = new Worker("./persistence-browser-worker.js", { type: "module" });
    worker.onmessage = ({ data }) => {
      if (data.event === "persist-started") { state.commitStarted = true; state.boundary = data.boundary; state.partialWrite = data.partialWrite === true; return; }
      if (data.event === "progress") { state.progress = data.value; return; }
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      if (data.error) request.reject(new Error(data.error)); else request.resolve(data.value);
    };
    worker.onerror = event => {
      for (const request of pending.values()) request.reject(new Error(event.message));
      pending.clear();
    };
  }
  const id = ++next;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker!.postMessage({ id, command, args }); });
}
Object.assign(globalThis, {
  persistenceHarness: {
    state,
    async open(name: string, persistence = true, storage: "indexeddb" | "opfs" = "indexeddb") {
      fs?.dispose();
      state.ownershipLost = false; state.ownershipMessage = "";
      fs = new SharedFilesystem({ name, persistence, storage });
      fs.onOwnershipLost = () => {
        state.ownershipLost = true;
        state.ownershipMessage = `${WORKSPACE_TAKEN_OVER} ${UNSAVED_CHANGES_LOST}`;
      };
      await fs.flush();
    },
    async write(path: string, bytes: number[]) { await fs!.writeFile(path, Uint8Array.from(bytes)); },
    async move(from: string, to: string) { await fs!.move(from, to); },
    async remove(path: string) { return fs!.remove(path); },
    async mkdir(path: string) { await fs!.mkdirp(path); },
    async flush() { await fs!.flush(); },
    async snapshot() {
      const files = (await fs!.listFiles()).sort();
      return Promise.all(files.map(async path => ({ path, metadata: await fs!.lookup(path), bytes: Array.from((await fs!.readFile(path))!) })));
    },
    direct,
    async destroy() {
      fs?.dispose(); fs = undefined;
      if (worker) { await direct("close"); worker.terminate(); worker = undefined; }
    },
    async deleteDatabase(name: string, storage: "indexeddb" | "opfs" = "indexeddb") {
      await direct("deleteDatabase", { name, storage });
    },
  },
});
