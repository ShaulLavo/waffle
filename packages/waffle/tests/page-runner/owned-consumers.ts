import { bounded } from "./driver.js";

export class HostConsumers {
  private readonly pending = new Set<Promise<void>>();
  private readonly revokers = new Set<() => void>();
  invoke<T>(callback: () => T | PromiseLike<T>): Promise<T> {
    const result = Promise.withResolvers<T>();
    const settled = result.promise.then(
      () => {},
      () => {},
    );
    this.pending.add(settled);
    void settled.then(() => this.pending.delete(settled));
    try {
      result.resolve(callback());
    } catch (error) {
      result.reject(error);
    }
    return result.promise;
  }
  register(revoke: () => void): void {
    this.revokers.add(revoke);
  }
  revoke(): void {
    for (const revoke of this.revokers) revoke();
  }
  async join(ms: number): Promise<boolean> {
    this.revoke();
    try {
      await bounded(Promise.all(this.pending), ms, "host callback and command join");
      return this.pending.size === 0;
    } catch {
      return false;
    }
  }
}
