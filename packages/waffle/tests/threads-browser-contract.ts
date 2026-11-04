import type { FilesystemConnection } from "../fs/protocol.ts";
import type { PipeEndpointHandle } from "../proc/pipes.ts";
import type { ThreadKey } from "../thread/protocol.ts";
import type { ThreadLaneTransfer } from "../thread/lane.ts";

export type ThreadBrowserMode = "pair" | "repeat" | "nested";
export type ServiceCommand =
  | {
      kind: "init";
      connection: FilesystemConnection;
      memory: WebAssembly.Memory;
      stdout: PipeEndpointHandle;
    }
  | { kind: "lane"; thread: ThreadKey; lane: ThreadLaneTransfer }
  | { kind: "spawned"; request: number; tid: number }
  | { kind: "retire"; tid: number }
  | { kind: "stop" };
export type ServiceEvent =
  | { kind: "ready"; fileBytes: string }
  | { kind: "spawn"; request: number; startArg: number }
  | { kind: "retired"; tid: number }
  | { kind: "stopped"; lanes: number; pendingSpawns: number }
  | { kind: "error"; message: string };
export function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export function threadBrowserModes(value?: string): ThreadBrowserMode[] {
  if (value === undefined) return ["pair", "repeat", "nested"];
  if (value === "pair" || value === "repeat" || value === "nested") return [value];
  throw new Error("expected pair, repeat, or nested");
}
