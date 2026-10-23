import { isDeepStrictEqual } from "node:util";

export type ProofStep =
  | { name: string; kind: "unrun" }
  | { name: string; kind: "completed"; value: unknown }
  | { name: string; kind: "failed"; failure: string };

export function proofEqual(actual: unknown, expected: unknown): void {
  if (!isDeepStrictEqual(actual, expected))
    throw new Error(`Expected ${reportJson(expected)}, got ${reportJson(actual)}`);
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
  return JSON.stringify(
    value,
    (_key, item: unknown) => {
      if (item === undefined) return { valueType: "undefined" };
      if (typeof item === "bigint") return { valueType: "bigint", value: String(item) };
      if (typeof item === "number" && Object.is(item, -0)) return { valueType: "negative-zero" };
      if (typeof item === "number" && Number.isNaN(item)) return { valueType: "nan" };
      if (item instanceof Error)
        return {
          valueType: "error",
          name: item.name,
          message: item.message,
          stack: item.stack,
          cause: item.cause,
        };
      return item;
    },
    space,
  );
}
