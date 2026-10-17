import type { RunRequest } from "../src/worker";
import { workerProcessState } from "../../runtime/proc/worker-client";

/** Views of the real request, including generic signal records at nonzero offsets.
 * Never allocate a substitute budget: a detached wait word would fabricate proof. */
export function engineInterruptionTransport(request: RunRequest) {
  const runtime = request.runtimeProcess && workerProcessState(request.runtimeProcess);
  const requestedSignal = runtime?.signals.requestedSignal
    ?? (request.child?.requestedSignal ?? request.requestedSignal);
  const signalState = runtime?.signals.signalState
    ?? (request.child?.signalState ?? request.signalState);
  const budget = request.child?.budget ?? request.budget;
  const interrupt = runtime?.signals.interrupt ?? (request.child?.interrupt ?? request.interrupt);
  const waitWord = request.adapter === "preview1"
    ? interrupt instanceof Int32Array ? interrupt : interrupt && new Int32Array(interrupt)
    : budget && new Int32Array(budget, 4, 1);
  if (!requestedSignal || !signalState || !waitWord) throw new Error("interruption probe requires the production signal and wait transport");
  return {
    route: runtime ? "runtimeProcess" as const : "legacy" as const,
    requestedSignal: requestedSignal instanceof Int32Array ? requestedSignal : new Int32Array(requestedSignal),
    signalState: signalState instanceof Int32Array ? signalState : new Int32Array(signalState),
    waitWord,
  };
}
