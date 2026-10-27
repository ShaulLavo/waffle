/** Workers are reserved before their first request and are never returned after use. */
export class ReadyWorkerPool {
  private readonly idle: { url: string; worker: Worker }[] = [];
  private pending?: ReturnType<typeof setTimeout>;
  private disposed = false;

  isIdle(worker: object): boolean {
    for (let index = 0; index < this.idle.length; index++) {
      if (this.idle[index]?.worker === worker) return true;
    }
    return false;
  }

  take(url: string): Worker {
    if (this.disposed) throw new Error("Worker pool is disposed");
    const index = this.idle.findIndex((entry) => entry.url === url);
    const entry = index < 0 ? undefined : this.idle.splice(index, 1)[0];
    const worker = entry?.worker ?? new Worker(url, { type: "module" });
    worker.onmessage = null;
    worker.onerror = null;
    if (this.pending !== undefined) clearTimeout(this.pending);
    this.pending = setTimeout(() => this.replenish(url), 0);
    return worker;
  }

  dispose(): void {
    this.disposed = true;
    if (this.pending !== undefined) clearTimeout(this.pending);
    this.pending = undefined;
    for (const { worker } of this.idle.splice(0)) this.stop(worker);
  }

  private stop(worker: Worker): void {
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
  }

  private discard(worker: Worker): void {
    const index = this.idle.findIndex((entry) => entry.worker === worker);
    if (index < 0) return;
    this.idle.splice(index, 1);
    this.stop(worker);
  }

  private replenish(url: string): void {
    this.pending = undefined;
    if (this.disposed) return;
    for (const entry of this.idle.slice()) {
      if (entry.url !== url) this.discard(entry.worker);
    }
    try {
      while (this.idle.length < 2) this.prepare(url);
    } catch {
      // Speculation cannot fail an admitted process. The next demand retries construction.
    }
  }

  private prepare(url: string): void {
    const worker = new Worker(url, { type: "module" });
    this.idle.push({ url, worker });
    worker.onerror = (event) => {
      event.preventDefault();
      this.discard(worker);
    };
    // A process worker must remain inert until its request. Never lease one that spoke early.
    worker.onmessage = () => this.discard(worker);
  }
}
