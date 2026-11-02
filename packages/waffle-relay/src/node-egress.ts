import { lookup as resolve } from "node:dns/promises";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import type { Readable } from "node:stream";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import type { Exchange } from "./lifetime.js";
import type { ConnectionOptions } from "node:tls";
import type { Egress } from "./server.js";
import type { Policy } from "./policy.js";
import { requirePublicAddresses } from "./address.js";
import { RelayError } from "./protocol.js";

export type Resolve = (hostname: string) => Promise<readonly { address: string; family: number }[]>;

/** Fresh validated address per hop, passed directly to connect. Never fetch the hostname again. */
export function createNodeEgress(
  policy: Policy,
  ca?: ConnectionOptions["ca"],
  lookup: Resolve = (hostname) => resolve(hostname, { all: true }),
): Egress {
  return {
    async fetch(url, init, job) {
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const answers = isIP(hostname)
        ? [{ address: hostname, family: isIP(hostname) }]
        : await lookup(hostname);
      init.signal.throwIfAborted();
      if (policy.destinations.mode === "public-https") requirePublicAddresses(answers);
      const answer = answers[0];
      if (!answer) throw new RelayError("upstream-network");
      const headers = Object.fromEntries(init.headers);
      headers.host = url.host;
      const options = {
        hostname: answer.address,
        family: answer.family,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: init.method,
        headers,
        agent: false as const,
        signal: init.signal,
        maxHeaderSize: policy.limits.maxHeaderBytes,
        servername: isIP(hostname) ? undefined : hostname,
        ca,
      };
      return requestResponse(url.protocol === "https:", options, init, job);
    },
  };
}

function requestResponse(
  secure: boolean,
  options: RequestOptions,
  init: Parameters<Egress["fetch"]>[1],
  job: Exchange,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = (secure ? httpsRequest : httpRequest)(options);
    ownConnection(request, job);
    request.once("error", reject);
    request.once("response", (response) => resolveResponse(response, init.method, resolve, reject));
    const upload = writeBody(request, init.body);
    const release = job.own({
      async cancel() {
        request.destroy();
        await upload.catch(() => {});
      },
    });
    void upload.then(release, (error: unknown) => {
      request.destroy(error instanceof Error ? error : new Error("Relay upload failed"));
      release();
    });
  });
}

function resolveResponse(
  response: IncomingMessage,
  method: string,
  resolve: (response: Response) => void,
  reject: (error: unknown) => void,
): void {
  try {
    resolve(fromResponse(response, method));
  } catch (error) {
    response.destroy();
    reject(error);
  }
}

async function writeBody(
  request: ClientRequest,
  body: ReadableStream<Uint8Array> | null,
): Promise<void> {
  if (!body) {
    request.end();
    return;
  }
  const reader = body.getReader();
  const close = () => {
    void reader.cancel().catch(() => {});
  };
  request.once("close", close);
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!request.write(next.value)) await drained(request);
    }
    request.end();
  } finally {
    request.removeListener("close", close);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function drained(request: ClientRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      request.removeListener("drain", onDrain);
      request.removeListener("error", onError);
      request.removeListener("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new RelayError("upstream-aborted"));
    };
    request.once("drain", onDrain);
    request.once("error", onError);
    request.once("close", onClose);
  });
}

function fromResponse(response: IncomingMessage, method: string): Response {
  const headers = new Headers();
  for (let index = 0; index < response.rawHeaders.length; index += 2)
    headers.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
  const status = response.statusCode ?? 502;
  const empty = method === "HEAD" || status === 204 || status === 205 || status === 304;
  const body = empty ? null : decodedStream(response, headers.get("content-encoding"));
  if (empty) response.destroy();
  return new Response(body, { status, statusText: response.statusMessage, headers });
}

function messageStream(message: Readable, original: IncomingMessage): ReadableStream<Uint8Array> {
  const iterator = message[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) {
            controller.close();
            return;
          }
          if (!(next.value instanceof Uint8Array)) throw new RelayError("upstream-network");
          controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        original.destroy();
        message.destroy();
        await iterator.return?.();
      },
    },
    { highWaterMark: 0 },
  );
}

function decodedStream(
  message: IncomingMessage,
  encoding: string | null,
): ReadableStream<Uint8Array> {
  let source: Readable = message;
  const formats =
    encoding
      ?.split(",")
      .map((value) => value.trim().toLowerCase())
      .reverse() ?? [];
  for (const format of formats) {
    if (format === "identity") continue;
    const decoder = decoderFor(format);
    source.on("error", (error) => decoder.destroy(error));
    source = source.pipe(decoder);
  }
  return messageStream(source, message);
}

function decoderFor(format: string) {
  if (format === "gzip") return createGunzip();
  if (format === "deflate") return createInflate();
  if (format === "br") return createBrotliDecompress();
  throw new RelayError("upstream-network");
}

function ownConnection(request: ClientRequest, job: Exchange): void {
  const closed = Promise.withResolvers<void>();
  let socketAssigned = false;
  const release = job.own({
    async cancel() {
      request.destroy();
      await closed.promise;
    },
  });
  const finish = () => {
    release();
    closed.resolve();
  };
  request.once("socket", (socket) => {
    socketAssigned = true;
    socket.once("close", finish);
  });
  request.once("close", () => {
    if (!socketAssigned) finish();
  });
}
