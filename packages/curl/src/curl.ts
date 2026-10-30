import { parseCurl } from "./parse.ts";
import {
  CurlError,
  type CurlInvocation,
  type CurlOutput,
  type CurlRequest,
  type DataPart,
} from "./types.ts";

const encoder = new TextEncoder();
const HELP =
  "Usage: curl [options] URL\nFetch-based HTTP subset: -I -i -f -s -S -L -o -H -X -d --data-binary -m\nOne HTTP(S) URL. Browser security applies. No native curl/TLS/proxy parity.\n";

/** Portable command boundary. No runtime, filesystem or network authority is created here. */
export async function runCurl(invocation: CurlInvocation): Promise<number> {
  let request: CurlRequest | undefined;
  try {
    if (!(invocation.argv.length === 1 && invocation.argv[0] === "--help"))
      request = parseCurl(invocation.argv);
    return await execute(invocation, request);
  } catch (error) {
    const failure = error instanceof CurlError ? error : new CurlError(2, "command failed");
    if (!request?.silent || request.showError)
      await invocation.stderr(`curl: (${failure.exit}) ${failure.message}\n`);
    return failure.exit;
  }
}

async function execute(
  invocation: CurlInvocation,
  request: CurlRequest | undefined,
): Promise<number> {
  if (
    !Number.isFinite(invocation.timeoutMs) ||
    invocation.timeoutMs <= 0 ||
    invocation.timeoutMs > 2147483647
  )
    throw new CurlError(2, "caller must supply a finite positive overall deadline");
  const controller = new AbortController();
  const signal = controller.signal;
  const cancel = () => controller.abort(new CurlError(42, "request cancelled"));
  invocation.signal.addEventListener("abort", cancel, { once: true });
  if (invocation.signal.aborted) cancel();
  const timer = setTimeout(
    () => controller.abort(new CurlError(28, "overall deadline exceeded")),
    Math.min(invocation.timeoutMs, request?.timeoutMs ?? invocation.timeoutMs),
  );
  try {
    if (request) return await transfer(invocation, request, signal);
    await write(invocation.stdout, encoder.encode(HELP), signal);
    return 0;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    invocation.signal.removeEventListener("abort", cancel);
    controller.abort();
  }
}

async function transfer(
  invocation: CurlInvocation,
  request: CurlRequest,
  signal: AbortSignal,
): Promise<number> {
  const body = await requestBody(invocation, request, signal);
  signal.throwIfAborted();
  const response = await fetchResponse(invocation, request, body, signal);
  let output: CurlOutput | undefined;
  let outputClosed = false;
  const owned = request.output !== undefined && request.output !== "-";
  try {
    signal.throwIfAborted();
    if (
      response.type === "opaqueredirect" ||
      response.type === "opaque" ||
      response.type === "error" ||
      response.status === 0
    )
      throw new CurlError(
        7,
        "browser Fetch hides this response; redirects may require -L and CORS access",
      );
    const failed = request.fail && response.status >= 400;
    if (failed && !request.head && !request.include)
      throw new CurlError(22, `HTTP response ${response.status}`);
    output = owned ? await openOutput(invocation, request.output ?? "", signal) : invocation.stdout;
    if (request.head || request.include)
      await write(output, encoder.encode(responseHeaders(response)), signal);
    if (failed) throw new CurlError(22, `HTTP response ${response.status}`);
    if (!request.head) await copyResponse(response, output, signal);
    if (owned) {
      await closeOutput(output, signal);
      outputClosed = true;
    }
    signal.throwIfAborted();
    return 0;
  } catch (error) {
    if (owned && output && !outputClosed)
      await output.abort(error).catch(() => {
        throw new CurlError(23, "failed cleaning up output");
      });
    throw error;
  } finally {
    await response.body?.cancel().catch(() => {});
  }
}

async function openOutput(
  invocation: CurlInvocation,
  path: string,
  signal: AbortSignal,
): Promise<CurlOutput> {
  try {
    return await invocation.files.write(path, signal);
  } catch {
    throw new CurlError(23, "could not open output file");
  }
}

async function closeOutput(output: CurlOutput, signal: AbortSignal): Promise<void> {
  try {
    await output.close(signal);
  } catch {
    throw new CurlError(23, "failed closing output");
  }
}

async function write(output: CurlOutput, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  try {
    await output.write(bytes, signal);
  } catch {
    throw new CurlError(23, "failed writing output");
  }
  signal.throwIfAborted();
}

async function copyResponse(
  response: Response,
  output: CurlOutput,
  signal: AbortSignal,
): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await pump(reader, output, signal);
  } finally {
    signal.removeEventListener("abort", cancel);
    await (cancellation ?? reader.cancel().catch(() => {}));
    reader.releaseLock();
  }
}

async function pump(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  output: CurlOutput,
  signal: AbortSignal,
): Promise<void> {
  while (true) {
    signal.throwIfAborted();
    const part = await readResponse(reader);
    signal.throwIfAborted();
    if (part.done) return;
    await write(output, part.value, signal);
  }
}

async function readResponse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
  try {
    return await reader.read();
  } catch {
    throw new CurlError(18, "response body ended before transfer completed");
  }
}

async function fetchResponse(
  invocation: CurlInvocation,
  request: CurlRequest,
  body: Blob | undefined,
  signal: AbortSignal,
): Promise<Response> {
  try {
    return await invocation.fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body,
      signal,
      redirect: request.follow ? "follow" : "manual",
      credentials: "omit",
    });
  } catch {
    throw new CurlError(
      7,
      "Fetch failed; browser CORS, header, TLS or network policy may block this request",
    );
  }
}

function responseHeaders(response: Response): string {
  let text = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}\r\n`;
  for (const [name, value] of response.headers) text += `${name}: ${value}\r\n`;
  return `${text}\r\n`;
}

async function requestBody(
  invocation: CurlInvocation,
  request: CurlRequest,
  signal: AbortSignal,
): Promise<Blob | undefined> {
  if (!request.data.length) return;
  const parts: BlobPart[] = [];
  for (const part of request.data) {
    if (parts.length) parts.push("&");
    parts.push(await dataPart(invocation, part, signal));
  }
  if (!request.headers.has("content-type"))
    request.headers.set("content-type", "application/x-www-form-urlencoded");
  return new Blob(parts);
}

async function dataPart(
  invocation: CurlInvocation,
  part: DataPart,
  signal: AbortSignal,
): Promise<Blob | string> {
  if (!part.value.startsWith("@")) return part.value;
  const stream =
    part.value === "@-"
      ? invocation.stdin
      : await inputFile(invocation, part.value.slice(1), signal);
  const reader = stream.getReader();
  const chunks: BlobPart[] = [];
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await collectInput(reader, part.binary, chunks, signal);
    return new Blob(chunks);
  } finally {
    signal.removeEventListener("abort", cancel);
    await (cancellation ?? reader.cancel().catch(() => {}));
    reader.releaseLock();
  }
}

async function inputFile(
  invocation: CurlInvocation,
  path: string,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  try {
    return await invocation.files.read(path, signal);
  } catch {
    throw new CurlError(26, "could not open input file");
  }
}

async function collectInput(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  binary: boolean,
  chunks: BlobPart[],
  signal: AbortSignal,
): Promise<void> {
  while (true) {
    signal.throwIfAborted();
    const part = await reader.read().catch(() => {
      throw new CurlError(26, "failed reading request input");
    });
    signal.throwIfAborted();
    if (part.done) return;
    // Blob takes the upload snapshot needed for Fetch redirect replay. Responses never buffer.
    const bytes = binary
      ? part.value
      : part.value.filter((byte) => byte !== 0 && byte !== 10 && byte !== 13);
    chunks.push(snapshot(bytes));
  }
}

function snapshot(bytes: Uint8Array): Blob {
  const buffer = bytes.buffer;
  // Blob cannot accept a SharedArrayBuffer view. Ordinary upload chunks need no extra copy.
  const view =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer, bytes.byteOffset, bytes.byteLength)
      : bytes.slice();
  return new Blob([view]);
}
