import type { FileStat } from "../core/filesystem.ts";

export type ThreadKey = Readonly<{ directory: string; pid: number; tid: number }>;
export type CallKey = Readonly<{ thread: ThreadKey; sequence: number }>;
export type GuestSpan = Readonly<{ address: number; length: number }>;
export type ThreadOperation =
  | { kind: "read" | "write"; fd: number; spans: readonly GuestSpan[]; position?: number }
  | { kind: "seek"; fd: number; offset: number; whence: "set" | "current" | "end" }
  | { kind: "tell" | "stat" | "fdstat" | "close"; fd: number };
export interface ThreadDescriptorStat {
  readonly filetype: number;
  readonly flags: number;
  readonly rightsBase: bigint;
  readonly rightsInheriting: bigint;
}
export type ThreadResult =
  | { kind: "ok"; value: number | FileStat | ThreadDescriptorStat }
  | { kind: "error"; errno: number };
