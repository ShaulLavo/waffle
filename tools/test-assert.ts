function ok(value: unknown, message?: string): asserts value {
  if (!value) throw new Error(message ?? "Acceptance assertion failed");
}
function equal(actual: unknown, expected: unknown, message?: string) {
  ok(
    Object.is(actual, expected),
    `${message ?? "Acceptance value differs"}: ${String(actual)} != ${String(expected)}`,
  );
}
function deepEqual(actual: unknown, expected: unknown, message?: string) {
  equal(JSON.stringify(actual), JSON.stringify(expected), message);
}
export default { ok, equal, deepEqual };
