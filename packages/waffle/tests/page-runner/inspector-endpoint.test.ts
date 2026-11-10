import { expect, test } from "bun:test";
import { parseReceipt } from "./inspector-endpoint-receipt.js";

const udid = "10128D70-92A7-4626-9CE5-1537CF27BE84";
function receipt() {
  return {
    schema: "wih.endpoint.1",
    mode: "assigned",
    outcome: "UNIQUE_ENDPOINT",
    refusal: null,
    target: {
      deviceId: udid,
      executableBasename: "launchd_sim",
      socketBasename: "com.apple.webinspectord_sim.socket",
      expectExecutable: null,
    },
    helper: { pid: 1, uid: 501, deadlineMs: 3000 },
    bootSession: "11111111-1111-1111-1111-111111111111",
    enumeration: {
      ownUidPids: 2,
      vanished: 0,
      candidates: 1,
      match: 1,
      foreign: 0,
      nearMiss: 0,
      unrecognized: 0,
      unreadable: 0,
      unixSocketsSeen: 1,
      invalidUnixAddresses: 0,
      elapsedMs: 1,
    },
    process: {
      pid: 2,
      uid: 501,
      executablePath: "/system/launchd_sim",
      executableUUID: "1".repeat(32),
      argc: 2,
      argv1: `/owned/CoreSimulator/Devices/${udid}/data`,
      generation: {
        kind: "MONOTONIC_START_TUPLE",
        startSec: 1,
        startUsec: 2,
        startAbstime: 3,
        stableAcrossReads: true,
      },
    },
    socket: {
      path: "/owned/com.apple.webinspectord_sim.socket",
      addressLength: 44,
      type: "stream",
      listening: true,
      descriptorCount: 1,
      descriptorPasses: 2,
      pathNode: { canonical: true, isSocket: true, uid: 501, dev: 1, ino: 2 },
      pathNodeBoundToDescriptor: false,
    },
    claims: {
      endpointMetadataOnly: true,
      inspectorConnected: false,
      attached: false,
      wirOwnership: false,
      eventDelivery: false,
      environmentBytesCopied: "KERNEL_POLICY_DEPENDENT",
      environmentParsed: false,
      environmentEmitted: false,
    },
  };
}
const bytes = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
test("reused complete helper parser accepts exact assigned identity without claiming Inspector support", () => {
  const result = parseReceipt(bytes(receipt()), { deviceId: udid });
  expect(result.kind).toBe("unique");
  if (result.kind !== "unique") throw new Error("CPU receipt rejected");
  expect(result.inspectorConnected).toBe(false);
  expect(result.wirOwnership).toBe(false);
  expect(result.process.generation.startAbstime).toBe(3);
});
test("helper parser refuses wrong device, UID, unstable generation, ambiguous endpoint and invented fields", () => {
  expect(() =>
    parseReceipt(bytes(receipt()), { deviceId: "22222222-2222-2222-2222-222222222222" }),
  ).toThrow();
  const uid = receipt();
  uid.process.uid = 99;
  expect(() => parseReceipt(bytes(uid), { deviceId: udid })).toThrow();
  const unstable = receipt();
  unstable.process.generation.stableAcrossReads = false;
  expect(() => parseReceipt(bytes(unstable), { deviceId: udid })).toThrow();
  const ambiguous = receipt();
  ambiguous.enumeration.match = 2;
  expect(() => parseReceipt(bytes(ambiguous), { deviceId: udid })).toThrow();
  expect(() => parseReceipt(bytes({ ...receipt(), extra: true }), { deviceId: udid })).toThrow();
});
