import type { FilesystemConnection } from "../../fs/protocol.js";
import { requestTransportError } from "../../fs/request-memory.js";

type CloseReason = NonNullable<ReturnType<typeof requestTransportError>>["reason"];
type Frame =
  | {
      kind: "segment";
      index: number;
      bytes: number;
      maximum: number;
      growable: boolean;
      inherited: boolean;
    }
  | { kind: "request"; id: number; generation: number; privateBytes: number }
  | { kind: "completion"; id: number }
  | { kind: "transportClosed" | "discard" | "trim" | "sweep" | "other" };

export interface EndpointContext {
  tree: string;
  realm: string;
  endpoint: "client" | "service";
  workerURL: string;
}

/** Test-only. Install on the actual port before its original constructor installs handlers.
 * No connection, frame, buffer or callback escapes in a snapshot. This is not guest code. */
export function observeFilesystemEndpoint(
  connection: FilesystemConnection,
  context: EndpointContext,
) {
  const port = connection.port;
  if (port.onmessage || port.onmessageerror) throw Error("endpoint observer installed too late");
  const inherited = connection.segments.map((buffer) => !!buffer);
  const originalSend = port.postMessage;
  let handlersQualified = false;
  let sends = 0;
  let receives = 0;
  let requestSends = 0;
  let requestReceives = 0;
  let sequence = 0;
  let lastSend: Frame | null = null;
  let lastReceive: Frame | null = null;
  type FirstEvent = {
    kind: "messageerror" | "transportClosed" | "shared-closed" | "send-error";
    sequence: number;
    trusted: boolean | null;
    closedBefore: CloseReason | null;
    lastSend: Frame | null;
    lastReceive: Frame | null;
  };
  let first: FirstEvent | null = null;
  const closed = () => requestTransportError(connection.requests)?.reason ?? null;
  function record(kind: FirstEvent["kind"], trusted: boolean | null): void {
    first ??= { kind, sequence, trusted, closedBefore: closed(), lastSend, lastReceive };
  }
  function message(event: MessageEvent<unknown>): void {
    sequence++;
    receives++;
    lastReceive = describeFrame(event.data, inherited);
    if (lastReceive.kind === "request") requestReceives++;
    if (lastReceive.kind === "transportClosed") record("transportClosed", event.isTrusted);
  }
  function messageerror(event: MessageEvent<unknown>): void {
    sequence++;
    record("messageerror", event.isTrusted);
  }
  const send: MessagePort["postMessage"] = function (
    this: MessagePort,
    ...args: [message: unknown, options?: Transferable[] | StructuredSerializeOptions]
  ) {
    if (this !== port) return Reflect.apply(originalSend, this, args);
    sequence++;
    lastSend = describeFrame(args[0], inherited);
    try {
      Reflect.apply(originalSend, this, args);
      sends++;
      if (lastSend.kind === "request") requestSends++;
    } catch (error) {
      record("send-error", null);
      throw error;
    }
  };
  port.addEventListener("message", message);
  port.addEventListener("messageerror", messageerror);
  port.postMessage = send;
  return {
    qualifyHandlers() {
      if (typeof port.onmessage !== "function" || typeof port.onmessageerror !== "function")
        throw Error("original endpoint handlers were not installed");
      handlersQualified = true;
    },
    snapshot() {
      if (closed() && !first) record("shared-closed", null);
      return {
        ...context,
        owner: connection.owner,
        generation: connection.requests.generation,
        resident: connection.residentPublication?.kind ?? null,
        publication: !!connection.publication,
        handlersQualified,
        sends,
        receives,
        requestSends,
        requestReceives,
        lastSend,
        lastReceive,
        first,
        closed: closed(),
      };
    },
    dispose() {
      port.removeEventListener("message", message);
      port.removeEventListener("messageerror", messageerror);
      if (port.postMessage !== send) throw Error("endpoint observer send hook was replaced");
      port.postMessage = originalSend;
    },
  };
}

function describeFrame(value: unknown, inherited: readonly boolean[]): Frame {
  if (!value || typeof value !== "object") return { kind: "other" };
  if ("segment" in value && typeof value.segment === "number" && "buffer" in value)
    return describeSegment(value.segment, value.buffer, inherited);
  if ("transportClosed" in value) return { kind: "transportClosed" };
  if ("completed" in value && typeof value.completed === "number")
    return { kind: "completion", id: value.completed };
  if (
    "id" in value &&
    typeof value.id === "number" &&
    "generation" in value &&
    typeof value.generation === "number"
  )
    return {
      kind: "request",
      id: value.id,
      generation: value.generation,
      privateBytes: privateBytes(value),
    };
  if ("discard" in value) return { kind: "discard" };
  if ("trim" in value) return { kind: "trim" };
  if ("sweep" in value) return { kind: "sweep" };
  return { kind: "other" };
}
function privateBytes(value: object): number {
  return "payload" in value && value.payload instanceof ArrayBuffer ? value.payload.byteLength : 0;
}
function describeSegment(index: number, buffer: unknown, inherited: readonly boolean[]): Frame {
  if (!(buffer instanceof SharedArrayBuffer)) return { kind: "other" };
  return {
    kind: "segment",
    index,
    bytes: buffer.byteLength,
    maximum: buffer.maxByteLength,
    growable: buffer.growable,
    inherited: !!inherited[index - 1],
  };
}

export type EndpointSnapshot = ReturnType<ReturnType<typeof observeFilesystemEndpoint>["snapshot"]>;
