export type Schedule = (callback: () => void, milliseconds: number) => () => void;
const schedule: Schedule = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds);
  return () => clearTimeout(timer);
};
export class ParkingGates {
  readonly gates = new Map<string, () => void>();
  constructor(private readonly after: Schedule = schedule) {}
  park(gate: string): Promise<void> {
    return new Promise((resolve) => {
      const cancel = this.after(() => {
        this.gates.delete(gate);
        resolve();
      }, 5000);
      this.gates.set(gate, () => {
        cancel();
        this.gates.delete(gate);
        resolve();
      });
    });
  }
  release(gate: string): boolean {
    const release = this.gates.get(gate);
    release?.();
    return Boolean(release);
  }
}
