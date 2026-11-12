import { installWorkspaceChannelObserver } from "../fixtures/publication-channel-observer.js";
import { record } from "./protocol.js";
import { BoundedTrace, fixturePath } from "./stall-diagnostics.js";

export function installPublicationBootstrap(): void {
  installWorkspaceChannelObserver();
  installPublicationCloseBridge();
}

export function installPublicationCloseBridge(): void {
  const configuration = window.__suiteConfiguration;
  const documentURL = location.href;
  const trace = new BoundedTrace("page-monotonic-ms");
  window.__crossTabBridgeTrace = trace;
  Reflect.set(globalThis, "__publicationWaitForClose", async (url: string) => {
    if (typeof url !== "string" || !url || url.length > 16_384)
      throw new Error("Invalid Worker close URL");
    const activeJobs = window.__crossTabEvaluator?.activeJobs() ?? [];
    const activeJobCount = window.__crossTabEvaluator?.activeCount();
    const ambiguous = activeJobCount !== 1;
    const query = trace.begin("bridge-invoked", {
      fixture: fixturePath(url),
      activeJobs,
      activeJobCount,
      ambiguous,
    });
    try {
      const response = await fetch("/_waffle_worker_close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          run: configuration.run,
          token: configuration.token,
          doc: window.__pageRunner.doc,
          documentURL,
          url,
          query,
          activeJobs,
          activeJobCount,
          ambiguous,
        }),
      });
      trace.mark(query, "response-arrived", { status: response.status });
      const answer: unknown = await response.json();
      if (!response.ok || !record(answer) || answer.closed !== true)
        throw new Error(`Browser Worker close query failed: ${JSON.stringify(answer)}`);
      trace.end(query, "page-acknowledged");
    } catch (error) {
      trace.end(query, "failed");
      throw error;
    }
  });
}
