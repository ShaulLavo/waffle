import type { SharedControlGrant } from "../memory/control.js";
import type { FilesystemConnection } from "../fs/protocol.js";
import type { WorkerProcessTransport } from "../proc/worker-client.js";
import type { CallKey, ThreadOperation, ThreadResult } from "./protocol.js";

export interface ThreadServiceRequest {
  readonly kind: "thread-service";
  readonly directory: string;
  readonly pid: number;
  readonly memory: WebAssembly.Memory;
  readonly filesystem: FilesystemConnection;
  readonly transport: WorkerProcessTransport;
  readonly controlGrant: SharedControlGrant;
}
export type ThreadServiceCommand =
  | ThreadServiceRequest
  | { kind: "call"; call: CallKey; request: ThreadOperation; id: number }
  | { kind: "drain" | "dispose"; id: number };
export type ThreadServiceEvent =
  | { kind: "service-ready" }
  | { kind: "result"; id: number; result: ThreadResult }
  | { kind: "drained" | "disposed"; id: number }
  | { kind: "service-error"; message: string }
  | { kind: "control-allocation"; buffer: SharedArrayBuffer };
export interface ThreadLaunchOptions {
  readonly serviceWorkerUrl: string;
  readonly guestWorkerUrl: string;
}
export interface ThreadAggregate {
  terminal(): void;
  fence(): Promise<void>;
  stop(): Promise<void>;
}
