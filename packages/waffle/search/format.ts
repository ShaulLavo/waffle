import { SEARCH_LIMITS, type FileSearchResult, type OutputPlan } from "./types.js";

const encoder = new TextEncoder();
const LF = new Uint8Array([10]);
const COLON = new Uint8Array([58]);

class OutputBuffer {
  private bytes = new Uint8Array(0);
  private length = 0;

  append(bytes: Uint8Array): void {
    const required = this.length + bytes.length;
    if (required > SEARCH_LIMITS.outputBytes)
      throw new RangeError("search output exceeds per-file limit");
    if (required > this.bytes.length) this.grow(required);
    this.bytes.set(bytes, this.length);
    this.length = required;
  }

  private grow(required: number): void {
    const capacity = Math.min(
      SEARCH_LIMITS.outputBytes,
      Math.max(65536, required, this.bytes.length * 2),
    );
    const bytes = new Uint8Array(capacity);
    bytes.set(this.bytes.subarray(0, this.length));
    this.bytes = bytes;
  }

  finish(): Uint8Array | null {
    return this.length ? this.bytes.slice(0, this.length) : null;
  }
}

function appendLine(
  buffer: OutputBuffer,
  bytes: Uint8Array,
  path: Uint8Array,
  output: Extract<OutputPlan, { kind: "lines" }>,
  line: number,
): void {
  if (output.withFilename) {
    buffer.append(path);
    buffer.append(COLON);
  }
  if (output.lineNumbers) buffer.append(encoder.encode(`${line}:`));
  buffer.append(bytes);
  buffer.append(LF);
}

function appendSummary(
  buffer: OutputBuffer,
  path: Uint8Array,
  output: OutputPlan,
  matched: number,
): void {
  if (output.kind === "lines") return;
  if (output.kind === "files-with-matches") {
    if (matched) {
      buffer.append(path);
      buffer.append(LF);
    }
    return;
  }
  if (!matched && !output.zeroCounts) return;
  if (output.withFilename) {
    buffer.append(path);
    buffer.append(COLON);
  }
  buffer.append(encoder.encode(`${matched}\n`));
}

export function formatFile(
  bytes: Uint8Array,
  path: string,
  output: OutputPlan,
  matches: (start: number, end: number) => boolean,
): FileSearchResult {
  if (bytes.length > SEARCH_LIMITS.fileBytes)
    throw new RangeError("search file exceeds input limit");
  if (path.length > SEARCH_LIMITS.pathBytes) throw new RangeError("search path exceeds byte limit");
  const pathBytes = encoder.encode(path);
  if (pathBytes.length > SEARCH_LIMITS.pathBytes)
    throw new RangeError("search path exceeds byte limit");
  const buffer = new OutputBuffer();
  let matched = 0;
  let line = 0;
  let start = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(10, start);
    const end = newline < 0 ? bytes.length : newline;
    line++;
    const begin = start;
    start = end + 1;
    if (!matches(begin, end)) continue;
    matched++;
    if (output.kind === "lines")
      appendLine(buffer, bytes.subarray(begin, end), pathBytes, output, line);
  }
  appendSummary(buffer, pathBytes, output, matched);
  return { matched, output: buffer.finish() };
}
