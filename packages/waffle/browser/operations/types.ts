export type OperationPhase = "waiting" | "submitted" | "accepted";
export type OperationResult =
  | { readonly phase: "completed" }
  | {
      readonly phase: "cancelled";
      readonly reason: "signal-pending" | "process-stop" | "filesystem-cancelled";
    }
  | {
      readonly phase: "failed";
      readonly reason: "poll-error" | "resolve-error" | "transport-error" | "submission-error";
    };

export interface OperationSummary {
  readonly active?: { readonly phase: OperationPhase; readonly elapsedMs: number | null };
  readonly latest?: OperationResult & { readonly elapsedMs: number | null };
  readonly retirement?: {
    readonly phase: "retired-unconfirmed";
    readonly elapsedMs: number | null;
  };
  readonly completed: number;
  readonly cancelled: number;
  readonly failed: number;
}

export interface OperationImage {
  readonly pid: number;
  readonly generation: number;
  readonly captureId: number;
  /** Omitted when the guest is updating this operation's cells. */
  readonly pipeReadWait?: OperationSummary;
  readonly fsResolve?: OperationSummary;
}

export type OperationDiagnostics =
  | { readonly status: "disabled" | "empty" | "unavailable" }
  | {
      readonly status: "recording";
      readonly owned: readonly OperationImage[];
      readonly departed: readonly OperationImage[];
      readonly skippedImages: number;
    };
