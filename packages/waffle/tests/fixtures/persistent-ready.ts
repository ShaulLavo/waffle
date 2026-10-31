import type { PublicationCut } from "../../fs/publication";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error("missing result");
  return Object.fromEntries(Object.entries(value));
}

export function readyPersistent(
  value: unknown,
  recoveredCut?: PublicationCut,
): Record<string, unknown> {
  const result = record(value);
  if (result.ready !== true)
    throw new Error(`persistent owner was not ready: ${JSON.stringify(result)}`);
  const ready = record(result.value);
  const notice = recoveredCut
    ? {
        kind: "completed-cut-recovered",
        durablePublicationCut: recoveredCut,
        oldCapabilities: "not-restored",
        oldMutationOutcomes: "bounded-retained",
        acknowledgedTail: "may-be-lost",
      }
    : {
        kind: "v1-new-history",
        durablePublicationCut: "untracked",
        oldCapabilities: "not-restored",
        oldMutationOutcomes: "not-restored",
        acknowledgedTail: "may-be-lost",
      };
  if (JSON.stringify(ready.notice) !== JSON.stringify(notice))
    throw new Error(`Expected ${JSON.stringify(notice)}, got ${JSON.stringify(ready.notice)}`);
  return ready;
}
