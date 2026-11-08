/** Each take transfers a fresh, single-use worker to its caller. */
export class ReadyWorkerPool {
  private disposed = false;

  isIdle(_worker: object): boolean {
    return false;
  }

  take(url: string): Worker {
    if (this.disposed) throw new Error("Worker pool is disposed");
    return new Worker(url, { type: "module" });
  }

  dispose(): void {
    this.disposed = true;
  }
}
