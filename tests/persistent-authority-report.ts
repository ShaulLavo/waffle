export type ProofStep =
  | { name: string; kind: "unrun" }
  | { name: string; kind: "completed"; value: unknown }
  | { name: string; kind: "failed"; failure: string };

export function proofEqual(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export function proofReport(evidence: Record<string, unknown>, steps: readonly ProofStep[]) {
  const counts = {
    completed: steps.filter((step) => step.kind === "completed").length,
    failed: steps.filter((step) => step.kind === "failed").length,
    unrun: steps.filter((step) => step.kind === "unrun").length,
  };
  return { ...evidence, counts, steps };
}

export function reportJson(value: unknown, space?: number): string {
  return JSON.stringify(value, null, space);
}
