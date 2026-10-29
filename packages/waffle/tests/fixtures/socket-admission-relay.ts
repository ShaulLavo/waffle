import { captureRequestMemory, type FilesystemRequestMemory } from "../../fs/request-memory.js";

export interface SocketAdmissionObservation {
  readonly root: number;
  readonly capabilities: SharedArrayBuffer;
  readonly ownerStates: SharedArrayBuffer;
  readonly owner: number;
  readonly requests: FilesystemRequestMemory;
}
interface AdmissionTarget extends Omit<SocketAdmissionObservation, "root"> {
  readonly reply: MessagePort;
}
function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return;
  return Object.fromEntries(Object.entries(value));
}
function target(value: unknown): AdmissionTarget | undefined {
  const message = record(value);
  if (!(message?.reply instanceof MessagePort) || !message.socketScope) return;
  const connection = record(message.connect);
  if (
    !connection ||
    !(connection.capabilities instanceof SharedArrayBuffer) ||
    !(connection.ownerStates instanceof SharedArrayBuffer) ||
    typeof connection.owner !== "number"
  )
    throw new Error("Invalid socket admission target");
  return {
    reply: message.reply,
    capabilities: connection.capabilities,
    ownerStates: connection.ownerStates,
    owner: connection.owner,
    requests: captureRequestMemory(connection.requests),
  };
}
const NativeWorker = globalThis.Worker;
let active: SocketAdmissionRelay | undefined;
class RelayWorker extends NativeWorker {
  postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions): void {
    if (active?.intercept(this, message, transfer)) return;
    if (Array.isArray(transfer)) super.postMessage(message, transfer);
    else super.postMessage(message, transfer);
  }
}
function activate(relay: SocketAdmissionRelay): void {
  active = relay;
  globalThis.Worker = RelayWorker;
}
/** Test-only owner-control transport. It never changes filesystem service code. */
export class SocketAdmissionRelay {
  private readonly received = Promise.withResolvers<SocketAdmissionObservation>();
  readonly admitted = this.received.promise;
  private receiving: MessagePort | undefined;
  private forwarding: MessagePort | undefined;
  private sending: MessagePort | undefined;
  private pending: unknown;
  private used = false;
  install(): void {
    if (active) throw new Error("Socket relay already installed");
    activate(this);
  }
  intercept(
    worker: Worker,
    message: unknown,
    transfer?: Transferable[] | StructuredSerializeOptions,
  ): boolean {
    if (this.used) return false;
    const admission = target(message);
    if (!admission) return false;
    if (!Array.isArray(transfer)) throw new Error("Socket admission must transfer its reply port");
    this.used = true;
    const channel = new MessageChannel();
    this.receiving = channel.port1;
    this.sending = channel.port2;
    this.forwarding = admission.reply;
    channel.port1.onmessage = ({ data }: MessageEvent<unknown>) => {
      this.pending = data;
      const value = record(record(data)?.value);
      if (typeof value?.root !== "number") {
        this.received.reject(new Error("Socket admission failed"));
        return;
      }
      this.received.resolve({
        root: value.root,
        capabilities: admission.capabilities,
        ownerStates: admission.ownerStates,
        owner: admission.owner,
        requests: admission.requests,
      });
    };
    const original = record(message);
    if (!original) throw new Error("Socket admission message missing");
    Reflect.apply(NativeWorker.prototype.postMessage, worker, [
      { ...original, reply: channel.port2 },
      transfer.filter((port) => port !== admission.reply).concat([channel.port2]),
    ]);
    return true;
  }
  forward(): void {
    if (this.pending === undefined || !this.forwarding)
      throw new Error("No admitted reply to forward");
    this.forwarding.postMessage(this.pending);
    this.pending = undefined;
  }
  close(): void {
    this.receiving?.close();
    this.sending?.close();
    this.forwarding?.close();
    this.pending = undefined;
    if (active !== this) return;
    active = undefined;
    globalThis.Worker = NativeWorker;
  }
}
