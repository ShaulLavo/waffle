export const runtimeThreadCases = [
  "pair",
  "repeat",
  "nested",
  "join",
  "child-exit",
  "kill-start",
  "cpu",
  "wait32",
  "wait64",
] as const;

export type RuntimeThreadCase = (typeof runtimeThreadCases)[number];

export function isRuntimeThreadCase(value: unknown): value is RuntimeThreadCase {
  return runtimeThreadCases.some((selected) => selected === value);
}

export function stockThreadCase(selected: RuntimeThreadCase): boolean {
  return selected === "pair" || selected === "repeat" || selected === "nested";
}
