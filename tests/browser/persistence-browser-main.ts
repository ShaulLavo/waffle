import { SharedFilesystem } from "../src/shared-fs";

let fs: SharedFilesystem | undefined;
let worker: Worker | undefined;
let next = 0;
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
const state = { commitStarted: false, progress: "idle" };
function direct(command: string, args?: unknown): Promise<any> {
  if (!worker) {
    worker = new Worker("./persistence-browser-worker.js", { type: "module" });
    worker.onmessage = ({ data }) => {
      if (data.event === "persist-started") { state.commitStarted = true; return; }
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
    async open(name: string, persistence = true) {
      fs?.dispose();
      fs = new SharedFilesystem({ name, persistence });
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
    async deleteDatabase(name: string) {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error(`Cleanup blocked for ${name}`));
      });
    },
  },
});
