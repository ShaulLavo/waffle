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

export interface ResponseHead {
  status: number;
  statusText: string;
  headers: [string, string][];
}

export interface ResponseSink {
  head(head: ResponseHead): void;
  data(chunk: Uint8Array): void | Promise<void>;
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

/** Incremental HTTP/1.1 response parser. Feed it with `push`, then `end` when the connection closes. */
export class ResponseParser {
  private pending: Uint8Array = new Uint8Array(0);
  private state: State = "head";
  private remaining = 0;

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
    this.pending = concat(this.pending, bytes);
    try {
      this.process();
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
    const end = indexOfCrlfCrlf(this.pending);
    if (end < 0) return false;
    const text = decoder.decode(this.pending.subarray(0, end));
    this.pending = this.pending.subarray(end + 4);
    const [statusLine = "", ...headerLines] = text.split("\r\n");
    const match = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(statusLine);
    if (!match)
      throw new Error(`malformed status line: ${JSON.stringify(statusLine.slice(0, 80))}`);
    const status = Number(match[1]);
    // Interim responses (100 Continue, 103 Early Hints) precede the real one.
    if (status >= 100 && status < 200 && status !== 101) return true;
    const headers: [string, string][] = [];
    for (const line of headerLines) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      headers.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
    }
    this.sink.head({ status, statusText: match[2] ?? "", headers });
    this.state = this.bodyFraming(status, headers);
    if (this.state === "done") this.sink.end();
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
    this.sink.data(this.pending.slice(0, count));
    this.pending = this.pending.subarray(count);
    if (!bounded) return false;
    this.remaining -= count;
    if (this.remaining > 0) return false;
    if (this.state === "chunk-data") this.state = "chunk-crlf";
    else this.finish();
    return true;
  }

  private parseChunkSize(): boolean {
    const eol = indexOfCrlf(this.pending);
    if (eol < 0) return false;
    const line = decoder.decode(this.pending.subarray(0, eol));
    this.pending = this.pending.subarray(eol + 2);
    const size = Number.parseInt(line.split(";")[0]!.trim(), 16);
    if (Number.isNaN(size)) throw new Error(`bad chunk size: ${JSON.stringify(line.slice(0, 40))}`);
    this.remaining = size;
    this.state = size === 0 ? "trailers" : "chunk-data";
    return true;
  }

  private skipCrlf(): boolean {
    if (this.pending.length < 2) return false;
    this.pending = this.pending.subarray(2);
    this.state = "chunk-size";
    return true;
  }

  private skipTrailers(): boolean {
    const eol = indexOfCrlf(this.pending);
    if (eol < 0) return false;
    this.pending = this.pending.subarray(eol + 2);
    if (eol === 0) this.finish();
    return true;
  }

  private finish(): void {
    this.state = "done";
    this.sink.end();
  }

  private fail(message: string): void {
    this.state = "done";
    this.sink.error(message);
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  // Pending bytes must be fixed and unshared, including while waiting for a partial line.
  if (a.length === 0)
    return Reflect.get(b.buffer, "resizable") ||
      Object.prototype.toString.call(b.buffer) === "[object SharedArrayBuffer]"
      ? new Uint8Array(b)
      : b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function indexOfCrlf(bytes: Uint8Array): number {
  for (let i = 0; i + 1 < bytes.length; i++) if (bytes[i] === 13 && bytes[i + 1] === 10) return i;
  return -1;
}

function indexOfCrlfCrlf(bytes: Uint8Array): number {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10)
      return i;
  }
  return -1;
}
