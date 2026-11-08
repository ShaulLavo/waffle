import { expect, test } from "bun:test";
import { ownershipPeerInput } from "./fixtures/gpu/peer-input.js";

test("peer input waits until another frame checkpoint", () => {
  expect(ownershipPeerInput(0, 0)).toBe("wait");
  expect(ownershipPeerInput(12, 12)).toBe("wait");
});
test("peer input feeds below the unchanged frame cap", () => {
  expect(ownershipPeerInput(1, 0)).toBe("feed");
  expect(ownershipPeerInput(239, 238)).toBe("feed");
});
test("reaching exactly 240 frames exhausts rather than exceeds the workload", () => {
  expect(ownershipPeerInput(240, 239)).toBe("exhausted");
});
test("passing 240 frames still reports a workload error", () => {
  expect(ownershipPeerInput(241, 239)).toBe("exceeded");
});
