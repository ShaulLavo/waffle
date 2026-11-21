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

export const runtimeThreadRegressions = [
  "fd-read",
  "fd-write",
  "fatal-exit",
  "admission",
  "tid-boundaries",
  "growth",
  "overlapping-waits",
] as const;

export type RuntimeThreadRegression = (typeof runtimeThreadRegressions)[number];
export type BrowserRuntimeThreadCase = RuntimeThreadCase | RuntimeThreadRegression;

export function isRuntimeThreadCase(value: unknown): value is RuntimeThreadCase {
  return runtimeThreadCases.some((selected) => selected === value);
}

export function isRuntimeThreadRegression(value: unknown): value is RuntimeThreadRegression {
  return runtimeThreadRegressions.some((selected) => selected === value);
}

export function stockThreadCase(selected: BrowserRuntimeThreadCase): boolean {
  return selected === "pair" || selected === "repeat" || selected === "nested";
}
