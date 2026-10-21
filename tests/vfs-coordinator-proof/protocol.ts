import type { DirNode } from "../../fs/memory.js";

export type Arm = "fenced-safe" | "fenced-fast" | "volatile-fast";
export type Actor = "host" | "guest" | "tool";
export type Operation =
  | { kind: "write"; path: string; text: string }
  | { kind: "append"; path: string; text: string }
  | { kind: "rename"; from: string; to: string }
  | { kind: "read"; path: string }
  | { kind: "snapshot" }
  | { kind: "changes"; history: string; after: number }
  | { kind: "status"; key: string }
  | { kind: "checkpoint" }
  | { kind: "guest"; method: string; args: unknown[]; bytes: number[] };
export interface Request {
  client: string;
  sequence: number;
  epoch: number;
  history: string;
  actor: Actor;
  operation: Operation;
  expiresAt?: number;
  gate?: string;
  replyGate?: string;
  dropReply?: boolean;
  dropNudge?: boolean;
}
export interface Cursor {
  epoch: number;
  history: string;
  generation: number;
  watermark: number;
  durableWatermark: number;
}
export interface Change extends Cursor {
  key: string;
  actor: Actor;
  operation: Operation;
}
export interface Receipt extends Cursor {
  key: string;
  fingerprint: string;
  result: unknown;
}
export interface State extends Cursor {
  format: "waffle-e5-proof-only";
  arm: Arm;
  token: string;
  closed: boolean;
  root: DirNode;
  versions: Map<number, number>;
  receipts: Map<string, Receipt>;
  changes: Change[];
}
export type Reply =
  | { kind: "ok"; cursor: Cursor; result: unknown }
  | { kind: "error"; code: string; message: string };
export type Command =
  | {
      kind: "initialize";
      workspace: string;
      arm: Arm;
      token: string;
      expected: number;
      attempt: string;
    }
  | { kind: "cancel-initialize"; attempt: string }
  | { kind: "request"; request: Request }
  | { kind: "release"; gate: string }
  | { kind: "inspect" }
  | { kind: "close" }
  | { kind: "die" }
  | { kind: "replace-instance" }
  | { kind: "drain-instance" };
export interface Envelope {
  id: number;
  command: Command;
}
export function cursor(state: Cursor): Cursor {
  return {
    epoch: state.epoch,
    history: state.history,
    generation: state.generation,
    watermark: state.watermark,
    durableWatermark: state.durableWatermark,
  };
}
export function failure(error: unknown): Reply {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.split(":")[0] || "ERROR";
  return { kind: "error", code, message };
}
export function mutation(operation: Operation): boolean {
  if (operation.kind !== "guest") return ["write", "append", "rename"].includes(operation.kind);
  return [
    "write",
    "append",
    "create",
    "rename",
    "resize",
    "setMtime",
    "removePath",
    "link",
  ].includes(operation.method);
}

export type WorkerMessage =
  | { hello: string }
  | { instance: string; id?: number; result?: Reply; nudge?: boolean; diagnostic?: unknown };

export function checkRequestBytes(request: Request): void {
  const serialized = JSON.stringify(request);
  if (serialized.length > 65536 || new TextEncoder().encode(serialized).length > 65536)
    throw new Error("BACKPRESSURE: request bytes");
}
