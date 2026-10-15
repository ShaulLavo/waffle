// A worker's synchronous wasm call can prevent its newly created nested worker from starting.
// Start every child from the page instead. The page remains runnable while wasm waits on a pipe.
import { childTransport, type ChildTransport } from "./subprocess.js";
import type { RunRequest, WorkerMessage } from "./worker";

function active(transport: ChildTransport): boolean {
  const budget = new Int32Array(transport.budget);
  const state = Atomics.load(budget, transport.slot + 2);
  return state > 0 && Math.floor(state / 8) === transport.token;
}

export class SubprocessBroker {
  private disposed = false;
  private children = new Map<Worker, RunRequest>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private workerUrl: string) {}

  spawn(request: RunRequest): void {
    if (this.disposed) return;
    this.reap();
    if (!request.child || !active(request.child)) return;
    const transport = childTransport(request.child);
    const control = new Int32Array(request.child.control, 0, 4);
    if (Atomics.load(control, 3)) return;
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
    worker.postMessage(request);
    this.watch();
  }

  private reap(): void {
    for (const [worker, request] of this.children) {
      if (!request.child) continue;
      const control = new Int32Array(request.child.control, 0, 4);
      if (!Atomics.load(control, 0) && !Atomics.load(control, 3) && active(request.child)) continue;
      worker.terminate();
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
      if (request.moduleCache) void caches.delete(request.moduleCache);
    }
    this.children.clear();
  }
}
