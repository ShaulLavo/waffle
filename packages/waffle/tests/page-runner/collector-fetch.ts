import { frameworkEvent } from "./framework-collector.js";
import type { CollectorObservation } from "./framework-types.js";
import { bounded } from "./driver.js";
import { ObservationClosed, ReportRejected } from "./collector.js";
import type { HostReply } from "./report-control.js";
const collectorHeaders = {
  "Cache-Control": "no-store",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};
export type ReportSink = {
  receive(body: unknown, inspect?: (body: unknown) => void): { ackedThrough: number };
  heartbeat(body: unknown): HostReply;
  retirement(url: URL): HostReply;
  fail(category: string, detail: string): void;
};
export function reservedReportPath(path: string): boolean {
  return ["/report", "/heartbeat", "/retire"].includes(path);
}
export async function readReportBody(request: Request): Promise<unknown> {
  if (!request.body) throw new Error("Missing collector body");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    text = "";
  const deadline = performance.now() + 2000;
  try {
    for (;;) {
      const item = await bounded(
        reader.read(),
        Math.max(1, deadline - performance.now()),
        "collector body read",
      );
      if (item.done) return JSON.parse(text + decoder.decode());
      bytes += item.value.byteLength;
      if (bytes > 65536) throw new Error("Collector POST exceeds 65536 bytes");
      text += decoder.decode(item.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export async function dispatchReports(
  request: Request,
  sink: ReportSink,
  observe?: (observation: CollectorObservation) => void,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!reservedReportPath(url.pathname)) return;
  try {
    if (url.pathname === "/retire" && request.method === "GET")
      return Response.json(sink.retirement(url), { headers: collectorHeaders });
    if (request.method !== "POST" || url.pathname === "/retire")
      return new Response("Method not allowed", { status: 405, headers: collectorHeaders });
    const body = await bounded(readReportBody(request), 2000, "collector request body");
    if (url.pathname === "/report") return receiveReport(body, sink, observe);
    return Response.json(sink.heartbeat(body), { headers: collectorHeaders });
  } catch (error) {
    if (error instanceof ObservationClosed)
      return Response.json({ error: error.message }, { status: 410, headers: collectorHeaders });
    if (!(error instanceof ReportRejected)) sink.fail("collector", String(error));
    return Response.json({ error: String(error) }, { status: 409, headers: collectorHeaders });
  }
}

function receiveReport(
  body: unknown,
  sink: ReportSink,
  observe: ((observation: CollectorObservation) => void) | undefined,
): Response {
  let event =
    typeof body === "object" && body !== null && "event" in body && frameworkEvent(body.event)
      ? body.event
      : undefined;
  try {
    const answer = sink.receive(body, (complete) => {
      if (
        typeof complete === "object" &&
        complete !== null &&
        "event" in complete &&
        frameworkEvent(complete.event)
      )
        event = complete.event;
    });
    if (event) observe?.({ event, status: 200, accepted: true });
    return Response.json(answer, { headers: collectorHeaders });
  } catch (error) {
    if (event)
      observe?.({ event, status: error instanceof ObservationClosed ? 410 : 409, accepted: false });
    throw error;
  }
}
