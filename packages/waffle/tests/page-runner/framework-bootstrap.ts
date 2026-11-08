import { resultByteLimit } from "./protocol.js";
import { OrderedReporter } from "./ordered-reporter.js";
import type { FrameworkObservation } from "./framework-page.js";
import type { FrameworkEvent } from "./framework-types.js";

type Configuration = { run: string; token: string; kind: "orchestrator" | "tester"; url: string };
type Body = { token: string } & (
  | { kind: "hello"; role: string; url: string }
  | { kind: "event"; event: FrameworkEvent }
  | { kind: "retire-ready" }
);
export function installFrameworkBootstrap(config: Configuration): void {
  const capturedDocument = document;
  const reporter = new OrderedReporter<Body>(config.run);
  const state = reporter.observation;
  let admitted = false,
    permit: string | null = null,
    contentClosed = false,
    invalidated = false;
  let iframe: HTMLIFrameElement | null = null,
    tester: Document | null = null;
  const admission = Promise.withResolvers<{ permit: string; width: 414; height: 896 }>();
  const retired = Promise.withResolvers<void>();
  const send = (event: FrameworkEvent): Promise<void> => {
    try {
      if (new TextEncoder().encode(JSON.stringify(event)).byteLength > resultByteLimit)
        throw new Error("Framework observation exceeds 48 KiB");
      return reporter.send({ token: config.token, kind: "event", event });
    } catch (error) {
      state.failure ??= String(error);
      return Promise.reject(error);
    }
  };
  const enqueue = (event: FrameworkEvent): void => {
    void send(event).catch(() => {});
  };
  const removeEarlyListener = window.removeEventListener.bind(window);
  const error = (event: ErrorEvent) =>
    enqueue({ kind: "error", source: "early-error", error: event.message });
  const rejection = (event: PromiseRejectionEvent) =>
    enqueue({ kind: "error", source: "early-rejection", error: String(event.reason) });
  addEventListener("error", error);
  addEventListener("unhandledrejection", rejection);
  const closeContent = (event: FrameworkEvent): void => {
    contentClosed = true;
    enqueue(event);
  };
  const observation: FrameworkObservation = {
    collected: (tasks) => send({ kind: "collected", tasks }),
    taskStarted: (id) => enqueue({ kind: "task-started", id }),
    taskUpdate: (updates) => enqueue({ kind: "task-update", updates }),
    caseSettled: (updates) => enqueue({ kind: "case-settled", updates }),
    error: (error, source) => enqueue({ kind: "error", error, source }),
    executionFlushed: () => closeContent({ kind: "execution-flushed" }),
    testerCleanupSettled: () => closeContent({ kind: "tester-cleanup-settled" }),
    cleanupResponseReceived: () => closeContent({ kind: "cleanup-response-received" }),
    catcherInstalled: () => {
      removeEarlyListener("error", error);
      removeEarlyListener("unhandledrejection", rejection);
    },
    waitForInitialViewport: () => admission.promise,
    waitForRetirement: () => retired.promise,
  };
  const ancestors = new Set<Node>();
  const inspectMutations = (records: MutationRecord[]): void => {
    if (!iframe) return;
    for (const record of records) inspectRemoved(record.removedNodes);
  };
  const inspectRemoved = (nodes: NodeList): void => {
    for (const node of nodes) {
      if (ancestors.has(node) || node === iframe || (iframe && node.contains(iframe)))
        invalidated = true;
    }
  };
  const mutations = new MutationObserver(inspectMutations);
  mutations.observe(capturedDocument, { childList: true, subtree: true });
  const releaseIdentity = (): void => {
    mutations.disconnect();
    removeEarlyListener("pagehide", pagehide);
  };
  const pagehide = (): void => {
    invalidated = true;
    releaseIdentity();
  };
  addEventListener("pagehide", pagehide);
  const valid = () => {
    inspectMutations(mutations.takeRecords());
    if (document !== capturedDocument || location.href !== config.url) invalidated = true;
    return !invalidated && !state.retired;
  };
  const paired = () => {
    if (!valid()) return false;
    if (!iframe) return false;
    if (
      !iframe.isConnected ||
      iframe.contentDocument !== tester ||
      document.querySelectorAll("iframe[data-vitest]").length !== 1
    )
      invalidated = true;
    return !invalidated;
  };
  const bridge = {
    snapshot: () => ({
      ...state,
      kind: config.kind,
      token: config.token,
      admitted,
      contentClosed,
      valid: valid(),
      paired: config.kind === "tester" || paired(),
    }),
    capture: () => {
      if (!valid() || config.kind !== "orchestrator" || iframe)
        throw new Error("Invalid top capture");
      const matches = document.querySelectorAll("iframe[data-vitest]");
      const candidate = matches.item(0);
      if (
        matches.length !== 1 ||
        !(candidate instanceof HTMLIFrameElement) ||
        !candidate.isConnected ||
        !candidate.contentDocument
      )
        return null;
      if (!candidate.contentWindow?.__waffleFramework?.snapshot().doc) return null;
      iframe = candidate;
      tester = candidate.contentDocument;
      for (let node = candidate.parentNode; node; node = node.parentNode) ancestors.add(node);
      return {
        doc: state.doc,
        frame: candidate,
        testerDoc: candidate.contentWindow?.__waffleFramework?.snapshot().doc ?? null,
      };
    },
    matchesTester: (candidate: Document, element: Element | null) =>
      paired() && candidate === tester && element === iframe,
    challenge: (token: string, doc: string) =>
      valid() &&
      config.token === token &&
      state.doc === doc &&
      (config.kind === "orchestrator" ||
        parent.__waffleFramework?.matchesTester(document, frameElement) === true),
    admit: (token: string, doc: string, viewportPermit: string | null) => {
      if (!valid() || token !== config.token || doc !== state.doc || admitted)
        throw new Error("Invalid or reused document admission");
      admitted = true;
      permit = viewportPermit;
      if (permit) admission.resolve({ permit, width: 414, height: 896 });
      return bridge.snapshot();
    },
    geometry: () => {
      if (!paired() || !iframe || !tester?.defaultView)
        throw new Error("Bound tester document changed");
      const view = tester.defaultView,
        rect = iframe.getBoundingClientRect(),
        visual = visualViewport;
      if (!visual) throw new Error("Missing actual visual viewport");
      return {
        tester: { width: view.innerWidth, height: view.innerHeight, dpr: view.devicePixelRatio },
        top: {
          width: innerWidth,
          height: innerHeight,
          visualWidth: visual.width,
          visualHeight: visual.height,
          scale: visual.scale,
        },
        iframe: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    },
    cutoff: (watermark: number) => {
      if (!valid() || state.pending !== 0 || state.failure || state.ackedThrough !== watermark)
        throw new Error("Document not drained at cutoff");
      state.retired = true;
      releaseIdentity();
      reporter.stop();
      retired.resolve();
      return true;
    },
    testerSnapshot: () => {
      if (!paired()) throw new Error("Paired document changed");
      return tester?.defaultView?.__waffleFramework?.snapshot() ?? null;
    },
    testerCutoff: (watermark: number) => {
      if (!paired()) throw new Error("Paired document changed before tester cutoff");
      return tester?.defaultView?.__waffleFramework?.cutoff(watermark) ?? false;
    },
  };
  Object.defineProperty(window, "__waffleFramework", { value: Object.freeze(bridge) });
  Object.defineProperty(globalThis, Symbol.for("waffle.framework.observation"), {
    value: () => (valid() ? Object.freeze(observation) : undefined),
  });
  reporter.startHeartbeat();
  const hello = reporter.send({
    token: config.token,
    kind: "hello",
    role: config.kind,
    url: location.href,
  });
  void hello.catch(() => {});
  const retirement = async () => {
    await hello;
    const url = `/retire?run=${encodeURIComponent(config.run)}&doc=${encodeURIComponent(state.doc)}`;
    while (!state.retired) {
      const response = await reporter.post(url, { signal: reporter.clock.abortTimeout(2000) });
      if ((await response.json()) === true) {
        await reporter.drain();
        await reporter.send({ token: config.token, kind: "retire-ready" });
        return;
      }
      await new Promise((resolve) => reporter.clock.timeout(resolve, 50));
    }
  };
  void retirement().catch((error) => {
    state.failure ??= String(error);
  });
}
declare global {
  interface Window {
    __waffleFramework?: {
      snapshot(): {
        doc: string;
        kind: string;
        token: string;
        admitted: boolean;
        contentClosed: boolean;
        valid: boolean;
        paired: boolean;
        ackedThrough: number;
        pending: number;
        failure: string | null;
        retired: boolean;
      };
      cutoff(watermark: number): boolean;
      matchesTester(candidate: Document, element: Element | null): boolean;
    };
  }
}
