import type { ServiceAccess } from "../display/service-readers.js";

/** Service-local lease. Sealing cannot erase an older frame's destination or locals. */
export class ConnectionAccess implements ServiceAccess {
  #live = true;
  #active = 0;
  constructor(private readonly service: ServiceAccess, private readonly wake: () => void) {}
  get active(): number { return this.#active; }
  get live(): boolean { return this.#live; }
  seal(): void { this.#live = false; }
  run(work: () => undefined): "ran" | "closed" {
    if (!this.#live) return "closed";
    let ran = false;
    this.service.run(() => {
      if (!this.#live) return undefined;
      ran = true;
      this.#active++;
      try { work(); }
      finally {
        this.#active--;
        if (!this.#live && this.#active === 0) this.wake();
      }
      return undefined;
    });
    return ran ? "ran" : "closed";
  }
}
export function accessed<T>(access: ServiceAccess, fallback: T, work: () => T): T {
  let result = fallback;
  access.run(() => { result = work(); return undefined; });
  return result;
}
