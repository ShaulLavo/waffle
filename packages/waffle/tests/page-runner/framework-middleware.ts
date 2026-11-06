import type { IncomingMessage, ServerResponse } from "node:http";
import { dispatchReports, reservedReportPath, type ReportSink } from "./collector-fetch.js";

export function frameworkMiddleware(sink: ReportSink) {
  return (incoming: IncomingMessage, outgoing: ServerResponse, next: () => void): void => {
    const path = incoming.url?.split("?")[0] ?? "";
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
  const body =
    incoming.method === "POST"
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            incoming.on("data", (chunk: Buffer) => controller.enqueue(chunk));
            incoming.once("end", () => controller.close());
            incoming.once("error", (error) => controller.error(error));
          },
          cancel() {
            incoming.pause();
          },
        })
      : undefined;
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
