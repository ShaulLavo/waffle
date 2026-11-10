import { record, resultByteLimit } from "./protocol.js";
import { reportSequence, type ReportStream } from "./report-stream.js";

export const reportEventByteLimit = 4 * 1024 * 1024;
export const reportQueuedByteLimit = 8 * 1024 * 1024;
const streamByteLimit = 32 * 1024 * 1024;
export const reportChunkLength = 4096;
export type ReportAck = { ackedThrough: number; offset?: number };
export type ReportIdentity = { run: string; doc: string; seq: number; token?: string };
type Chunk = ReportIdentity & {
  kind: "report-chunk";
  offset: number;
  length: number;
  bytes: number;
  data: string;
};
type PartialReport = { text: string; length: number; bytes: number; seq: number };

export function reportChunk(
  encoded: string,
  identity: ReportIdentity,
  bytes: number,
  offset: number,
): string {
  return JSON.stringify({
    ...identity,
    kind: "report-chunk",
    offset,
    length: encoded.length,
    bytes,
    data: encoded.slice(offset, offset + reportChunkLength),
  } satisfies Chunk);
}
function chunk(value: Record<string, unknown>): Chunk {
  if (
    value.kind !== "report-chunk" ||
    typeof value.run !== "string" ||
    typeof value.doc !== "string" ||
    typeof value.seq !== "number" ||
    !Number.isSafeInteger(value.seq) ||
    value.seq < 0 ||
    (value.token !== undefined && typeof value.token !== "string") ||
    typeof value.offset !== "number" ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0 ||
    typeof value.length !== "number" ||
    !Number.isSafeInteger(value.length) ||
    value.length <= 0 ||
    typeof value.bytes !== "number" ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes <= resultByteLimit ||
    value.bytes > reportEventByteLimit ||
    value.length > value.bytes ||
    typeof value.data !== "string" ||
    value.data.length === 0 ||
    value.data.length > reportChunkLength ||
    value.offset + value.data.length > value.length ||
    (value.data.length !== reportChunkLength &&
      value.offset + value.data.length !== value.length) ||
    value.offset % reportChunkLength !== 0
  )
    throw new Error("Invalid report chunk or event byte budget");
  return value as Chunk;
}
function decoded(text: string, part: Chunk): Record<string, unknown> {
  const body: unknown = JSON.parse(text);
  if (
    !record(body) ||
    body.kind === "report-chunk" ||
    body.run !== part.run ||
    body.doc !== part.doc ||
    body.seq !== part.seq ||
    body.token !== part.token ||
    new TextEncoder().encode(text).byteLength !== part.bytes
  )
    throw new Error("Reassembled report identity or byte length conflict");
  return body;
}

/** Owns incomplete transport data, not event application or document authority. */
export class ReportChunks {
  private readonly partials = new Map<ReportStream, PartialReport>();
  private readonly retained = new WeakMap<ReportStream, number>();
  private reservedBytes = 0;
  get pendingBytes(): number {
    return this.reservedBytes;
  }
  clear(): void {
    this.partials.clear();
    this.reservedBytes = 0;
  }
  receive(
    stream: ReportStream,
    value: unknown,
    apply: (body: unknown) => void,
    inspect: (body: unknown) => void = () => {},
  ): ReportAck {
    try {
      return this.receiveValue(stream, value, apply, inspect);
    } catch (error) {
      const pending = this.partials.get(stream);
      if (pending) this.reservedBytes -= pending.bytes;
      this.partials.delete(stream);
      throw error;
    }
  }
  private receiveValue(
    stream: ReportStream,
    value: unknown,
    apply: (body: unknown) => void,
    inspect: (body: unknown) => void,
  ): ReportAck {
    const encoded = JSON.stringify(value);
    if (new TextEncoder().encode(encoded).byteLength > resultByteLimit)
      throw new Error("Report envelope oversized: exceeds 48 KiB");
    if (!record(value) || typeof value.seq !== "number") throw new Error("Missing report sequence");
    if (stream.cutoff !== null) throw new Error("Report after observation cutoff");
    if (value.kind === "report-chunk")
      return this.receiveChunk(stream, chunk(value), apply, inspect);
    if (this.partials.has(stream)) throw new Error("Report interrupts incomplete chunks");
    return this.commit(stream, value, encoded, value.seq, apply, inspect);
  }
  private commit(
    stream: ReportStream,
    value: unknown,
    encoded: string,
    seq: number,
    apply: (body: unknown) => void,
    inspect: (body: unknown) => void,
  ): ReportAck {
    inspect(value);
    if (reportSequence(stream, seq, encoded) === "retry") return { ackedThrough: seq };
    const bytes = (this.retained.get(stream) ?? 0) + new TextEncoder().encode(encoded).byteLength;
    if (bytes > streamByteLimit) throw new Error("Report stream byte budget exceeded");
    apply(value);
    stream.messages.push(encoded);
    this.retained.set(stream, bytes);
    return { ackedThrough: seq };
  }
  private receiveChunk(
    stream: ReportStream,
    part: Chunk,
    apply: (body: unknown) => void,
    inspect: (body: unknown) => void,
  ): ReportAck {
    const saved = stream.messages[part.seq];
    if (saved !== undefined) {
      if (
        saved.length !== part.length ||
        saved.slice(part.offset, part.offset + part.data.length) !== part.data
      )
        throw new Error("Report chunk replay conflict");
      if (new TextEncoder().encode(saved).byteLength !== part.bytes)
        throw new Error("Report chunk replay byte conflict");
      if (part.offset + part.data.length === part.length) inspect(decoded(saved, part));
      return this.ack(part);
    }
    reportSequence(stream, part.seq, "");
    const pending = this.reserve(stream, part);
    if (part.offset < pending.text.length) {
      if (pending.text.slice(part.offset, part.offset + part.data.length) !== part.data)
        throw new Error("Report chunk replay conflict");
      return this.ack(part);
    }
    if (part.offset !== pending.text.length) throw new Error("Report chunk offset gap");
    pending.text += part.data;
    if (pending.text.length !== part.length) return this.ack(part);
    const body = decoded(pending.text, part);
    this.commit(stream, body, pending.text, part.seq, apply, inspect);
    if (this.partials.delete(stream)) this.reservedBytes -= pending.bytes;
    return this.ack(part);
  }
  private reserve(stream: ReportStream, part: Chunk): PartialReport {
    const pending = this.partials.get(stream);
    if (pending) {
      if (
        pending.seq !== part.seq ||
        pending.length !== part.length ||
        pending.bytes !== part.bytes
      )
        throw new Error("Report chunk metadata conflict");
      return pending;
    }
    if (part.offset !== 0 || this.reservedBytes + part.bytes > reportQueuedByteLimit)
      throw new Error("Report chunk admission or capacity exceeded");
    const created = { text: "", seq: part.seq, length: part.length, bytes: part.bytes };
    this.partials.set(stream, created);
    this.reservedBytes += part.bytes;
    return created;
  }
  private ack(part: Chunk): ReportAck {
    const offset = part.offset + part.data.length;
    return { ackedThrough: offset === part.length ? part.seq : part.seq - 1, offset };
  }
}
