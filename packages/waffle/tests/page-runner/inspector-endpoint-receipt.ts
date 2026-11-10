// Adapted from the original November 6 endpoint helper receipt parser.
// Only assigned-mode parsing remains; selected device comes from the sole SafariDriver.
// Exact parser for the helper's JSON receipt. Returns a typed unique endpoint or a refusal; never a partial.

const LAUNCHD_BASENAME = "launchd_sim";
const SOCKET_BASENAME = "com.apple.webinspectord_sim.socket";
export const RECEIPT_MAX_BYTES = 16384;
const SUN_MAX_LEN = 106;
const UUID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

const REFUSAL_CODES = [
  "USAGE",
  "DEADLINE",
  "LIST_FAILED",
  "TRUNCATED",
  "PATH_UNREADABLE",
  "NO_PROCESS",
  "DUPLICATE_PROCESS",
  "NEAR_MISS",
  "UNRECOGNIZED_CANDIDATE",
  "UNREADABLE_CANDIDATE",
  "GENERATION_READ",
  "GENERATION_CHANGED",
  "UID_MISMATCH",
  "ZOMBIE",
  "EXECUTABLE_DISAGREES",
  "EXECUTABLE_UNEXPECTED",
  "FD_LIST_FAILED",
  "FD_QUERY_FAILED",
  "UNCERTAIN_ADDRESS",
  "NO_SOCKET",
  "DUPLICATE_SOCKET",
  "SOCKET_CHANGED",
  "SOCKET_NOT_LISTENING",
  "PATH_NODE",
  "BOOT_SESSION",
  "INTERNAL",
] as const;
type RefusalCode = (typeof REFUSAL_CODES)[number];

export type Expectation = { readonly deviceId: string };

type Counts = {
  readonly ownUidPids: number;
  readonly vanished: number;
  readonly candidates: number;
  readonly match: number;
  readonly foreign: number;
  readonly nearMiss: number;
  readonly unrecognized: number;
  readonly unreadable: number;
  readonly unixSocketsSeen: number;
  readonly invalidUnixAddresses: number;
  readonly elapsedMs: number;
};

export type UniqueEndpoint = {
  readonly kind: "unique";
  readonly mode: "assigned" | "control";
  readonly deviceId: string;
  readonly bootSession: string;
  readonly helper: { readonly pid: number; readonly uid: number };
  readonly process: {
    readonly pid: number;
    readonly uid: number;
    readonly executablePath: string;
    readonly executableUUID: string;
    readonly argc: number;
    readonly argv1: string;
    readonly generation: {
      readonly startSec: number;
      readonly startUsec: number;
      readonly startAbstime: number;
    };
  };
  readonly socket: {
    readonly path: string;
    readonly addressLength: number;
    readonly descriptorCount: number;
    readonly node: { readonly uid: number; readonly dev: number; readonly ino: number };
  };
  readonly counts: Counts;
  // Fixed limits of this receipt. They never become true here.
  readonly pathNodeBoundToDescriptor: false;
  readonly inspectorConnected: false;
  readonly wirOwnership: false;
};

export type Refusal = {
  readonly kind: "refused";
  readonly code: RefusalCode;
  readonly call: string | null;
  readonly errno: number;
  readonly counts: Counts | null;
  readonly detail: string;
};

type Json = Record<string, unknown>;

class ReceiptError extends Error {}

function fail(detail: string): never {
  throw new ReceiptError(detail);
}

function object(value: unknown, keys: readonly string[], where: string): Json {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(`${where}: object required`);
  const actual = Object.keys(value).toSorted();
  const wanted = keys.toSorted();
  if (actual.join(",") !== wanted.join(","))
    fail(`${where}: keys ${actual.join(",")} != ${wanted.join(",")}`);
  return value as Json;
}

function count(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    fail(`${where}: nonnegative integer required`);
  return value;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${where}: nonempty string required`);
  return value;
}

function exactly(value: unknown, wanted: unknown, where: string): void {
  if (value !== wanted) fail(`${where}: expected ${String(wanted)}`);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function hasControlCharacters(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function canonicalAbsolute(path: string, where: string): readonly string[] {
  if (!path.startsWith("/") || path.endsWith("/")) fail(`${where}: absolute path required`);
  const parts = path.slice(1).split("/");
  if (parts.some((part) => part === "" || part === "." || part === ".."))
    fail(`${where}: non-canonical path`);
  if (hasControlCharacters(path)) fail(`${where}: control character`);
  return parts;
}

function countFolded(haystack: string, needle: string): number {
  return haystack.toUpperCase().split(needle.toUpperCase()).length - 1;
}

function checkArgv1(argv1: string, deviceId: string): void {
  const parts = canonicalAbsolute(argv1, "process.argv1");
  const slots = parts.flatMap((part, index) =>
    part === "CoreSimulator" && parts[index + 1] === "Devices" && index + 2 < parts.length
      ? [parts[index + 2]]
      : [],
  );
  if (slots.length !== 1 || slots[0] !== deviceId)
    fail("process.argv1: exactly one CoreSimulator/Devices/<device> slot required");
  if (countFolded(argv1, deviceId) !== 1) fail("process.argv1: device id must appear exactly once");
}

function parseCounts(value: unknown): Counts {
  const keys = [
    "ownUidPids",
    "vanished",
    "candidates",
    "match",
    "foreign",
    "nearMiss",
    "unrecognized",
    "unreadable",
    "unixSocketsSeen",
    "invalidUnixAddresses",
    "elapsedMs",
  ] as const;
  const raw = object(value, keys, "enumeration");
  const entries = keys.map((key) => [key, count(raw[key], `enumeration.${key}`)] as const);
  return Object.fromEntries(entries) as Counts;
}

function checkTarget(raw: Json, expect: Expectation): string {
  const target = object(
    raw.target,
    ["deviceId", "executableBasename", "socketBasename", "expectExecutable"],
    "target",
  );
  if (!UUID.test(expect.deviceId)) fail("selected Simulator must be a canonical UUID");
  exactly(target.deviceId, expect.deviceId, "target.deviceId");
  exactly(target.executableBasename, LAUNCHD_BASENAME, "target.executableBasename");
  exactly(target.socketBasename, SOCKET_BASENAME, "target.socketBasename");
  if (target.expectExecutable !== null)
    canonicalAbsolute(
      text(target.expectExecutable, "target.expectExecutable"),
      "target.expectExecutable",
    );
  return expect.deviceId;
}

function checkClaims(value: unknown): void {
  const claims = object(
    value,
    [
      "endpointMetadataOnly",
      "inspectorConnected",
      "attached",
      "wirOwnership",
      "eventDelivery",
      "environmentBytesCopied",
      "environmentParsed",
      "environmentEmitted",
    ],
    "claims",
  );
  exactly(claims.endpointMetadataOnly, true, "claims.endpointMetadataOnly");
  exactly(
    claims.environmentBytesCopied,
    "KERNEL_POLICY_DEPENDENT",
    "claims.environmentBytesCopied",
  );
  for (const key of [
    "inspectorConnected",
    "attached",
    "wirOwnership",
    "eventDelivery",
    "environmentParsed",
    "environmentEmitted",
  ])
    exactly(claims[key], false, `claims.${key}`);
}

function parseRefusal(raw: Json, counts: Counts): Refusal {
  const refusal = object(raw.refusal, ["code", "call", "errno"], "refusal");
  const code = text(refusal.code, "refusal.code");
  if (!(REFUSAL_CODES as readonly string[]).includes(code)) fail("refusal.code: unknown");
  exactly(raw.process, null, "process");
  exactly(raw.socket, null, "socket");
  const call = refusal.call === null ? null : text(refusal.call, "refusal.call");
  return {
    kind: "refused",
    code: code as RefusalCode,
    call,
    errno: count(refusal.errno, "refusal.errno"),
    counts,
    detail: "helper refused",
  };
}

function parseProcess(
  value: unknown,
  deviceId: string,
  helper: { pid: number; uid: number },
  exe: string,
): UniqueEndpoint["process"] {
  const raw = object(
    value,
    ["pid", "uid", "executablePath", "executableUUID", "argc", "argv1", "generation"],
    "process",
  );
  const pid = count(raw.pid, "process.pid");
  if (pid === 0 || pid === helper.pid) fail("process.pid: must be another live process");
  exactly(raw.uid, helper.uid, "process.uid");
  const executablePath = text(raw.executablePath, "process.executablePath");
  canonicalAbsolute(executablePath, "process.executablePath");
  exactly(basename(executablePath), exe, "process.executablePath basename");
  const executableUUID = text(raw.executableUUID, "process.executableUUID");
  if (!/^[0-9a-f]{32}$/.test(executableUUID))
    fail("process.executableUUID: 32 hex digits required");
  const argc = count(raw.argc, "process.argc");
  if (argc < 2) fail("process.argc: at least 2 required");
  const argv1 = text(raw.argv1, "process.argv1");
  checkArgv1(argv1, deviceId);
  const generation = object(
    raw.generation,
    ["kind", "startSec", "startUsec", "startAbstime", "stableAcrossReads"],
    "process.generation",
  );
  exactly(generation.kind, "MONOTONIC_START_TUPLE", "process.generation.kind");
  exactly(generation.stableAcrossReads, true, "process.generation.stableAcrossReads");
  const startUsec = count(generation.startUsec, "process.generation.startUsec");
  if (startUsec >= 1_000_000) fail("process.generation.startUsec: below one second required");
  const startAbstime = count(generation.startAbstime, "process.generation.startAbstime");
  return {
    pid,
    uid: helper.uid,
    executablePath,
    executableUUID,
    argc,
    argv1,
    generation: {
      startSec: count(generation.startSec, "process.generation.startSec"),
      startUsec,
      startAbstime,
    },
  };
}

function parseSocket(
  value: unknown,
  helperUid: number,
  socketBasename: string,
): UniqueEndpoint["socket"] {
  const raw = object(
    value,
    [
      "path",
      "addressLength",
      "type",
      "listening",
      "descriptorCount",
      "descriptorPasses",
      "pathNode",
      "pathNodeBoundToDescriptor",
    ],
    "socket",
  );
  const path = text(raw.path, "socket.path");
  canonicalAbsolute(path, "socket.path");
  exactly(basename(path), socketBasename, "socket.path basename");
  const pathBytes = new TextEncoder().encode(path).length;
  const addressLength = count(raw.addressLength, "socket.addressLength");
  if (addressLength < pathBytes + 2) fail("socket.addressLength: must cover the path");
  if (addressLength > SUN_MAX_LEN) fail("socket.addressLength: exceeds sockaddr_un");
  exactly(raw.type, "stream", "socket.type");
  exactly(raw.listening, true, "socket.listening");
  exactly(raw.descriptorPasses, 2, "socket.descriptorPasses");
  exactly(raw.pathNodeBoundToDescriptor, false, "socket.pathNodeBoundToDescriptor");
  const descriptorCount = count(raw.descriptorCount, "socket.descriptorCount");
  if (descriptorCount === 0) fail("socket.descriptorCount: at least one required");
  const node = object(
    raw.pathNode,
    ["canonical", "isSocket", "uid", "dev", "ino"],
    "socket.pathNode",
  );
  exactly(node.canonical, true, "socket.pathNode.canonical");
  exactly(node.isSocket, true, "socket.pathNode.isSocket");
  exactly(node.uid, helperUid, "socket.pathNode.uid");
  return {
    path,
    addressLength,
    descriptorCount,
    node: {
      uid: helperUid,
      dev: count(node.dev, "socket.pathNode.dev"),
      ino: count(node.ino, "socket.pathNode.ino"),
    },
  };
}

function decode(bytes: Uint8Array): Json {
  if (bytes.length === 0 || bytes.length > RECEIPT_MAX_BYTES) fail("receipt size out of bounds");
  if (bytes[bytes.length - 1] !== 0x0a) fail("receipt must end with one newline");
  const body = new TextDecoder("utf-8", { fatal: true }).decode(
    bytes.subarray(0, bytes.length - 1),
  );
  if (body.includes("\n")) fail("receipt must be one line");
  return object(
    JSON.parse(body),
    [
      "schema",
      "mode",
      "outcome",
      "refusal",
      "target",
      "helper",
      "bootSession",
      "enumeration",
      "process",
      "socket",
      "claims",
    ],
    "receipt",
  );
}

/** Parses helper stdout. Throws ReceiptError for anything malformed; returns a Refusal for a well-formed refusal. */
export function parseReceipt(bytes: Uint8Array, expect: Expectation): UniqueEndpoint | Refusal {
  const raw = decode(bytes);
  exactly(raw.schema, "wih.endpoint.1", "schema");
  exactly(raw.mode, "assigned", "mode");
  const deviceId = checkTarget(raw, expect);
  const helperRaw = object(raw.helper, ["pid", "uid", "deadlineMs"], "helper");
  const helper = {
    pid: count(helperRaw.pid, "helper.pid"),
    uid: count(helperRaw.uid, "helper.uid"),
  };
  const deadlineMs = count(helperRaw.deadlineMs, "helper.deadlineMs");
  if (deadlineMs === 0 || deadlineMs > 30000) fail("helper.deadlineMs out of bounds");
  checkClaims(raw.claims);
  const counts = parseCounts(raw.enumeration);
  if (raw.outcome === "REFUSED") return parseRefusal(raw, counts);
  exactly(raw.outcome, "UNIQUE_ENDPOINT", "outcome");
  exactly(raw.refusal, null, "refusal");
  const bootSession = text(raw.bootSession, "bootSession");
  if (!UUID.test(bootSession)) fail("bootSession: canonical UUID required");
  if (
    counts.match !== 1 ||
    counts.nearMiss !== 0 ||
    counts.unrecognized !== 0 ||
    counts.unreadable !== 0
  )
    fail("enumeration: not unique");
  if (counts.candidates < 1 || counts.candidates !== counts.match + counts.foreign)
    fail("enumeration: candidate total disagrees");
  const exe = LAUNCHD_BASENAME;
  const socketName = SOCKET_BASENAME;
  return {
    kind: "unique",
    mode: "assigned",
    deviceId,
    bootSession,
    helper,
    counts,
    process: parseProcess(raw.process, deviceId, helper, exe),
    socket: parseSocket(raw.socket, helper.uid, socketName),
    pathNodeBoundToDescriptor: false,
    inspectorConnected: false,
    wirOwnership: false,
  };
}
