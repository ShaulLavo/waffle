import { type OutcomeWord, readOutcome } from "../proc/outcome.js";

/** Injected checkpoints only unwind an already selected default action. They never consume
 * handled signals: our cooperative programs retain their normal handler-delivery checkpoint.
 * The immutable supervisor outcome, not a coincidental later trap, determines process status.
 */
export function fatalInterrupt(outcome: OutcomeWord | null): number {
  const selected = outcome && readOutcome(outcome);
  return selected && selected.kind === "signaled" ? selected.code : 0;
}

/** Supervised siblings stop for any selected outcome, including ordinary exit zero. */
export function terminalInterrupt(outcome: OutcomeWord | null): number {
  return outcome && readOutcome(outcome) ? 1 : 0;
}
