/** Internal experiment switch. It is deliberately absent from package exports. */
export const localPublication = Symbol("waffle.local-publication");

export interface PublicationLimits {
  readonly sessions: number;
  readonly operations: number;
  readonly inputBytes: number;
  readonly argumentBytes: number;
  readonly effectBytes: number;
  readonly effects: number;
  readonly resultBytes: number;
  readonly logRecords: number;
  readonly logBytes: number;
  readonly pins: number;
  readonly pinBytes: number;
}
export interface PublicationConfiguration {
  readonly limits: PublicationLimits;
  readonly observe?: boolean;
}
export interface PublicationBuffers {
  readonly history: string;
  readonly limits: PublicationLimits;
  readonly control: SharedArrayBuffer;
  readonly sessions: SharedArrayBuffer;
  readonly operations: SharedArrayBuffer;
  readonly inputs: SharedArrayBuffer;
  readonly results: SharedArrayBuffer;
  readonly log: SharedArrayBuffer;
  readonly logData: SharedArrayBuffer;
  readonly pins: SharedArrayBuffer;
  readonly pinData: SharedArrayBuffer;
}
export interface PublicationSession {
  readonly slot: number;
  readonly serial: number;
}
export interface PublicationConnection {
  readonly buffers: PublicationBuffers;
  readonly session: PublicationSession;
  /** Only the authority-created root receives this grant. Never copy it to a fork. */
  readonly observer?: string;
}
export interface PublicationDiagnostics {
  readonly stopped: boolean;
  readonly sessions: number;
  readonly pending: number;
  readonly receipts: number;
  readonly inputBytes: number;
  readonly pins: number;
  readonly pinBytes: number;
  readonly allocatedBytes: number;
}
