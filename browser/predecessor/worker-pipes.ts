import { SharedPipe } from "./subprocess.js";
import type { ChildTransport, SpawnMeta } from "./subprocess.js";

export function workerBuffers(meta: SpawnMeta) {
  if (!meta.worker) return [];
  return [new SharedArrayBuffer(16 + (1 << 20)), new SharedArrayBuffer(16 + (1 << 20))];
}

export class InheritedWorkerPipes {
  private readonly pipes: [SharedPipe, SharedPipe] | null;
  constructor(transport?: ChildTransport) {
    this.pipes = transport && transport.pipes.length === 5
      ? [new SharedPipe(transport.pipes[3], transport.budget), new SharedPipe(transport.pipes[4], transport.budget)] : null;
  }
  get active() { return this.pipes !== null; }
  handle(fd: number) { return this.pipes && fd >= 3 && fd <= 4 ? 0x7fff0000 + fd : -3; }
  owns(handle: number) { return this.pipes !== null && (handle === 0x7fff0003 || handle === 0x7fff0004); }
  read(handle: number, capacity?: number) { return handle === 0x7fff0003 ? this.pipes?.[0].read(capacity) ?? -3 : -3; }
  write(handle: number, bytes: Uint8Array) { return handle === 0x7fff0004 ? this.pipes?.[1].write(bytes) ?? -3 : -3; }
  close(handle: number) { this.pipes?.[handle === 0x7fff0003 ? 0 : 1].close(); return 0; }
}
