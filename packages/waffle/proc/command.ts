/** Trusted page-thread code. Cancellation revokes capabilities, but cannot preempt JavaScript. */
export type HostCommand = (context: HostCommandContext) => Promise<number>;
export interface HostCommandDefinition {
  readonly load: () => Promise<HostCommand>;
  readonly signals?: "delegated";
}
export interface HostCommandContext {
  readonly pid: number;
  readonly parentPid: number;
  readonly request: Readonly<{
    executable: string;
    argv: readonly string[];
    env: Readonly<Record<string, string>>;
    cwd: string;
  }>;
  readonly stdin: CommandInput;
  readonly stdout: CommandOutput;
  readonly stderr: CommandOutput;
  readonly processes: ProcessQuery;
  readonly signals: DelegatedSignals | null;
  readonly abort: AbortSignal;
}
export interface CommandInput {
  read(): Promise<Uint8Array | null>;
}
export interface CommandOutput {
  write(bytes: Uint8Array): Promise<void>;
}
export class CommandStdioError extends Error {
  constructor(
    readonly code: "EPIPE" | "EBADF" | "CANCELED" | "EIO",
    message: string = code,
  ) {
    super(message);
    this.name = "CommandStdioError";
  }
}
export interface ProcessQuery {
  snapshot(): readonly CommandProcessRow[];
}
export interface CommandProcessRow {
  readonly pid: number;
  readonly parentPid: number;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly state: "reserved" | "starting" | "running";
}

export type SignalSend = "sent" | "missing" | "denied" | "revoked";
export interface DelegatedSignals {
  send(pid: number, signal: number): SignalSend;
}
