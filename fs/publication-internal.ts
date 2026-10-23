import type { FilesystemClient } from "./client.js";
import type {
  ChangePage,
  MutationId,
  PublicationCut,
  PublicationPin,
  ReceiptLookup,
} from "./publication.js";

/** Internal experiment switch. It is deliberately absent from package exports. */
export const localPublication = Symbol("waffle.local-publication");

export interface PublicationLimits {
  readonly sessions: number;
  readonly operations: number;
  /** Public mode reserves this many operation slots for each live writer session. */
  readonly operationsPerSession?: number;
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
  readonly versions: SharedArrayBuffer;
  readonly pageReaders?: SharedArrayBuffer;
  readonly readerLifetimes?: SharedArrayBuffer;
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

/** Root observer access stays outside the public filesystem capability table. */
export function publicationObserver(client: FilesystemClient) {
  const grant = client.connection.publication?.observer;
  if (!grant) throw new Error("Publication observer was not granted");
  return {
    cut: (): Promise<PublicationCut> => client.asyncCall("publicationCut", [grant]),
    changes: (after: PublicationCut, bytes: number): Promise<ChangePage> =>
      client.asyncCall("publicationChanges", [grant, after, bytes]),
    receipt: (id: MutationId): Promise<ReceiptLookup> =>
      client.asyncCall("publicationReceipt", [grant, id]),
    pin: (
      handle: number,
      offset: number,
      length: number,
    ): Promise<Omit<PublicationPin, "bytes"> & { readonly bytes: readonly number[] }> =>
      client.asyncCall("publicationPin", [grant, handle, offset, length]),
    releasePin: (id: number): Promise<void> =>
      client.asyncCall("publicationReleasePin", [grant, id]),
    diagnostics: (): Promise<PublicationDiagnostics> =>
      client.asyncCall("publicationDiagnostics", [grant]),
    stop: (): Promise<void> => client.asyncCall("publicationStop", [grant]),
  };
}
