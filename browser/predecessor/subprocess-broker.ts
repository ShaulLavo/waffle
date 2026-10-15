// A worker's synchronous wasm call can prevent its newly created nested worker from starting.
// Start every child from the page instead. The page remains runnable while wasm waits on a pipe.
import { childTransport, MAX_CHILDREN, type ChildTransport } from "./subprocess.js";
import type { RunRequest, WorkerMessage } from "./worker";

function active(transport: ChildTransport): boolean {
  const budget = new Int32Array(transport.budget);
  return Atomics.load(budget, transport.slot + 2) > 0 && Atomics.load(budget, transport.slot + 2 + MAX_CHILDREN) === transport.token;
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
    for (const worker of this.children.keys()) worker.terminate();
    this.children.clear();
  }
}
