// Just enough HTTP/1.1 for preview connections: serialize a browser request into the bytes a guest
// server reads, and parse the bytes it writes back into a response head plus a body stream.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Headers the bridge sets itself (framing and connection management). */
const HOP_BY_HOP = new Set([
  "host",
  "connection",
  "keep-alive",
  "content-length",
  "transfer-encoding",
  "upgrade",
]);

export interface PreviewRequest {
  method: string;
  /** Path and query, like "/api?x=1". */
  target: string;
  headers: [string, string][];
  body: Uint8Array | null;
}

/** `GET /path HTTP/1.1` + headers + body. One request per connection (`Connection: close`). */
export function serializeRequest(req: PreviewRequest, host: string): Uint8Array {
  const lines = [`${req.method} ${req.target} HTTP/1.1`, `host: ${host}`];
  for (const [name, value] of req.headers) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) lines.push(`${name}: ${value}`);
  }
  const body = req.body ?? new Uint8Array();
  if (body.length > 0 || (req.method !== "GET" && req.method !== "HEAD"))
    lines.push(`content-length: ${body.length}`);
  lines.push("connection: close", "", "");
  const head = encoder.encode(lines.join("\r\n"));
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

/** Upgrade requests retain Connection and Upgrade fields and have no synthesized body framing. */
export function serializeUpgrade(
  request: Pick<PreviewRequest, "method" | "target" | "headers">,
  host: string,
): Uint8Array {
  const lines = [`${request.method} ${request.target} HTTP/1.1`, `Host: ${host}`];
  for (const [name, value] of request.headers) {
    if (name.toLowerCase() !== "host") lines.push(`${name}: ${value}`);
  }
  lines.push("", "");
  return encoder.encode(lines.join("\r\n"));
}

export interface ResponseHead {
  status: number;
  statusText: string;
  headers: [string, string][];
}

export interface ResponseSink {
  head(head: ResponseHead): void;
  data(chunk: Uint8Array<ArrayBuffer>): void | Promise<void>;
  end(): void;
  error(message: string): void;
}

type State =
  | "head"
  | "length"
  | "chunk-size"
  | "chunk-data"
  | "chunk-crlf"
  | "trailers"
  | "close"
  | "done";

const NO_BODY = new Set([204, 304]);
const MAX_HEAD_BYTES = 64 * 1024;
const MAX_CHUNK_LINE_BYTES = 8 * 1024;
const MAX_TRAILER_BYTES = 64 * 1024;

/** Incremental HTTP/1.1 response parser. Feed it with `push`, then `end` when the connection closes. */
export class ResponseParser {
  private pending = new PendingBytes();
  private state: State = "head";
  private remaining = 0;
  private trailerBytes = 0;

  constructor(
    private sink: ResponseSink,
    /** Responses to HEAD have no body whatever their headers say. */
    private isHead = false,
  ) {}

  get done(): boolean {
    return this.state === "done";
  }

  push(bytes: Uint8Array): void {
    if (this.state === "done") return;
    try {
      this.pending.append(bytes);
      this.process();
      // A partial push must not retain a caller-owned backing, including fixed buffers.
      this.pending.ensureOwned();
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  /** The guest closed the connection. */
  end(): void {
    if (this.state === "done") return;
    if (this.state === "close") return this.finish();
    this.fail(
      this.state === "head"
        ? "the server closed the connection without a response"
        : "the server closed the connection mid-response",
    );
  }

  private process(): void {
    for (;;) {
      const progressed = this.step();
      if (!progressed || this.state === "done") return;
    }
  }

  /** Handles what it can in the current state; false when more bytes are needed. */
  private step(): boolean {
    switch (this.state) {
      case "head":
        return this.parseHead();
      case "length":
        return this.passBody();
      case "close":
        return this.passBody();
      case "chunk-size":
        return this.parseChunkSize();
      case "chunk-data":
        return this.passBody();
      case "chunk-crlf":
        return this.skipCrlf();
      case "trailers":
        return this.skipTrailers();
      case "done":
        return false;
    }
  }

  private parseHead(): boolean {
    const end = this.pending.findHeadEnd(MAX_HEAD_BYTES);
    if (end < 0) return false;
    const text = decoder.decode(this.pending.copyPrefix(end));
    this.pending.consume(end + 4);
    const [statusLine = "", ...headerLines] = text.split("\r\n");
    const match = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(statusLine);
    if (!match)
      throw new Error(`malformed status line: ${JSON.stringify(statusLine.slice(0, 80))}`);
    const status = Number(match[1]);
    const headers: [string, string][] = [];
    for (const line of headerLines) {
      const colon = line.indexOf(":");
      const name = line.slice(0, colon);
      const value = line.slice(colon + 1);
      if (
        colon <= 0 ||
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
        !/^[\t\x20-\x7e\u0080-\u{10ffff}]*$/u.test(value)
      )
        throw new Error("malformed response header");
      headers.push([name.toLowerCase(), value.replace(/^[ \t]+|[ \t]+$/g, "")]);
    }
    // Interim responses (100 Continue, 103 Early Hints) precede the real one.
    if (status >= 100 && status < 200 && status !== 101) return true;
    this.sink.head({ status, statusText: match[2] ?? "", headers });
    this.state = this.bodyFraming(status, headers);
    if (this.state === "done") this.finish();
    return true;
  }

  private bodyFraming(status: number, headers: [string, string][]): State {
    if (this.isHead || NO_BODY.has(status) || status < 200) return "done";
    const get = (name: string) => headers.find(([n]) => n === name)?.[1];
    if (get("transfer-encoding")?.toLowerCase().includes("chunked")) return "chunk-size";
    const length = get("content-length");
    if (length === undefined) return "close";
    this.remaining = Number(length);
    if (!Number.isSafeInteger(this.remaining) || this.remaining < 0)
      throw new Error(`bad content-length: ${length}`);
    return this.remaining === 0 ? "done" : "length";
  }

  /** Passes body bytes through: all of them (until close), or up to `remaining`. */
  private passBody(): boolean {
    if (this.pending.length === 0) return false;
    const bounded = this.state !== "close";
    const count = bounded ? Math.min(this.remaining, this.pending.length) : this.pending.length;
    this.sink.data(this.pending.copyBody(count));
    this.pending.consume(count);
    if (!bounded) return false;
    this.remaining -= count;
    if (this.remaining > 0) return false;
    if (this.state === "chunk-data") this.state = "chunk-crlf";
    else this.finish();
    return true;
  }

  private parseChunkSize(): boolean {
    const eol = this.pending.findLineEnd(MAX_CHUNK_LINE_BYTES, "chunk-size");
    if (eol < 0) return false;
    const line = decoder.decode(this.pending.copyPrefix(eol));
    this.pending.consume(eol + 2);
    const token = line.split(";", 1)[0]!.trim();
    const size = /^[0-9a-f]+$/i.test(token) ? Number.parseInt(token, 16) : NaN;
    if (!Number.isSafeInteger(size))
      throw new Error(`bad chunk size: ${JSON.stringify(line.slice(0, 40))}`);
    this.remaining = size;
    this.state = size === 0 ? "trailers" : "chunk-data";
    return true;
  }

  private skipCrlf(): boolean {
    if (this.pending.length < 2) return false;
    if (this.pending.byteAt(0) !== 13 || this.pending.byteAt(1) !== 10)
      throw new Error("bad chunk terminator: expected CRLF");
    this.pending.consume(2);
    this.state = "chunk-size";
    return true;
  }

  private skipTrailers(): boolean {
    const eol = this.pending.findLineEnd(MAX_TRAILER_BYTES - this.trailerBytes, "trailers");
    if (eol < 0) return false;
    this.trailerBytes += eol + 2;
    this.pending.consume(eol + 2);
    if (eol === 0) this.finish();
    return true;
  }

  private finish(): void {
    this.state = "done";
    this.pending.clear();
    this.sink.end();
  }

  private fail(message: string): void {
    this.state = "done";
    this.pending.clear();
    this.sink.error(message);
  }
}

class PendingBytes {
  private chunks: Uint8Array[] = [];
  private head = 0;
  private offset = 0;
  private total = 0;
  private direct = false;
  private scanMode: "line" | "head" | undefined;
  private scanChunk = 0;
  private scanOffset = 0;
  private scanAbsolute = 0;
  private scanMatch = 0;

  get length(): number {
    return this.total;
  }

  append(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const first = this.total === 0;
    if (first) {
      this.chunks = [];
      this.head = 0;
      this.offset = 0;
      this.direct = !isSpecialBacking(bytes.buffer);
    }
    this.chunks.push(first && this.direct ? bytes : new Uint8Array(bytes));
    this.total += bytes.length;
  }

  ensureOwned(): void {
    if (this.total === 0) return;
    if (this.offset !== 0) this.compactHead();
    if (!this.direct) return;
    this.chunks[this.head] = new Uint8Array(this.chunks[this.head]!);
    this.direct = false;
  }

  copyPrefix(count: number): Uint8Array {
    if (count === 0) return new Uint8Array(0);
    const first = this.chunks[this.head]!;
    if (this.offset + count <= first.length && this.head + 1 === this.chunks.length)
      return first.subarray(this.offset, this.offset + count);
    const out = new Uint8Array(count);
    this.writePrefix(out);
    return out;
  }

  copyBody(count: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(count);
    this.writePrefix(out);
    return out;
  }

  private writePrefix(out: Uint8Array): void {
    const count = out.length;
    let copied = 0;
    let chunkIndex = this.head;
    let chunkOffset = this.offset;
    while (copied < count) {
      const chunk = this.chunks[chunkIndex]!;
      const available = Math.min(chunk.length - chunkOffset, count - copied);
      out.set(chunk.subarray(chunkOffset, chunkOffset + available), copied);
      copied += available;
      chunkIndex++;
      chunkOffset = 0;
    }
  }

  consume(count: number): void {
    if (count < 0 || count > this.total) throw new RangeError("pending consume exceeds length");
    let remaining = count;
    while (remaining > 0) {
      const chunk = this.chunks[this.head]!;
      const available = chunk.length - this.offset;
      if (remaining < available) {
        this.offset += remaining;
        remaining = 0;
      } else {
        remaining -= available;
        this.chunks[this.head] = EMPTY_CHUNK;
        this.head++;
        this.offset = 0;
      }
    }
    this.total -= count;
    this.resetScan();
    if (this.total === 0) this.clear();
  }

  byteAt(index: number): number {
    if (index < 0 || index >= this.total) throw new RangeError("pending index exceeds length");
    let chunkIndex = this.head;
    let chunkOffset = this.offset + index;
    while (chunkOffset >= this.chunks[chunkIndex]!.length) {
      chunkOffset -= this.chunks[chunkIndex]!.length;
      chunkIndex++;
    }
    return this.chunks[chunkIndex]![chunkOffset]!;
  }

  findLineEnd(limit: number, state: "chunk-size" | "trailers"): number {
    return this.find("line", limit, state);
  }

  findHeadEnd(limit: number): number {
    return this.find("head", limit, "head");
  }

  clear(): void {
    this.chunks = [];
    this.head = 0;
    this.offset = 0;
    this.total = 0;
    this.direct = false;
    this.resetScan();
  }

  private find(mode: "line" | "head", limit: number, state: string): number {
    if (this.scanMode !== mode) {
      this.scanMode = mode;
      this.scanChunk = this.head;
      this.scanOffset = this.offset;
      this.scanAbsolute = 0;
      this.scanMatch = 0;
    }
    const end = Math.min(this.total, Math.max(0, limit));
    let chunkIndex = this.scanChunk;
    let chunkOffset = this.scanOffset;
    let absolute = this.scanAbsolute;
    let match = this.scanMatch;
    while (absolute < end) {
      const chunk = this.chunks[chunkIndex];
      if (!chunk) break;
      if (chunkOffset === chunk.length) {
        chunkIndex++;
        chunkOffset = 0;
        continue;
      }
      const byte = chunk[chunkOffset++]!;
      const at = absolute++;
      if (mode === "line") {
        if (byte === 13) match = 1;
        else if (byte === 10 && match === 1) {
          this.saveScan(chunkIndex, chunkOffset, absolute, 0);
          return at - 1;
        } else match = 0;
      } else {
        if (match === 0) match = byte === 13 ? 1 : 0;
        else if (match === 1) match = byte === 10 ? 2 : byte === 13 ? 1 : 0;
        else if (match === 2) match = byte === 13 ? 3 : 0;
        else if (byte === 10) {
          this.saveScan(chunkIndex, chunkOffset, absolute, 0);
          return at - 3;
        } else match = byte === 13 ? 1 : 0;
      }
    }
    this.saveScan(chunkIndex, chunkOffset, absolute, match);
    if (this.total > limit) throw new Error(`${state} metadata limit exceeded`);
    return -1;
  }

  private saveScan(chunk: number, offset: number, absolute: number, match: number): void {
    this.scanChunk = chunk;
    this.scanOffset = offset;
    this.scanAbsolute = absolute;
    this.scanMatch = match;
  }

  private resetScan(): void {
    this.scanMode = undefined;
    this.scanChunk = this.head;
    this.scanOffset = this.offset;
    this.scanAbsolute = 0;
    this.scanMatch = 0;
  }

  private compactHead(): void {
    const consumed = this.offset;
    const chunk = this.chunks[this.head]!;
    this.chunks[this.head] = new Uint8Array(chunk.subarray(consumed));
    this.offset = 0;
    this.direct = false;
    if (this.scanMode !== undefined && this.scanChunk === this.head) {
      this.scanOffset -= consumed;
    }
  }
}

const EMPTY_CHUNK = new Uint8Array(0);

function isSpecialBacking(buffer: ArrayBufferLike): boolean {
  return (
    Reflect.get(buffer, "resizable") ||
    Reflect.get(buffer, "growable") ||
    Object.prototype.toString.call(buffer) === "[object SharedArrayBuffer]"
  );
}
