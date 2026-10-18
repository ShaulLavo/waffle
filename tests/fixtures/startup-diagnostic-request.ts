import type { RuntimeWorkerRequest } from "../../browser/worker.js";

export interface StartupDiagnosticRequest extends RuntimeWorkerRequest {
  diagnostic: string;
  diagnosticGate: SharedArrayBuffer;
  legacy: boolean;
}
