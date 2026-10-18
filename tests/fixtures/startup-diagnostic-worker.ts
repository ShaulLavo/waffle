import { claimOutcome, type OutcomeWord } from "../../proc/outcome.js";
import { bootstrap, type RuntimeWorkerRequest } from "../../browser/worker.js";

declare const self: DedicatedWorkerGlobalScope;
self.onmessage = ({ data }: MessageEvent<RuntimeWorkerRequest & { diagnostic: string; diagnosticGate: SharedArrayBuffer; legacy: boolean }>) => {
  const gate = new Int32Array(data.diagnosticGate);
  const error = new Error(data.diagnostic); error.stack = "";
  let outcome: OutcomeWord | null = null;
  void bootstrap(data, {
    setup(context) { outcome = context.outcome; const { fs } = context; fs.preopen = () => 1; fs.retain = () => {}; fs.release = () => {}; },
    instantiated() { throw error; },
    complete: data.legacy ? (code, signal) => claimOutcome(outcome!, signal === undefined ? { kind: "exited", code } : { kind: "signaled", code: signal }) : undefined,
    diagnostic(message) { self.postMessage({ type: "legacy-startup-diagnostic", message }); },
    run() { throw new Error("unreachable executable entry"); },
  }, {
    crossOriginIsolated: true,
    postMessage(message) {
      if (message.type !== "error") { self.postMessage(message); return; }
      // Preserve the real exit-before-error ordering and hold the diagnostic-bearing message
      // so the parent can check that an outcome/pump alone cannot release inherited stderr.
      self.postMessage({ type: "startup-diagnostic-pending" });
      void (async () => {
        while (!Atomics.load(gate, 0)) await new Promise(resolve => setTimeout(resolve, 1));
        self.postMessage(message);
      })();
    },
  });
};
