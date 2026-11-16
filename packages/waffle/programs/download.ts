const DEFAULT_MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

// Sharing and explicit retries belong to the registry, cancellation to the installation.
export function fetchWasm(
  url: URL,
  signal: AbortSignal | undefined,
  maxBytes = DEFAULT_MAX_DOWNLOAD_BYTES,
): () => Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
    throw new RangeError("Program maxDownloadBytes must be a positive safe integer");
  return async () => {
    signal?.throwIfAborted();
    const response = await fetch(url, { signal });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      signal?.throwIfAborted();
      if (!response.ok) throw new Error(`Program fetch failed: ${url.href} (${response.status})`);
      checkSize(Number(response.headers.get("Content-Length")), maxBytes, url);
      reader = response.body?.getReader();
    } catch (error) {
      await discard(() => response.body?.cancel());
      throw error;
    }
    return reader ? readBytes(reader, signal, maxBytes, url) : new Uint8Array();
  };
}

function checkSize(bytes: number, maxBytes: number, url: URL): void {
  if (bytes > maxBytes)
    throw new RangeError(`Program download exceeds ${maxBytes} bytes: ${url.href}`);
}

// Cancellation is joined before the source's activity hold can leave. A stalled cancel
// therefore retains installation ownership, even when it has already settled a pending read.
async function readBytes(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  maxBytes: number,
  url: URL,
): Promise<Uint8Array> {
  let cancellation: Promise<void> | undefined;
  const cancel = () => (cancellation ??= discard(() => reader.cancel()));
  const abort = () => {
    void cancel();
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await collectBytes(reader, signal, maxBytes, url);
  } catch (error) {
    await cancel();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    await cancellation;
    await discard(() => reader.releaseLock());
  }
}

async function collectBytes(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  maxBytes: number,
  url: URL,
): Promise<Uint8Array> {
  let bytes: Uint8Array = new Uint8Array();
  let size = 0;
  while (true) {
    signal?.throwIfAborted();
    const { done, value } = await reader.read();
    signal?.throwIfAborted();
    if (done) break;
    const offset = size;
    size += value.byteLength;
    checkSize(size, maxBytes, url);
    if (size > bytes.byteLength) {
      const capacity = Math.min(maxBytes, Math.max(size, bytes.byteLength * 2, 64 * 1024));
      const grown = new Uint8Array(capacity);
      grown.set(bytes.subarray(0, offset));
      bytes = grown;
    }
    bytes.set(value, offset);
  }
  return bytes.subarray(0, size);
}

async function discard(cleanup: () => void | Promise<void> | undefined): Promise<void> {
  try {
    await cleanup();
  } catch {
    // An unread body or reader cleanup must never replace the primary load error.
  }
}
