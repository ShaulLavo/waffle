import { isDeepStrictEqual } from "node:util";

export type ProofStep =
  | { name: string; kind: "unrun" }
  | { name: string; kind: "completed"; value: unknown }
  | { name: string; kind: "failed"; failure: string };

function comparisonValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return Object.fromEntries(value.entries());
  if (Array.isArray(value)) return value.map(comparisonValue);
  if (value === null || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, comparisonValue(item)]),
  );
}

export function proofEqual(actual: unknown, expected: unknown): void {
  if (!isDeepStrictEqual(comparisonValue(actual), comparisonValue(expected)))
    throw new Error(`Expected ${reportJson(expected)}, got ${reportJson(actual)}`);
}

function publicationFile(value: unknown) {
  if (
    value === null ||
    typeof value !== "object" ||
    !("birthHistory" in value) ||
    typeof value.birthHistory !== "string" ||
    !("ino" in value) ||
    typeof value.ino !== "number" ||
    !Number.isSafeInteger(value.ino) ||
    !("id" in value) ||
    typeof value.id !== "bigint" ||
    value.id <= 0n ||
    !("version" in value) ||
    typeof value.version !== "bigint" ||
    value.version < value.id
  )
    throw new Error("Missing file identity or bigint revision");
  return value;
}

export function proofFileAdvance(actual: unknown, previous: unknown): void {
  const current = publicationFile(actual),
    before = publicationFile(previous);
  proofEqual(current, { ...before, version: current.version });
  if (current.version <= before.version)
    throw new Error(`File revision did not advance: ${reportJson({ previous, actual })}`);
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
