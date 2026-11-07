/** @browserEntry Called only by the production command page through its module URL. */
export function objectResult(...args: string[]) {
  if (!crossOriginIsolated) throw new Error("Command page lost cross-origin isolation");
  return { early: 110, late: 90, args, relay: { iterations: 200_000 } };
}
/** @browserEntry Called only by the production command page through its module URL. */
export function arrayResult() {
  return [
    "success/error owner replies survive sender handoff",
    "unreceived admitted scope retires root and transport on runtime shutdown",
    "late forwarded reply cannot revive scope or page guard",
  ];
}
/** @browserEntry Called only by the production command page through its module URL. */
export function throwingBody(): never {
  throw new Error("ACTUAL_COMMAND_BODY_FAILURE");
}
/** @browserEntry Called only by the production command page through its module URL. */
export function cyclicResult() {
  const value: { self?: unknown } = {};
  value.self = value;
  return value;
}
/** @browserEntry Called only by the production command page through its module URL. */
export function bigintResult() {
  return { count: 1n };
}
/** @browserEntry Called only by the production command page through its module URL. */
export function missingResult() {}
/** @browserEntry Called only by the production command page through its module URL. */
export function sizeResult() {
  return { text: "x".repeat(49 * 1024) };
}
/** @browserEntry Called only by the production command page through its module URL. */
export function multibyteResult() {
  return { text: "界".repeat(17_000) };
}
/** @browserEntry Called only by the production command page through its module URL. */
export function snapshotResult() {
  let calls = 0;
  return { toJSON: () => ({ early: ++calls, late: 199, calls, relay: { iterations: 200_000 } }) };
}
/** @browserEntry Called only by the production command page through its module URL. */
export function wrongResult() {
  return { early: 1, late: 1, actual: "retained" };
}
