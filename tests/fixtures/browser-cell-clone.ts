import { bootstrap, type RuntimeWorkerRequest } from "../../browser/worker.js";
import { reviveTaggedCells, controlLoad, controlCas, type TaggedCellsTransfer } from "../../proc/control.js";
import { reviveOutcome, readOutcome, claimOutcome, markStarted, startStatus, type OutcomeTransfer } from "../../proc/outcome.js";
import { ProcessError, ProcessErrno } from "../../proc/types.js";

type Capture = { operation: "capture"; outcome: OutcomeTransfer; controls: TaggedCellsTransfer[] };
let captured: { outcome: ReturnType<typeof reviveOutcome>; controls: ReturnType<typeof reviveTaggedCells>[] } | undefined;
globalThis.onmessage = async (event: MessageEvent<RuntimeWorkerRequest | Capture | { operation: "stale" | "terminal" }>) => {
  const request = event.data;
  try {
    if (!("operation" in request)) {
      // Exercise the public bootstrap with the exact request posted by launchWorker.
      await bootstrap(request, { run: () => 23 });
    } else if (request.operation === "capture") {
      captured = { outcome: reviveOutcome(request.outcome), controls: request.controls.map(reviveTaggedCells) };
      if (readOutcome(captured.outcome) !== null) throw new Error("captured process is not running");
      if (startStatus(captured.outcome) !== 0 || !markStarted(captured.outcome)) throw new Error("cloned started-running state was lost");
      for (const cells of captured.controls) controlLoad(cells);
      globalThis.postMessage({ phase: "captured" });
    } else if (request.operation === "terminal") {
      if (!captured) throw new Error("no captured cells");
      if (startStatus(captured.outcome) !== 0) throw new Error("terminal outcome lost startup success");
      const winner = claimOutcome(captured.outcome, { kind: "signaled", code: 9 });
      if (winner.kind !== "exited" || winner.code !== 23 || markStarted(captured.outcome)) throw new Error("terminal winner changed");
      globalThis.postMessage({ phase: "terminal" });
    } else {
      if (!captured) throw new Error("no captured cells");
      let rejected = 0;
      const stale = (operation: () => unknown) => {
        try { operation(); }
        catch (error) { if (error instanceof ProcessError && error.errno === ProcessErrno.SRCH) { rejected++; return; } throw error; }
        throw new Error("stale operation succeeded");
      };
      stale(() => readOutcome(captured!.outcome));
      stale(() => startStatus(captured!.outcome));
      stale(() => markStarted(captured!.outcome));
      stale(() => claimOutcome(captured!.outcome, { kind: "exited", code: 99 }));
      for (const cells of captured.controls) {
        stale(() => controlLoad(cells));
        stale(() => controlCas(cells, 0, 0, 99));
      }
      globalThis.postMessage({ phase: "stale", rejected });
    }
  } catch (error) {
    globalThis.postMessage({ failure: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  }
};
