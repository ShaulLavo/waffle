// A worker's synchronous wasm call can prevent its newly created nested worker from starting.
// Start every child from the page instead. The page remains runnable while wasm waits on a pipe.
import type { SharedFilesystem } from "./shared-fs";
import { childTransport, type ChildTransport } from "./subprocess.js";
import type { RunRequest, SpawnRequest, WorkerMessage } from "./worker";

function active(transport: ChildTransport): boolean {
  const budget = new Int32Array(transport.budget);
  const state = Atomics.load(budget, transport.slot + 2);
  return state > 0 && Math.floor(state / 8) === transport.token;
}

export class SubprocessBroker {
  private disposed = false;
  private children = new Map<Worker, RunRequest>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private workerUrl: string, private filesystem: SharedFilesystem) {}

  spawn(spawn: SpawnRequest): void {
    if (this.disposed) { this.filesystem.revoke(spawn.filesystem); return; }
    this.reap();
    if (!spawn.child || !active(spawn.child)) { this.filesystem.revoke(spawn.filesystem); return; }
    const transport = childTransport(spawn.child);
    const control = new Int32Array(spawn.child.control, 0, 4);
    if (Atomics.load(control, 3)) { this.filesystem.revoke(spawn.filesystem); return; }
    // The runnable page creates the channel. A blocked creator guest cannot activate it in Firefox.
    const request: RunRequest = { ...spawn, filesystem: this.filesystem.connect(spawn.filesystem) };
    if (request.engine === "browser" && new URL(this.workerUrl).pathname.endsWith("/__bunwasm/worker.js")) request.moduleCache = `bunwasm-m-${crypto.randomUUID()}`;
    const worker = new Worker(this.workerUrl, { type: "module" });
    this.children.set(worker, request);
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      if (event.data.type === "spawn") this.spawn(event.data.request);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      transport.stderr.write(new TextEncoder().encode(`bun-wasm: child worker failed: ${event.message}\n`));
      transport.finish(1);
    };
    worker.postMessage(request, [request.filesystem.port]);
    this.watch();
  }

  private reap(): void {
    for (const [worker, request] of this.children) {
      if (!request.child) continue;
      const control = new Int32Array(request.child.control, 0, 4);
      if (!Atomics.load(control, 0) && !Atomics.load(control, 3) && active(request.child)) continue;
      worker.terminate();
      this.filesystem.revoke(request.filesystem);
      if (request.moduleCache) void caches.delete(request.moduleCache);
      this.children.delete(worker);
    }
  }

  private watch(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.reap();
      if (this.children.size) this.watch();
    }, 4);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    for (const [worker, request] of this.children) {
      worker.terminate();
      this.filesystem.revoke(request.filesystem);
      if (request.moduleCache) void caches.delete(request.moduleCache);
    }
    this.children.clear();
  }
}
