export const TCP_PATH = "/v1/tcp";
export const MAX_OPEN_BYTES = 8192;
export const MAX_DATA_BYTES = 65536;
export const WINDOW_BYTES = 262144;
export const DRAIN_MS = 5000;

export type TcpErrorCode =
  | "relay-auth"
  | "relay-origin"
  | "destination-denied"
  | "limit"
  | "dns-failed"
  | "target-refused"
  | "target-timeout"
  | "target-unreachable"
  | "protocol";
export type ConnectErrorCode =
  | "EACCES"
  | "ECONNREFUSED"
  | "ENOTFOUND"
  | "ETIMEDOUT"
  | "EHOSTUNREACH"
  | "ENETUNREACH"
  | "ECONNRESET";
export class RelayConnectError extends Error {
  constructor(readonly code: ConnectErrorCode) {
    super(code);
    this.name = "RelayConnectError";
  }
}
export class TcpFailure extends Error {
  constructor(readonly code: TcpErrorCode) {
    super(code);
  }
}
export interface TcpTarget {
  readonly host: string;
  readonly port: number;
}
export interface TcpRemote {
  readonly address: string;
  readonly port: number;
  readonly family: "IPv4" | "IPv6";
}
export interface TcpStream {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly remote: TcpRemote;
  readonly counters: TcpFlowCounters;
}
export interface TcpFlowCounters {
  readonly receiveQueuedBytes: number;
  readonly sendOutstandingBytes: number;
  readonly payloadHandedToCarrier: number;
  readonly payloadReceived: number;
  readonly consumerReleased: number;
  readonly creditHandedToCarrier: number;
  readonly creditApplied: number;
  readonly creditPending: number;
  readonly receiveCredit: number;
  readonly sendCredit: number;
  readonly dataMetadataUpperBound: number;
  readonly creditMetadataUpperBound: number;
  readonly creditPendingSlotBytes: number;
  readonly encodedSlotBytes: number;
  readonly writeInFlight: TcpFrame["kind"] | null;
  readonly discardedBytes: number;
  readonly failedReceiveBytes: number;
}
export interface OpenRequest extends TcpTarget {
  readonly v: 1;
  readonly token: string;
  readonly window: number;
}
export type OpenReply =
  | { readonly v: 1; readonly ok: true; readonly remote: TcpRemote; readonly window: number }
  | { readonly v: 1; readonly ok: false; readonly code: TcpErrorCode };

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function parseHeader(text: string, maximum = MAX_OPEN_BYTES): Record<string, unknown> {
  if (text.length > maximum || new TextEncoder().encode(text).length > maximum)
    throw new TcpFailure("protocol");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TcpFailure("protocol");
  }
  if (!record(value) || value.v !== 1) throw new TcpFailure("protocol");
  return value;
}
export function parseOpen(text: string, maximum = MAX_OPEN_BYTES): OpenRequest {
  const value = parseHeader(text, maximum);
  if (
    typeof value.token !== "string" ||
    typeof value.host !== "string" ||
    typeof value.port !== "number"
  )
    throw new TcpFailure("protocol");
  return {
    v: 1,
    token: value.token,
    host: value.host,
    port: value.port,
    window: checkedWindow(value.window),
  };
}
const codes = new Set<TcpErrorCode>([
  "relay-auth",
  "relay-origin",
  "destination-denied",
  "limit",
  "dns-failed",
  "target-refused",
  "target-timeout",
  "target-unreachable",
  "protocol",
]);
export function parseReply(text: string): OpenReply {
  const value = parseHeader(text);
  if (value.ok === false && typeof value.code === "string" && codes.has(value.code as TcpErrorCode))
    return { v: 1, ok: false, code: value.code as TcpErrorCode };
  const remote = value.remote;
  if (
    value.ok !== true ||
    !record(remote) ||
    typeof remote.address !== "string" ||
    !Number.isInteger(remote.port) ||
    typeof remote.port !== "number" ||
    remote.port < 1 ||
    remote.port > 65535 ||
    (remote.family !== "IPv4" && remote.family !== "IPv6")
  )
    throw new TcpFailure("protocol");
  return {
    v: 1,
    ok: true,
    remote: { address: remote.address, port: remote.port, family: remote.family },
    window: checkedWindow(value.window),
  };
}
export function connectError(code: TcpErrorCode): RelayConnectError {
  const mapping: Record<TcpErrorCode, ConnectErrorCode> = {
    "relay-auth": "EACCES",
    "relay-origin": "EACCES",
    "destination-denied": "EACCES",
    limit: "ECONNREFUSED",
    "dns-failed": "ENOTFOUND",
    "target-refused": "ECONNREFUSED",
    "target-timeout": "ETIMEDOUT",
    "target-unreachable": "EHOSTUNREACH",
    protocol: "ECONNRESET",
  };
  return new RelayConnectError(mapping[code]);
}

/** Shared stream-header decoder. Allocates the body only after admitting its length. */
export class OpenHeaderDecoder {
  private prefix = new Uint8Array(2);
  private prefixBytes = 0;
  private body: Uint8Array | undefined;
  private bodyBytes = 0;
  private complete = false;
  constructor(private maximum = MAX_OPEN_BYTES) {}
  push(input: Uint8Array): { header: string; rest: Uint8Array } | undefined {
    if (this.complete) throw new TcpFailure("protocol");
    let offset = 0;
    while (this.prefixBytes < 2 && offset < input.length)
      this.prefix[this.prefixBytes++] = input[offset++]!;
    if (this.prefixBytes < 2) return;
    if (!this.body) {
      const length = this.prefix[0]! * 256 + this.prefix[1]!;
      if (!length || length > this.maximum) throw new TcpFailure("protocol");
      this.body = new Uint8Array(length);
    }
    const length = Math.min(input.length - offset, this.body.length - this.bodyBytes);
    this.body.set(input.subarray(offset, offset + length), this.bodyBytes);
    this.bodyBytes += length;
    if (this.bodyBytes < this.body.length) return;
    this.complete = true;
    try {
      return {
        header: new TextDecoder("utf-8", { fatal: true }).decode(this.body),
        rest: input.subarray(offset + length),
      };
    } catch {
      throw new TcpFailure("protocol");
    }
  }
}
export function encodeOpenHeader(value: OpenRequest | OpenReply): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(value));
  if (!body.length || body.length > MAX_OPEN_BYTES) throw new TcpFailure("protocol");
  const result = new Uint8Array(body.length + 2);
  new DataView(result.buffer).setUint16(0, body.length);
  result.set(body, 2);
  return result;
}
export type TcpFrame =
  | { kind: "data"; bytes: Uint8Array }
  | { kind: "fin" }
  | { kind: "credit"; bytes: number };
export function frameData(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!bytes.length || bytes.length > MAX_DATA_BYTES) throw new TcpFailure("protocol");
  const frame = new Uint8Array(bytes.length + 1);
  frame.set(bytes, 1);
  return frame;
}
export function frameCredit(bytes: number): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(5);
  frame[0] = 2;
  new DataView(frame.buffer).setUint32(1, bytes);
  return frame;
}
export function parseFrame(frame: Uint8Array): TcpFrame {
  if (frame.length < 1 || frame.length > MAX_DATA_BYTES + 1) throw new TcpFailure("protocol");
  if (frame[0] === 0 && frame.length > 1) return { kind: "data", bytes: frame.subarray(1) };
  if (frame[0] === 1 && frame.length === 1) return { kind: "fin" };
  if (frame[0] === 2 && frame.length === 5)
    return {
      kind: "credit",
      bytes: new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(1),
    };
  throw new TcpFailure("protocol");
}

export function checkedWindow(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 16384 ||
    value > WINDOW_BYTES
  )
    throw new TcpFailure("protocol");
  return value;
}

export class TcpState {
  phase: "opening" | "open" | "closed" = "opening";
  localFin = false;
  remoteFin = false;
  sendWindow = 0;
  handed = 0;
  received = 0;
  consumedBytes = 0;
  creditHandedBytes = 0;
  creditApplied = 0;
  reserved = 0;
  constructor(readonly receiveWindow = WINDOW_BYTES) {
    checkedWindow(receiveWindow);
  }
  open(sendWindow: number): void {
    if (this.phase !== "opening") throw new TcpFailure("protocol");
    this.sendWindow = checkedWindow(sendWindow);
    this.phase = "open";
  }
  close(): boolean {
    if (this.phase === "closed") return false;
    this.phase = "closed";
    return true;
  }
  get sendCredit(): number {
    return this.sendWindow - (this.handed - this.creditApplied);
  }
  get receiveCredit(): number {
    return this.receiveWindow - (this.received - this.creditHandedBytes) - this.reserved;
  }
  get queued(): number {
    return this.received - this.consumedBytes;
  }
  get pendingCredit(): number {
    return this.consumedBytes - this.creditHandedBytes;
  }
  get dueCredit(): number {
    const pending = this.pendingCredit;
    return pending >= Math.ceil(this.receiveWindow / 4) || (this.remoteFin && !this.queued)
      ? pending
      : 0;
  }
  reserveData(bytes: number): void {
    if (
      this.phase !== "open" ||
      this.remoteFin ||
      !Number.isInteger(bytes) ||
      bytes < 1 ||
      bytes > MAX_DATA_BYTES ||
      bytes > this.receiveCredit
    )
      throw new TcpFailure("protocol");
    this.reserved += bytes;
  }
  dataReceived(bytes: number): void {
    if (this.phase !== "open" || !Number.isInteger(bytes) || bytes < 1 || bytes > this.reserved)
      throw new TcpFailure("protocol");
    this.reserved -= bytes;
    this.received = addTotal(this.received, bytes);
  }
  receive(frame: TcpFrame): void {
    if (this.phase !== "open") throw new TcpFailure("protocol");
    if (frame.kind === "credit") {
      if (!frame.bytes || frame.bytes > this.handed - this.creditApplied)
        throw new TcpFailure("protocol");
      this.creditApplied = addTotal(this.creditApplied, frame.bytes);
      return;
    }
    if (this.remoteFin) throw new TcpFailure("protocol");
    if (frame.kind === "fin") {
      this.remoteFin = true;
      return;
    }
    this.reserveData(frame.bytes.length);
    this.dataReceived(frame.bytes.length);
  }
  send(bytes: number): void {
    if (this.phase !== "open" || this.localFin || bytes <= 0 || bytes > this.sendCredit)
      throw new TcpFailure("protocol");
    this.handed = addTotal(this.handed, bytes);
  }
  consumed(bytes: number): void {
    if (this.phase !== "open" || bytes <= 0 || bytes > this.queued)
      throw new TcpFailure("protocol");
    this.consumedBytes = addTotal(this.consumedBytes, bytes);
  }
  creditHanded(bytes: number): void {
    if (this.phase !== "open" || bytes <= 0 || bytes > this.pendingCredit)
      throw new TcpFailure("protocol");
    this.creditHandedBytes = addTotal(this.creditHandedBytes, bytes);
  }
  fin(): void {
    if (this.phase !== "open" || this.localFin) throw new TcpFailure("protocol");
    this.localFin = true;
  }
  get drained(): boolean {
    return (
      this.localFin &&
      this.remoteFin &&
      this.handed === this.creditApplied &&
      this.received === this.consumedBytes &&
      !this.pendingCredit &&
      !this.reserved
    );
  }
}
function addTotal(total: number, bytes: number): number {
  const next = total + bytes;
  if (!Number.isSafeInteger(next)) throw new TcpFailure("limit");
  return next;
}
