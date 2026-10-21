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
      const finish = () => {
        if (this.gates.get(gate) === release) this.gates.delete(gate);
        resolve();
      };
      const cancel = this.after(finish, 5000);
      const release = () => {
        cancel();
        finish();
      };
      this.gates.set(gate, release);
    });
  }
  release(gate: string): boolean {
    const release = this.gates.get(gate);
    release?.();
    return Boolean(release);
  }
}
