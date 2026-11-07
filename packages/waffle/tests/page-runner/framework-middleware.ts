import type { IncomingMessage, ServerResponse } from "node:http";
import { dispatchReports, reservedReportPath, type ReportSink } from "./collector-fetch.js";

export function frameworkMiddleware(sink: ReportSink) {
  return (incoming: IncomingMessage, outgoing: ServerResponse, next: () => void): void => {
    const path = new URL(incoming.url ?? "/", "http://127.0.0.1").pathname;
    if (!reservedReportPath(path)) {
      next();
      return;
    }
    void respond(incoming, outgoing, sink).catch((error) => {
      sink.fail("middleware", String(error));
      if (!outgoing.headersSent) outgoing.writeHead(409, { "Cache-Control": "no-store" });
      outgoing.end("Collector request failed");
    });
  };
}
async function respond(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  sink: ReportSink,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Collector body deadline")), 2000);
  const abort = () => controller.abort(new Error("Collector client disconnected"));
  incoming.once("aborted", abort);
  const body = incoming.method === "POST" ? incomingBody(incoming) : undefined;
  try {
    const init: RequestInit & { duplex: "half" } = {
      method: incoming.method,
      body: body,
      signal: controller.signal,
      duplex: "half",
    };
    const request = new Request(new URL(incoming.url ?? "/", "http://127.0.0.1"), init);
    const response = await dispatchReports(request, sink);
    if (!response) throw new Error("Reserved route escaped collector");
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(await response.text());
  } finally {
    clearTimeout(timer);
    incoming.off("aborted", abort);
  }
}

function incomingBody(incoming: IncomingMessage): ReadableStream<Uint8Array> {
  let ended = false;
  let data = (_chunk: Buffer) => {};
  let end = () => {};
  let error = (_error: Error) => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      data = (chunk) => {
        if (ended) return;
        controller.enqueue(chunk);
        if ((controller.desiredSize ?? 0) <= 0) incoming.pause();
      };
      end = () => {
        if (ended) return;
        ended = true;
        controller.close();
      };
      error = (value) => {
        if (ended) return;
        ended = true;
        controller.error(value);
      };
      incoming.on("data", data);
      incoming.once("end", end);
      incoming.once("error", error);
    },
    pull() {
      incoming.resume();
    },
    cancel() {
      ended = true;
      incoming.pause();
      incoming.off("data", data);
      incoming.off("end", end);
      incoming.off("error", error);
    },
  });
}
