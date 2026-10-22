import { expect, test } from "bun:test";
import {
  failureReasons,
  failureValue,
  observe,
  pending,
  verifyOriginalWorkerLocation,
  type Stage,
} from "./filesystem-shutdown-browser.js";

// Saved Firefox observations used root-relative raw URLs and absolute live locations.
const nonce = "waffle-retirement-firefox-success-2dd83c54-70db-43cb-8244-4767d933abba";
const raw = `/filesystem-shutdown-worker.js?nonce=${nonce}`;
const live = `http://127.0.0.1:41681${raw}`;
function fulfilled(value: string): Stage<string> {
  return { kind: "fulfilled", value };
}
function verify(rawUrl = raw, evaluatedLocation = live): void {
  verifyOriginalWorkerLocation(fulfilled(rawUrl), fulfilled(evaluatedLocation), nonce);
}

test("accepts the same original address with Firefox relative raw URL", () => {
  expect(() => verify()).not.toThrow();
});

test("accepts an absolute original raw URL", () => {
  expect(() => verify(live)).not.toThrow();
});

test("rejects an independently evaluated live nonce mismatch", () => {
  const wrong = live.replace(nonce, "different-original");
  expect(() => verify(wrong, wrong)).toThrow("Wrong original live nonce");
});

test("rejects mismatched original origin, path or query", () => {
  const mismatches = [
    live.replace("41681", "41682"),
    raw.replace("filesystem-shutdown-worker", "replacement-worker"),
    `${raw}&replacement=true`,
    raw.replace(nonce, "different-original"),
  ];
  for (const mismatch of mismatches)
    expect(() => verify(mismatch)).toThrow("Raw and evaluated original worker URLs differ");
  expect(() => verify(live, live.replace("41681", "41682"))).toThrow(
    "Raw and evaluated original worker URLs differ",
  );
});

test("missing or invalid observations cannot pass", () => {
  const absent: Stage<string>[] = [pending(), { kind: "invalid", cause: "observer absent" }];
  for (const missing of absent) {
    expect(() => verifyOriginalWorkerLocation(missing, fulfilled(live), nonce)).toThrow();
    expect(() => verifyOriginalWorkerLocation(fulfilled(live), missing, nonce)).toThrow();
  }
});

async function requireOriginalRejection(
  rawUrl: Stage<string>,
  evaluatedLocation: Stage<string>,
  reason: unknown,
): Promise<void> {
  const result = await observe(
    Promise.resolve().then(() => verifyOriginalWorkerLocation(rawUrl, evaluatedLocation, nonce)),
  );
  expect(result.kind).toBe("rejected");
  if (result.kind !== "rejected") throw new Error("Original observer rejection missing");
  expect(result.reason).toBe(reason);
}

test("preserves exact raw and live observer rejections including falsy reasons", async () => {
  for (const label of failureReasons) {
    const reason = failureValue(label);
    await requireOriginalRejection({ kind: "rejected", reason }, fulfilled(live), reason);
    await requireOriginalRejection(fulfilled(live), { kind: "rejected", reason }, reason);
  }
});

test("keeps raw evidence separate and unchanged after address comparison", () => {
  const rawUrl = fulfilled(raw);
  const evaluatedLocation = fulfilled(live);
  const rawBefore = structuredClone(rawUrl);
  const liveBefore = structuredClone(evaluatedLocation);
  expect(() => verifyOriginalWorkerLocation(rawUrl, evaluatedLocation, nonce)).not.toThrow();
  expect(rawUrl).toEqual(rawBefore);
  expect(evaluatedLocation).toEqual(liveBefore);
});

test("rejects malformed or missing absolute live addresses", () => {
  expect(() => verify(live, raw)).toThrow();
  expect(() => verify("http://[")).toThrow();
});
