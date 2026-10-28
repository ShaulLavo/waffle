import { expect, test } from "bun:test";
import { readyPersistent } from "./fixtures/persistent-ready";

const cut = { history: "saved-history", generation: 0 };
const newHistory = {
  kind: "v1-new-history",
  durablePublicationCut: "untracked",
  oldCapabilities: "not-restored",
  oldMutationOutcomes: "not-restored",
  acknowledgedTail: "may-be-lost",
};
const recovered = {
  kind: "completed-cut-recovered",
  durablePublicationCut: cut,
  oldCapabilities: "not-restored",
  oldMutationOutcomes: "bounded-retained",
  acknowledgedTail: "may-be-lost",
};
function ready(notice: unknown) {
  return { ready: true, value: { notice } };
}

test("persistent readiness preserves the rejected factory result", () => {
  const result = { ready: false, failure: "FilesystemError: 6", events: [] };
  expect(() => readyPersistent(result)).toThrow(
    `persistent owner was not ready: ${JSON.stringify(result)}`,
  );
});

test("persistent readiness requires a new history on first open and explicit reset", () => {
  expect(readyPersistent(ready(newHistory))).toEqual({ notice: newHistory });
  expect(() => readyPersistent(ready(recovered))).toThrow("Expected");
});

test("persistent readiness requires the exact completed cut on later initial opens", () => {
  expect(readyPersistent(ready(recovered), cut)).toEqual({ notice: recovered });
  expect(() => readyPersistent(ready(newHistory), cut)).toThrow("Expected");
  expect(() =>
    readyPersistent(ready({ ...recovered, durablePublicationCut: { ...cut, generation: 1 } }), cut),
  ).toThrow("Expected");
  expect(() =>
    readyPersistent(
      ready({ ...recovered, durablePublicationCut: { ...cut, history: "other" } }),
      cut,
    ),
  ).toThrow("Expected");
  expect(() => readyPersistent(ready({ ...recovered, oldCapabilities: "restored" }), cut)).toThrow(
    "Expected",
  );
  expect(() =>
    readyPersistent(ready({ ...recovered, oldMutationOutcomes: "not-restored" }), cut),
  ).toThrow("Expected");
  expect(() => readyPersistent({ ready: false }, cut)).toThrow("not ready");
});
