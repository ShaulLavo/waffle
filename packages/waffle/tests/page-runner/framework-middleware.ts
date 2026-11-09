import type { IncomingMessage, ServerResponse } from "node:http";
import { incomingBody } from "./framework-http-body.js";
import type { FrameworkTraceOwner } from "./framework-trace.js";
import { dispatchReports, reservedReportPath, type ReportSink } from "./collector-fetch.js";

export function frameworkMiddleware(
  sink: ReportSink,
  trace: () => FrameworkTraceOwner | undefined = () => undefined,
) {
  return (incoming: IncomingMessage, outgoing: ServerResponse, next: () => void): void => {
    const path = new URL(incoming.url ?? "/", "http://127.0.0.1").pathname;
    if (trace()?.handle(incoming, outgoing)) return;
    if (!reservedReportPath(path)) {
      next();
      return;
    }
    const owner = trace();
    const reserved = owner?.reserveResponse(outgoing);
    const work = () => respond(incoming, outgoing, sink, owner, reserved !== undefined);
    if (reserved) {
      reserved(work);
      return;
    }
    void work().catch((error) => {
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
  trace: FrameworkTraceOwner | undefined,
  fixtureDecision: boolean,
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
    let observation: import("./framework-types.js").CollectorObservation | undefined;
    const response = await dispatchReports(request, sink, (value) => {
      observation = value;
    });
    if (!response) throw new Error("Reserved route escaped collector");
    const decision =
      fixtureDecision && observation && trace
        ? await trace.collectorResponse(observation)
        : "unchanged";
    const text =
      decision === "malformed-ack" && observation?.event.kind === "task-update"
        ? JSON.stringify({ ackedThrough: -1 })
        : await response.text();
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(text);
  } finally {
    clearTimeout(timer);
    incoming.off("aborted", abort);
  }
}
