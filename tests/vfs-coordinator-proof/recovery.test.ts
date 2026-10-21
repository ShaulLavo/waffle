import { expect, test } from "bun:test";
import {
  acceptRecovery,
  accepts,
  beginRecovery,
  greeting,
  IntentLedger,
  unsettled,
  type AcceptedAuthority,
  type AuthorityState,
} from "./recovery.js";
import type { Request } from "./protocol.js";

const first: AcceptedAuthority = {
  instance: "one",
  token: "token",
  cursor: { epoch: 4, history: "history", generation: 8, watermark: 8, durableWatermark: 6 },
};
function current(): AuthorityState {
  return { kind: "current", accepted: structuredClone(first) };
}
function request(): Request {
  return {
    client: "client",
    sequence: 1,
    epoch: 4,
    history: "history",
    actor: "host",
    operation: { kind: "append", path: "/file", text: "once" },
  };
}
test("greeting never makes an uninitialized replacement authoritative", () => {
  const state = greeting(current(), "two");
  expect(state.kind).toBe("replacement");
  expect(accepts(state, "two", { kind: "ok", cursor: first.cursor, result: "cached" })).toBe(false);
  expect(accepts(state, "one", { kind: "ok", cursor: first.cursor, result: "late" })).toBe(false);
});
test("explicit recovery requires the observed instance and a newer epoch", () => {
  const state = beginRecovery(greeting(current(), "two"));
  expect(() => acceptRecovery(state, { ...first, instance: "two" })).toThrow("advance");
  expect(() => acceptRecovery(state, { ...first, instance: "three" })).toThrow("instance");
  const next = { ...first, instance: "two", cursor: { ...first.cursor, epoch: 5 } };
  const recovered = acceptRecovery(state, next);
  expect(accepts(recovered, "one", { kind: "ok", cursor: first.cursor, result: "late" })).toBe(
    false,
  );
  expect(accepts(recovered, "two", { kind: "ok", cursor: first.cursor, result: "old epoch" })).toBe(
    false,
  );
  expect(accepts(recovered, "two", { kind: "ok", cursor: next.cursor, result: "current" })).toBe(
    true,
  );
});
test("first greeting permits initialization but a second replacement interrupts recovery", () => {
  const start = greeting(beginRecovery({ kind: "detached" }), "one");
  expect(acceptRecovery(start, first).kind).toBe("current");
  const changed = greeting(start, "two");
  expect(() => acceptRecovery(changed, { ...first, instance: "two" })).toThrow("instance");
});
test("mutation deadlines report ambiguity, read deadlines do not imply cancellation", () => {
  expect(unsettled(request(), "deadline")).toMatchObject({
    kind: "error",
    code: "OUTCOME_UNKNOWN",
  });
  expect(
    unsettled({ ...request(), operation: { kind: "read", path: "/file" } }, "deadline"),
  ).toMatchObject({ kind: "error", code: "UNAVAILABLE" });
});
test("intent bytes are owned and routing changes preserve identity conflict", () => {
  const ledger = new IntentLedger();
  const original = request();
  const captured = ledger.capture(original);
  original.operation = { kind: "append", path: "/file", text: "changed" };
  expect(captured.operation).toEqual({ kind: "append", path: "/file", text: "once" });
  expect(() => ledger.capture({ ...captured, epoch: 5 })).not.toThrow();
  expect(() => ledger.capture({ ...original, epoch: 5 })).toThrow("OP_ID_CONFLICT");
  expect(ledger.intents.size).toBe(1);
});
test("intent budget rejects rather than forgetting receipt identities", () => {
  const ledger = new IntentLedger();
  for (let sequence = 1; sequence <= 256; sequence++) ledger.capture({ ...request(), sequence });
  expect(() => ledger.capture({ ...request(), sequence: 257 })).toThrow("BACKPRESSURE");
  expect(() => ledger.capture(request())).not.toThrow();
});
test("oversized unresolved intent is rejected before retaining its identity or payload", () => {
  const ledger = new IntentLedger();
  const oversized = {
    ...request(),
    operation: { kind: "append" as const, path: "/file", text: "x".repeat(65537) },
  };
  expect(() => ledger.capture(oversized)).toThrow("BACKPRESSURE");
  expect(ledger.intents.size).toBe(0);
  expect(ledger.unresolved()).toEqual([]);
});
test("intent capacity refuses new work without evicting unknown identities", () => {
  const ledger = new IntentLedger();
  const first = ledger.capture(request());
  ledger.settle(first, unsettled(first, "lost response"));
  for (let sequence = 2; sequence <= 256; sequence++) ledger.capture({ ...request(), sequence });
  expect(() => ledger.capture({ ...request(), sequence: 257 })).toThrow("BACKPRESSURE");
  expect(ledger.unresolved()).toContain("client:1");
  expect(() =>
    ledger.capture({ ...request(), operation: { kind: "append", path: "/file", text: "other" } }),
  ).toThrow("OP_ID_CONFLICT");
});

test("encoded request bytes include Unicode and routing metadata", () => {
  const ledger = new IntentLedger();
  const unicode = {
    ...request(),
    operation: { kind: "append" as const, path: "/file", text: "界".repeat(22000) },
  };
  const metadata = { ...request(), client: "x".repeat(65537) };
  expect(() => ledger.capture(unicode)).toThrow("BACKPRESSURE");
  expect(() => ledger.capture(metadata)).toThrow("BACKPRESSURE");
  expect(ledger.intents.size).toBe(0);
});
