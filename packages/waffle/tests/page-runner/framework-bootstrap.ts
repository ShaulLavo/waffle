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
  const reporter = new OrderedReporter<Body>(config.run, undefined, undefined, {
    token: config.token,
    role: config.kind,
  });
  const state = reporter.observation;
  let admitted = false,
    permit: string | null = null,
    contentClosed = false,
    invalidated = false;
  let iframe: HTMLIFrameElement | null = null,
    tester: Document | null = null;
  const admission = Promise.withResolvers<{ permit: string; width: 414; height: 896 }>();
  const retired = Promise.withResolvers<void>();
  void admission.promise.catch(() => {});
  void retired.promise.catch(() => {});
  reporter.signal.addEventListener(
    "abort",
    () => {
      admission.reject(reporter.signal.reason);
      retired.reject(reporter.signal.reason);
    },
    { once: true },
  );
  const send = (snapshot: () => FrameworkEvent | null): Promise<void> =>
    reporter.sendSnapshot(() => {
      const event = snapshot();
      return event === null ? null : { token: config.token, kind: "event", event };
    });
  const enqueue = (snapshot: () => FrameworkEvent): void => {
    void send(snapshot).catch(() => {});
  };
  const removeEarlyListener = window.removeEventListener.bind(window);
  const error = (event: ErrorEvent) =>
    enqueue(() => ({ kind: "error", source: "early-error", error: event.message }));
  const rejection = (event: PromiseRejectionEvent) =>
    enqueue(() => ({ kind: "error", source: "early-rejection", error: String(event.reason) }));
  addEventListener("error", error);
  addEventListener("unhandledrejection", rejection);
  const closeContent = (event: FrameworkEvent): Promise<void> => {
    contentClosed = true;
    return send(() => event);
  };
  const observation: FrameworkObservation = {
    signal: reporter.signal,
    collected: (snapshot) => send(() => ({ kind: "collected", tasks: snapshot() })),
    taskStarted: (snapshot) => send(() => ({ kind: "task-started", id: snapshot() })),
    taskUpdate: (snapshot) => send(() => ({ kind: "task-update", updates: snapshot() })),
    caseSettled: (snapshot) =>
      send(() => {
        const updates = snapshot();
        return updates === null ? null : { kind: "case-settled", updates };
      }),
    error: (snapshot) => send(() => ({ kind: "error", ...snapshot() })),
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
    reporter.cancelDelivery("Document hidden");
    releaseIdentity();
  };
  addEventListener("pagehide", pagehide);
  const valid = () => {
    inspectMutations(mutations.takeRecords());
    if (document !== capturedDocument || location.href !== config.url) invalidated = true;
    if (invalidated) reporter.cancelDelivery("Document identity invalidated");
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
      if (
        !valid() ||
        reporter.controlsPending !== 0 ||
        state.pending !== 0 ||
        state.failure ||
        state.ackedThrough !== watermark
      )
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
      reporter.signal.throwIfAborted();
      const command = await reporter.control(url, { signal: reporter.clock.abortTimeout(2000) });
      reporter.signal.throwIfAborted();
      if (command.kind === "live" && command.retire) {
        await reporter.stop();
        reporter.signal.throwIfAborted();
        await reporter.drain();
        await reporter.send({ token: config.token, kind: "retire-ready" });
        return;
      }
      await new Promise((resolve) => reporter.clock.timeout(resolve, 50));
    }
  };
  void retirement().catch((error) => {
    if (!reporter.signal.aborted) reporter.cancelDelivery(String(error));
    admission.reject(error);
    retired.reject(error);
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
