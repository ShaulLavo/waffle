// A gate that animation loops wait on. It is open only while nothing closes it: the visitor's
// pause, the section scrolling out of view, or the tab being hidden. A closed gate costs no timers.

export class Gate {
  #closed = new Set<string>();
  #waiters: (() => void)[] = [];
  #listeners: ((open: boolean) => void)[] = [];

  get open(): boolean {
    return this.#closed.size === 0;
  }

  set(reason: string, closed: boolean): void {
    const was = this.open;
    if (closed) this.#closed.add(reason);
    else this.#closed.delete(reason);
    if (was === this.open) return;
    for (const listener of this.#listeners) listener(this.open);
    if (this.open) this.#release();
  }

  onChange(listener: (open: boolean) => void): void {
    this.#listeners.push(listener);
  }

  /** Resolves at once while open, otherwise when the gate next opens. */
  wait(): Promise<void> {
    if (this.open) return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  /** Waits `ms`, then for the gate. */
  async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    await this.wait();
  }

  #release(): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) resolve();
  }
}

/** Closes the gate while `element` is off screen or the tab is hidden. */
export function gateOnView(gate: Gate, element: Element, threshold: number): void {
  // Closed until the observer's first report, which arrives within a frame.
  gate.set("offscreen", true);
  const observer = new IntersectionObserver(
    ([entry]) => gate.set("offscreen", !entry?.isIntersecting),
    { threshold },
  );
  observer.observe(element);
  const sync = () => gate.set("hidden", document.hidden);
  document.addEventListener("visibilitychange", sync);
  sync();
}
