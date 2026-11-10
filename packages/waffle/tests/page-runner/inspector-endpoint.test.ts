import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inspectorEndpoint } from "./inspector-endpoint.js";
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

async function liveFixture() {
  const root = await mkdtemp("/work/tmp/wi-endpoint-");
  const path = join(root, "com.apple.webinspectord_sim.socket");
  const server = createServer();
  const cleanup = async () => {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    const node = await lstat(path);
    const value = receipt();
    value.helper.uid = value.process.uid = value.socket.pathNode.uid = node.uid;
    value.socket.path = path;
    value.socket.addressLength = Buffer.byteLength(path) + 2;
    value.socket.pathNode.dev = node.dev;
    value.socket.pathNode.ino = node.ino;
    const saved = join(root, "receipt.json");
    const current = join(root, "current.json");
    const helper = join(root, "helper.ts");
    await writeFile(saved, bytes(value));
    await writeFile(current, bytes(value));
    await writeFile(
      helper,
      `#!${process.execPath}
import { readFileSync } from "node:fs";
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["discover", "--udid", "${udid}", "--deadline-ms", "5000"])) process.exit(2);
process.stdout.write(readFileSync(${JSON.stringify(current)}));
`,
      { mode: 0o700 },
    );
    return { value, saved, current, helper, path, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

test("endpoint reader refuses a shaped live socket receipt without available freshness checks", async () => {
  const f = await liveFixture();
  try {
    await expect(inspectorEndpoint(f.saved, udid, "/missing/endpoint-helper")).rejects.toThrow();
    await expect(inspectorEndpoint(f.saved, udid, "")).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});

for (const field of [
  "boot",
  "pid",
  "generation",
  "executable",
  "argv",
  "device",
  "socket",
  "uid",
]) {
  test(`endpoint reader rejects changed live ${field} binding despite an unchanged socket node`, async () => {
    const f = await liveFixture();
    try {
      const value = f.value;
      if (field === "boot") value.bootSession = "22222222-2222-2222-2222-222222222222";
      if (field === "pid") value.process.pid++;
      if (field === "generation") value.process.generation.startAbstime++;
      if (field === "executable") value.process.executableUUID = "2".repeat(32);
      if (field === "argv") value.process.argv1 += "/changed";
      if (field === "device") value.target.deviceId = "22222222-2222-2222-2222-222222222222";
      if (field === "socket") value.socket.pathNode.ino++;
      if (field === "uid") value.helper.uid = value.process.uid = value.socket.pathNode.uid = 99;
      await writeFile(f.current, bytes(value));
      await expect(inspectorEndpoint(f.saved, udid, f.helper)).rejects.toThrow();
    } finally {
      await f.cleanup();
    }
  });
}

test("endpoint reader accepts matching freshly invoked helper metadata without stronger claims", async () => {
  const f = await liveFixture();
  try {
    f.value.helper.pid += 10;
    f.value.enumeration.elapsedMs++;
    await writeFile(f.current, bytes(f.value));
    await expect(inspectorEndpoint(f.saved, udid, f.helper)).resolves.toBe(f.path);
    await writeFile(f.current, Buffer.from("truncated"));
    await expect(inspectorEndpoint(f.saved, udid, f.helper)).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});

test("endpoint reader refuses a live helper refusal or failed invocation", async () => {
  const f = await liveFixture();
  try {
    await writeFile(
      f.current,
      bytes({
        ...f.value,
        outcome: "REFUSED",
        refusal: { code: "NO_PROCESS", call: null, errno: 0 },
        process: null,
        socket: null,
      }),
    );
    await expect(inspectorEndpoint(f.saved, udid, f.helper)).rejects.toThrow("live helper refused");
    await writeFile(f.helper, `#!${process.execPath}\nprocess.exit(2);\n`);
    await expect(inspectorEndpoint(f.saved, udid, f.helper)).rejects.toThrow();
  } finally {
    await f.cleanup();
  }
});
