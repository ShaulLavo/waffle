import {
  closeSync,
  fsyncSync,
  mkdirSync,
  linkSync,
  unlinkSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Browser, BrowserContext } from "playwright";
import {
  assertNavigationCaptureReady,
  navigationCaptureSnapshot,
  navigationDiagnosticErrors,
  startNavigationCapture,
  stopNavigationCapture,
  waitForNavigationCapture,
} from "./process-navigation-observer.ts";

export const rootHTML = "<!doctype html><title>Process transport tests</title>";
export const rootHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Content-Type": "text/html",
};
const limit = 16 * 1024 * 1024;
const navigationHeader = "x-waffle-navigation-id";
const require = createRequire(import.meta.url);

export type RootReceipt = { navigationId: string; clientPort: number; serverPort: number };
type Packet = {
  time: string;
  from: number;
  to: number;
  sequence: number;
  ack: number;
  flags: number;
  payload: Buffer;
};
export type WireResult =
  | { kind: "censored"; reason: string }
  | {
      kind: "correlated";
      requestHex: string;
      responseHex: string;
      response: "absent" | "partial" | "complete" | "acknowledged";
      packets: number;
    };

function tcpPacket(bytes: Buffer, time: string): Packet {
  if (bytes.length < 54 || bytes.readUInt16BE(12) !== 0x0800)
    throw new Error("Expected complete Ethernet IPv4 TCP packet");
  const ip = 14;
  const ipLength = (bytes[ip]! & 15) * 4;
  const total = bytes.readUInt16BE(ip + 2);
  if (bytes[ip]! >> 4 !== 4 || ipLength < 20 || bytes.length < ip + total)
    throw new Error("Truncated or invalid IPv4 packet");
  if (bytes[ip + 9] !== 6 || (bytes.readUInt16BE(ip + 6) & 0x3fff) !== 0)
    throw new Error("Unsupported non-TCP or fragmented packet");
  if (bytes.readUInt32BE(ip + 12) !== 0x7f000001 || bytes.readUInt32BE(ip + 16) !== 0x7f000001)
    throw new Error("Capture escaped owned loopback");
  const tcp = ip + ipLength;
  const tcpLength = (bytes[tcp + 12]! >> 4) * 4;
  if (tcpLength < 20 || ipLength + tcpLength > total) throw new Error("Invalid TCP header");
  return {
    time,
    from: bytes.readUInt16BE(tcp),
    to: bytes.readUInt16BE(tcp + 2),
    sequence: bytes.readUInt32BE(tcp + 4),
    ack: bytes.readUInt32BE(tcp + 8),
    flags: bytes[tcp + 13]!,
    payload: bytes.subarray(tcp + tcpLength, ip + total),
  };
}

export function decodeWire(text: string): Packet[] {
  const packets: Packet[] = [];
  let time = "";
  let hex = "";
  for (const line of text.split("\n")) {
    const header = /^(\d+\.\d+) IP /.exec(line);
    if (header) {
      if (hex) packets.push(tcpPacket(Buffer.from(hex, "hex"), time));
      time = header[1]!;
      hex = "";
      continue;
    }
    const row = /^\s*0x([0-9a-f]+):\s+([0-9a-f ]+)\s*$/.exec(line);
    if (!row) continue;
    if (!time || Number.parseInt(row[1]!, 16) !== hex.length / 2)
      throw new Error("Missing or reordered packet hex row");
    const words = row[2]!.replaceAll(" ", "");
    if (words.length % 2 !== 0 || words.length > 32) throw new Error("Invalid packet hex row");
    hex += words;
  }
  if (hex) packets.push(tcpPacket(Buffer.from(hex, "hex"), time));
  return packets;
}

function stream(packets: readonly Packet[]): { bytes: Buffer; start: number } {
  const syns = packets.filter((packet) => packet.flags & 2);
  const starts = new Set(syns.map((packet) => packet.sequence));
  if (starts.size !== 1) throw new Error("Missing SYN or ambiguous connection reuse");
  const start = (syns[0]!.sequence + 1) >>> 0;
  const bytes = new Map<number, number>();
  for (const packet of packets) insertSegment(bytes, packet, start);
  const offsets = Array.from(bytes.keys()).sort((a, b) => a - b);
  if (offsets.some((offset, index) => offset !== index)) throw new Error("TCP payload hole");
  return { bytes: Buffer.from(offsets.map((offset) => bytes.get(offset)!)), start };
}

function insertSegment(bytes: Map<number, number>, packet: Packet, start: number): void {
  const offset = (packet.sequence + (packet.flags & 2 ? 1 : 0) - start) >>> 0;
  if (packet.payload.length && offset + packet.payload.length > limit)
    throw new Error("TCP stream exceeds diagnostic bound");
  for (const [index, byte] of packet.payload.entries()) {
    const existing = bytes.get(offset + index);
    if (existing !== undefined && existing !== byte) throw new Error("Conflicting retransmission");
    bytes.set(offset + index, byte);
  }
}

function responseComplete(bytes: Buffer): boolean {
  const split = bytes.indexOf("\r\n\r\n");
  if (split === -1) return false;
  const header = bytes.subarray(0, split).toString("latin1");
  if (!/^HTTP\/1\.1 200 (?:OK)?\r\n/i.test(`${header}\r\n`)) return false;
  if (!/^content-length: 53\r?$/im.test(header)) return false;
  const headers = new Headers(
    header
      .split("\r\n")
      .slice(1)
      .map((line): [string, string] => {
        const colon = line.indexOf(":");
        return [line.slice(0, colon), line.slice(colon + 1).trim()];
      }),
  );
  for (const [name, value] of Object.entries(rootHeaders)) {
    if (headers.get(name) !== value) return false;
  }
  return bytes.subarray(split + 4).equals(Buffer.from(rootHTML));
}

export function correlateWire(text: string, receipt: RootReceipt): WireResult {
  try {
    const packets = decodeWire(text);
    const outgoing = packets.filter(
      (packet) => packet.from === receipt.clientPort && packet.to === receipt.serverPort,
    );
    const incoming = packets.filter(
      (packet) => packet.from === receipt.serverPort && packet.to === receipt.clientPort,
    );
    const request = stream(outgoing).bytes;
    const response = stream(incoming);
    const headers = request.toString("latin1").split("\r\n");
    if (
      headers[0] !== "GET / HTTP/1.1" ||
      headers.filter((line) => line.toLowerCase().startsWith(`${navigationHeader}:`)).length !== 1
    )
      throw new Error("Missing unique root request");
    if (
      !headers.some(
        (line) =>
          line.slice(0, line.indexOf(":")).toLowerCase() === navigationHeader &&
          line.slice(line.indexOf(":") + 1).trim() === receipt.navigationId,
      )
    )
      throw new Error("Navigation ID does not match request bytes");
    if (!request.includes("\r\n\r\n")) throw new Error("Incomplete request headers");
    const complete = responseComplete(response.bytes);
    const end = (response.start + response.bytes.length) >>> 0;
    const acked =
      complete &&
      outgoing.some((packet) => (packet.flags & 16) !== 0 && (packet.ack - end) >>> 0 < 0x80000000);
    return {
      kind: "correlated",
      requestHex: request.toString("hex"),
      responseHex: response.bytes.toString("hex"),
      response: acked
        ? "acknowledged"
        : complete
          ? "complete"
          : response.bytes.length
            ? "partial"
            : "absent",
      packets: outgoing.length + incoming.length,
    };
  } catch (error) {
    return { kind: "censored", reason: reasonText(error) };
  }
}

export function captureRecordsIntact(state: ReturnType<typeof navigationCaptureSnapshot>): boolean {
  try {
    const count = /(?:^|\n)(\d+) packets captured\n/.exec(state.diagnostics.text);
    return (
      state.ready &&
      state.snaplen === 0 &&
      state.stopped &&
      state.exitCode === 0 &&
      state.durable &&
      !state.unexpectedExit &&
      state.failureCount === 0 &&
      state.output.evictedBytes === 0 &&
      state.diagnostics.evictedBytes === 0 &&
      state.errors.evictedBytes === 0 &&
      state.format === "ethernet-hex" &&
      state.diagnostics.text.includes("link-type EN10MB") &&
      /(?:^|\n)0 packets dropped by kernel\n/.test(state.diagnostics.text) &&
      count !== null &&
      decodeWire(state.output.text).length === Number(count[1])
    );
  } catch {
    return false;
  }
}

export function classify(
  gotoFailure: boolean,
  complete: boolean,
  results: readonly WireResult[],
): string {
  if (!complete || results.length === 0 || results.some((result) => result.kind === "censored"))
    return "CENSORED_CAPTURE";
  if (gotoFailure) return "CENSORED_CAPTURE";
  if (results.some((result) => result.kind !== "correlated" || result.response !== "acknowledged"))
    return "CENSORED_CAPTURE";
  return "NONREPRODUCTION";
}

export function durableRoot(directory: string): string {
  if (!isAbsolute(directory)) throw new Error("Evidence path must be absolute and task-owned");
  const root = realpathSync(directory);
  const scratch = realpathSync(process.env.TMPDIR ?? "/tmp");
  const path = relative(scratch, root);
  if (path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`)))
    throw new Error("Evidence must be outside disposable TMPDIR");
  return root;
}

export function durableJSON(path: string, value: unknown): void {
  const pending = `${path}.${randomUUID()}.pending`;
  const fd = openSync(pending, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(pending, path);
  } finally {
    unlinkSync(pending);
  }
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type Primary = { kind: "none" } | { kind: "rejected"; reason: unknown };

function reasonText(reason: unknown): string {
  try {
    return String(reason);
  } catch {
    return "<unprintable rejection reason>";
  }
}

export class Failures {
  private current: Primary = { kind: "none" };
  get primary(): Primary {
    return this.current;
  }
  readonly cleanupErrors: string[] = [];
  readonly unresolved: string[] = [];

  fail(reason: unknown): void {
    if (this.current.kind === "none") this.current = { kind: "rejected", reason };
  }
  secondary(name: string, reason: unknown): void {
    this.fail(reason);
    this.cleanupErrors.push(`${name}: ${reasonText(reason)}`);
    if (!this.unresolved.includes(name)) this.unresolved.push(name);
  }
  resolved(name: string): void {
    const index = this.unresolved.indexOf(name);
    if (index !== -1) this.unresolved.splice(index, 1);
  }
  rethrow(): void {
    if (this.primary.kind === "rejected") throw this.primary.reason;
  }
  receipt() {
    const present = this.primary.kind === "rejected";
    return {
      primaryPresent: present,
      primary: this.primary.kind === "rejected" ? reasonText(this.primary.reason) : null,
      primaryType: this.primary.kind === "rejected" ? typeof this.primary.reason : null,
      cleanupErrors: this.cleanupErrors,
      unresolvedOwnership: this.unresolved,
    };
  }
}

export function diagnosticExitStatus(primary: Primary): 0 | 1 {
  return primary.kind === "rejected" ? 1 : 0;
}

class Journal {
  private readonly fd: number;
  private bytes = 0;
  constructor(path: string) {
    this.fd = openSync(path, "wx", 0o600);
    try {
      const directory = openSync(dirname(path), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } catch (error) {
      closeSync(this.fd);
      throw error;
    }
  }
  append(bytes: Uint8Array): void {
    if (this.bytes + bytes.length > limit) throw new Error("Durable journal capacity exceeded");
    let written = 0;
    while (written < bytes.length)
      written += writeSync(this.fd, bytes, written, bytes.length - written);
    fsyncSync(this.fd);
    this.bytes += bytes.length;
  }
  event(kind: string, detail: unknown): void {
    this.append(
      Buffer.from(
        `${JSON.stringify({ kind, wallClockMs: Date.now(), monotonicMs: performance.now(), detail })}\n`,
      ),
    );
  }
  close(): void {
    closeSync(this.fd);
  }
}

function signalGroup(child: Pick<Bun.Subprocess, "pid">, signal: NodeJS.Signals): void {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

async function deadline<T>(operation: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function collectChild(command: string[], directory: string): Promise<number> {
  const root = durableRoot(directory);
  const stdoutPath = join(root, "stdout.bin");
  const journals: Journal[] = [];
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let streams: Promise<unknown> = Promise.resolve();
  const failures = new Failures();
  let status = 1;
  const interrupted = Promise.withResolvers<never>();
  const interrupt = () => interrupted.reject(new Error("Collector interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    journals.push(new Journal(stdoutPath));
    journals.push(new Journal(join(root, "stderr.bin")));
    child = Bun.spawn(command, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
      env: process.env,
    });
    readers.push(child.stdout.getReader(), child.stderr.getReader());
    streams = Promise.all([
      collectStream(readers[0]!, journals[0]!, stdoutPath, root),
      collectStream(readers[1]!, journals[1]!),
    ]);
    void streams.catch(() => {});
    durableJSON(join(root, "collector-owner.json"), {
      pid: child.pid,
      command,
      host: process.env.HOSTNAME,
    });
    status = await deadline(
      Promise.race([child.exited, interrupted.promise, streams.then(() => child!.exited)]),
      600_000,
      "Original runner overall deadline exceeded",
    );
    await deadline(streams, 2000, "Collector stream drain failed");
  } catch (error) {
    failures.fail(error);
  } finally {
    await cleanupCollection(
      [
        ["child", () => stopCollectedChild(child, failures), 7000],
        ["streams", () => finishStreams(streams, readers, failures), 7000],
      ],
      failures,
    );
    await cleanupCollection(
      journals
        .map((journal, index): Release => [`journal-${index}`, () => journal.close()])
        .concat([
          ["SIGINT-handler", () => process.off("SIGINT", interrupt)],
          ["SIGTERM-handler", () => process.off("SIGTERM", interrupt)],
        ]),
      failures,
    );
  }
  await cleanupCollection(
    [
      [
        "collector-receipt",
        () =>
          durableJSON(join(root, "collector-result.json"), {
            status,
            pid: child?.pid ?? null,
            signalCode: child?.signalCode ?? null,
            ...failures.receipt(),
            stdoutSHA256: journals.length > 0 ? sha256(readFileSync(stdoutPath)) : null,
            stderrSHA256:
              journals.length > 1 ? sha256(readFileSync(join(root, "stderr.bin"))) : null,
          }),
      ],
    ],
    failures,
  );
  if (failures.unresolved.length)
    emergencyReceipt("collector", failures, { pid: child?.pid, command, root });
  failures.rethrow();
  return status;
}

type Release = [name: string, stop: () => unknown, milliseconds?: number];

export async function cleanupCollection(
  stages: readonly Release[],
  failures = new Failures(),
): Promise<void> {
  for (const [name, stop, milliseconds = 2000] of stages) {
    try {
      await deadline(Promise.resolve().then(stop), milliseconds, `${name} release unconfirmed`);
      failures.resolved(name);
    } catch (error) {
      failures.secondary(name, error);
    }
  }
}

function emergencyReceipt(
  owner: string,
  failures: Failures,
  resources: Record<string, unknown>,
): void {
  try {
    writeSync(
      2,
      `ROOT_UNRESOLVED_OWNERSHIP ${JSON.stringify({ owner, resources, ...failures.receipt() })}\n`,
    );
  } catch {
    // The in-memory ledger remains authoritative when both durable sinks fail.
  }
}

export async function stopCollectedChild(
  child: Pick<Bun.Subprocess, "pid" | "exited"> | undefined,
  failures: Failures,
  signal: typeof signalGroup = signalGroup,
): Promise<void> {
  if (!child) return;
  await cleanupCollection(
    [
      ["child-SIGTERM", () => signal(child, "SIGTERM")],
      ["child-term-exit", () => child.exited],
      ["child-SIGKILL", () => signal(child, "SIGKILL")],
      ["child-final-exit", () => child.exited],
    ],
    failures,
  );
}

export async function finishStreams(
  streams: Promise<unknown>,
  readers: Pick<ReadableStreamDefaultReader<Uint8Array>, "cancel" | "releaseLock">[],
  failures: Failures,
): Promise<void> {
  const before = failures.cleanupErrors.length;
  await cleanupCollection([["stream-drain", () => streams]], failures);
  if (failures.cleanupErrors.length !== before)
    await cleanupCollection(
      readers.map((reader, index): Release => [`reader-${index}-cancel`, () => reader.cancel()]),
      failures,
    );
  await cleanupCollection(
    readers.map((reader, index): Release => [`reader-${index}-lock`, () => reader.releaseLock()]),
    failures,
  );
}

async function collectStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  journal: Journal,
  stdoutPath?: string,
  root?: string,
): Promise<void> {
  let prefix = "";
  let acknowledged = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    journal.append(value);
    if (!stdoutPath || !root || acknowledged) continue;
    prefix += Buffer.from(value).toString("utf8");
    const match = /ROOT_COLLECTION_PROBE ([a-f0-9-]+)\n/.exec(prefix);
    if (!match) continue;
    const bytes = readFileSync(stdoutPath);
    if (!bytes.includes(Buffer.from(match[0])))
      throw new Error("Durable collector readback failed");
    durableJSON(join(root, "collection-ack.json"), {
      token: match[1],
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
    acknowledged = true;
    prefix = "";
  }
}

export async function collectionPreflight(root: string): Promise<void> {
  const token = randomUUID();
  writeSync(1, `ROOT_COLLECTION_PROBE ${token}\n`);
  await waitForCollection(root, token);
}

async function waitForCollection(root: string, token: string): Promise<void> {
  const ack = Bun.file(join(root, "collection-ack.json"));
  const start = performance.now();
  while (!(await ack.exists())) {
    if (performance.now() - start >= 5000) throw new Error("Durable collection preflight failed");
    await Bun.sleep(20);
  }
  const value: unknown = JSON.parse(readFileSync(join(root, "collection-ack.json"), "utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    !("token" in value) ||
    value.token !== token ||
    !("bytes" in value) ||
    typeof value.bytes !== "number" ||
    !("sha256" in value)
  )
    throw new Error("Invalid durable collection acknowledgement");
  const bytes = readFileSync(join(root, "stdout.bin")).subarray(0, value.bytes);
  if (
    sha256(bytes) !== value.sha256 ||
    !bytes.includes(Buffer.from(`ROOT_COLLECTION_PROBE ${token}\n`))
  )
    throw new Error("Durable collection bytes do not match acknowledgement");
}

export function assertIdentity(actual: Record<string, string>, expected: unknown): void {
  if (!expected || typeof expected !== "object" || Array.isArray(expected))
    throw new Error("Missing approved identity");
  if (
    actual.playwright !== "1.64.1" ||
    actual.webkit !== "27.2" ||
    actual.revision !== "2370" ||
    actual.bun !== "1.4.4"
  )
    throw new Error("Exact engine/tool versions unavailable");
  for (const [key, value] of Object.entries(actual)) {
    if (Reflect.get(expected, key) !== value) throw new Error(`Identity mismatch: ${key}`);
  }
}

/** Inert original runner from c312af63a554602906b462a2b49c7d5e14a97c5b, not executed by
 * this self-contained root control. The live process suite evolves independently. */
export const historicalRunnerPath = new URL(
  "./fixtures/process-root-navigation-original-runner.txt",
  import.meta.url,
).pathname;

export function assertSourceProvenance(lockfilePath: string, runnerPath: string): void {
  if (
    sha256(readFileSync(lockfilePath)) !==
    "e25a3afea9940c3b270bb48d3803bc1830b1ee41b4496d6a442c3ca51ed20722"
  )
    throw new Error("Lockfile does not match approved diagnostic inputs");
  if (
    sha256(readFileSync(runnerPath)) !==
    "e047547fb7100d46214c378487c206f95c11b9bbfe644a49f9faaf52abc27693"
  )
    throw new Error("Original runner changed");
}

function identity(): Record<string, string> {
  if (process.platform !== "linux")
    throw new Error("Linux process and Ethernet capture hooks required");
  const core = dirname(require.resolve("playwright-core/package.json"));
  const metadata: unknown = JSON.parse(readFileSync(join(core, "browsers.json"), "utf8"));
  if (
    !metadata ||
    typeof metadata !== "object" ||
    !("browsers" in metadata) ||
    !Array.isArray(metadata.browsers)
  )
    throw new Error("Invalid browser manifest");
  const webkit: unknown = metadata.browsers.find(
    (value: unknown) =>
      value !== null && typeof value === "object" && "name" in value && value.name === "webkit",
  );
  if (
    !webkit ||
    typeof webkit !== "object" ||
    !("browserVersion" in webkit) ||
    !("revision" in webkit)
  )
    throw new Error("Missing WebKit identity");
  const packagePath = require.resolve("playwright/package.json");
  const browserRoot = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!browserRoot || !isAbsolute(browserRoot))
    throw new Error("Explicit installed browser root required");
  const executable = join(browserRoot, "webkit-2370", "pw_run.sh");
  const root = dirname(import.meta.dir);
  assertSourceProvenance(join(import.meta.dir, "../../..", "bun.lock"), historicalRunnerPath);
  return {
    historicalRunnerSHA256: sha256(readFileSync(historicalRunnerPath)),
    playwright: String(JSON.parse(readFileSync(packagePath, "utf8")).version),
    webkit: String(webkit.browserVersion),
    revision: String(webkit.revision),
    bun: Bun.version,
    bunSHA256: sha256(readFileSync(process.execPath)),
    tcpdumpSHA256: sha256(readFileSync("/usr/bin/tcpdump")),
    straceSHA256: sha256(readFileSync("/usr/bin/strace")),
    browserManifestSHA256: sha256(readFileSync(join(core, "browsers.json"))),
    webkitLauncherSHA256: sha256(readFileSync(executable)),
    webkitWrapperSHA256: sha256(
      readFileSync(join(dirname(executable), "minibrowser-wpe", "MiniBrowser")),
    ),
    webkitWebProcessSHA256: sha256(
      readFileSync(join(dirname(executable), "minibrowser-wpe", "bin", "WPEWebProcess")),
    ),
    webkitLibrarySHA256: sha256(
      readFileSync(
        join(dirname(executable), "minibrowser-wpe", "lib", "libWPEWebKit-2.0.so.1.12.0"),
      ),
    ),
    webkitBinarySHA256: sha256(
      readFileSync(join(dirname(executable), "minibrowser-wpe", "bin", "MiniBrowser")),
    ),
  };
}

async function processPreflight(root: string): Promise<void> {
  const marker = "ROOT_TRACED_CHILD_STDERR";
  const child = Bun.spawn(
    [process.execPath, "-e", `process.stderr.write("${marker}\\n");process.exit(17)`],
    { stdout: "ignore", stderr: "pipe" },
  );
  const output = await new Response(child.stderr).text();
  if ((await child.exited) !== 17 || output !== `${marker}\n`)
    throw new Error("Child stderr/exit hook failed");
  await waitForProcessTrace(root, child.pid);
}

async function waitForProcessTrace(root: string, pid: number): Promise<void> {
  const exited = new RegExp(
    `\\[pid\\s+${pid}\\]\\s+\\d+\\.\\d+ \\+\\+\\+ exited with 17 \\+\\+\\+`,
  );
  const start = performance.now();
  while (true) {
    if (performance.now() - start >= 5000)
      throw new Error("Descendant process tracing not durably observed");
    const trace = readFileSync(join(root, "stderr.bin"), "utf8");
    if (exited.test(trace) && trace.includes("execve(")) return;
    await Bun.sleep(20);
  }
}

export function hasProtocolCollection(trace: string): boolean {
  return (
    trace.includes("pw:protocol SEND") &&
    /pw:protocol ◀ RECV\b/.test(trace) &&
    /pw:browser.*<launched> pid=\d+/.test(trace) &&
    /execve\(.*MiniBrowser/.test(trace)
  );
}

async function protocolPreflight(root: string): Promise<void> {
  const start = performance.now();
  while (!hasProtocolCollection(readFileSync(join(root, "stderr.bin"), "utf8"))) {
    if (performance.now() - start >= 5000)
      throw new Error("Browser/protocol collection hook unavailable");
    await Bun.sleep(20);
  }
}

export type RunState = {
  browser?: Browser;
  context?: Pick<BrowserContext, "close">;
  server?: Pick<ReturnType<typeof Bun.serve>, "stop" | "port">;
  capture?: { diagnosticPid: number; root: string; serverPort: number; ownerLog: string };
  failures: Failures;
  gotoFailure: boolean;
  attempts: string[];
  receipts: RootReceipt[];
};

async function navigate(state: RunState, journal: Journal, ordinal: number): Promise<void> {
  if (!state.browser) throw new Error("Browser unavailable");
  const navigationId = `page-${ordinal}-target`;
  state.attempts.push(navigationId);
  const context = await state.browser.newContext({
    extraHTTPHeaders: { [navigationHeader]: navigationId },
  });
  state.context = context;
  const page = await context.newPage();
  page.on("response", (response) =>
    runEvent(state, journal, "response", {
      navigationId,
      url: response.url(),
      status: response.status(),
    }),
  );
  page.on("requestfailed", (request) =>
    runEvent(state, journal, "requestfailed", {
      navigationId,
      url: request.url(),
      failure: request.failure(),
    }),
  );
  page.on("crash", () => runEvent(state, journal, "page-crash", { navigationId }));
  page.on("load", () => runEvent(state, journal, "load", { navigationId }));
  page.on("framenavigated", (frame) =>
    runEvent(state, journal, "framenavigated", { navigationId, url: frame.url() }),
  );
  assertNavigationCaptureReady();
  runEvent(state, journal, "goto-begin", { navigationId, deadlineMs: 30000, waitUntil: "load" });
  state.failures.rethrow();
  await runContextAttempt(
    state,
    journal,
    async () => {
      await page.goto(`http://127.0.0.1:${state.server!.port}/`, {
        timeout: 30000,
        waitUntil: "load",
      });
    },
    navigationId,
  );
}

export async function runContextAttempt(
  state: RunState,
  journal: Pick<Journal, "event">,
  action: () => Promise<void>,
  navigationId = "synthetic",
): Promise<void> {
  try {
    await action();
    runEvent(state, journal, "goto-fulfilled", { navigationId });
  } catch (error) {
    state.gotoFailure = true;
    state.failures.fail(error);
    runEvent(state, journal, "goto-rejected", { navigationId, error: reasonText(error) });
  } finally {
    await stopContext(state, journal);
  }
  state.failures.rethrow();
}

async function stopContext(state: RunState, journal: Pick<Journal, "event">): Promise<void> {
  if (!state.context) return;
  const context = state.context;
  await releaseRunResources(state, journal, [
    [
      "context",
      async () => {
        await context.close();
        state.context = undefined;
      },
    ],
  ]);
}

export async function runFreshContexts(
  state: RunState,
  interrupted: () => Error | undefined,
  attempt: (ordinal: number) => Promise<void>,
): Promise<void> {
  for (let ordinal = 1; ordinal <= 50; ordinal++) {
    const error = interrupted();
    if (error) state.failures.fail(error);
    state.failures.rethrow();
    await attempt(ordinal);
    state.failures.rethrow();
  }
}

function runEvent(
  state: RunState,
  journal: Pick<Journal, "event">,
  kind: string,
  detail: unknown,
): void {
  try {
    journal.event(kind, detail);
  } catch (error) {
    state.failures.secondary("events-journal", error);
  }
}

function serveRoot(state: RunState, journal: Journal, port: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(request, server) {
      const id = request.headers.get(navigationHeader);
      const peer = server.requestIP(request);
      if (
        new URL(request.url).pathname !== "/" ||
        request.method !== "GET" ||
        !id ||
        !/^page-\d+-target$/.test(id) ||
        peer?.address !== "127.0.0.1"
      )
        throw new Error("Request escaped root-only fixture");
      const receipt = { navigationId: id, clientPort: peer.port, serverPort: server.port! };
      state.receipts.push(receipt);
      runEvent(state, journal, "server-entry", receipt);
      const response = new Response(rootHTML, { headers: rootHeaders });
      runEvent(state, journal, "server-response-return", receipt);
      return response;
    },
  });
}

async function wirePreflight(state: RunState): Promise<void> {
  if (!state.server) throw new Error("Missing fixture server");
  const response = await fetch(`http://127.0.0.1:${state.server.port}/`, {
    headers: { [navigationHeader]: "page-0-target", Connection: "close" },
  });
  if ((await response.text()) !== rootHTML) throw new Error("Root probe body mismatch");
  const receipt = state.receipts.find((value) => value.navigationId === "page-0-target");
  if (!receipt) throw new Error("Root probe has no server tuple");
  await waitForNavigationCapture((snapshot) => {
    const wire = correlateWire(snapshot.output.text, receipt);
    return wire.kind === "correlated" && wire.response === "acknowledged";
  });
}

async function rootChild(root: string, expected: unknown, port: number): Promise<void> {
  const journal = new Journal(join(root, "events.jsonl"));
  const state: RunState = {
    gotoFailure: false,
    attempts: [],
    failures: new Failures(),
    receipts: [],
  };
  let interrupted: Error | undefined;
  const interrupt = () => {
    interrupted = new Error("Root control interrupted");
    state.failures.fail(interrupted);
  };
  process.once("SIGTERM", interrupt);
  process.once("SIGINT", interrupt);
  try {
    durableJSON(join(root, "diagnostic-owner.json"), {
      pid: process.pid,
      executable: process.execPath,
      source: import.meta.filename,
    });
    assertIdentity(identity(), expected);
    await collectionPreflight(root);
    await processPreflight(root);
    state.server = serveRoot(state, journal, port);
    if (process.env.PROCESS_NAVIGATION_WIRE === "1")
      state.capture = {
        diagnosticPid: process.pid,
        root,
        serverPort: port,
        ownerLog: join(root, "stdout.bin"),
      };
    await startNavigationCapture(port);
    assertNavigationCaptureReady();
    await wirePreflight(state);
    const { webkit } = await import("playwright");
    state.browser = await webkit.launch({ headless: true });
    if (state.browser.version() !== "27.2") throw new Error("Launched WebKit version mismatch");
    state.browser.on("disconnected", () => runEvent(state, journal, "browser-disconnected", null));
    await protocolPreflight(root);
    runEvent(state, journal, "admitted", { port, maxFreshContexts: 50, gotoDeadlineMs: 30000 });
    await runFreshContexts(
      state,
      () => interrupted,
      (ordinal) => navigate(state, journal, ordinal),
    );
  } catch (error) {
    state.failures.fail(error);
    runEvent(state, journal, "primary-failure", reasonText(error));
  } finally {
    await cleanupRun(state, journal);
    await cleanupCollection(
      [
        ["SIGTERM-handler", () => process.off("SIGTERM", interrupt)],
        ["SIGINT-handler", () => process.off("SIGINT", interrupt)],
        ["events-journal-close", () => journal.close()],
      ],
      state.failures,
    );
  }
  let snapshot: ReturnType<typeof navigationCaptureSnapshot>;
  try {
    snapshot = navigationCaptureSnapshot();
  } catch (error) {
    await cleanupCollection(
      [
        [
          "root-result",
          () =>
            durableJSON(join(root, "result.json"), {
              classification: "CENSORED_CAPTURE",
              admission: "refused",
              pid: process.pid,
              exitStatus: 1,
              ...runReceipt(state),
              observationBoundary: "unvalidated-capture-tail",
              snapshotFailure: reasonText(error),
              attempts: state.attempts,
            }),
        ],
      ],
      state.failures,
    );
    if (state.failures.unresolved.length)
      emergencyReceipt("root-child", state.failures, {
        pid: process.pid,
        root,
        contextOwned: !!state.context,
        browserOwned: !!state.browser,
        serverPort: state.server?.port,
        captureRecovery: state.capture,
      });
    process.exitCode = 1;
    return;
  }
  const results = state.attempts.map((navigationId) => {
    const matches = state.receipts.filter((value) => value.navigationId === navigationId);
    const receipt = matches.length === 1 ? matches[0] : undefined;
    const wire: WireResult = receipt
      ? correlateWire(snapshot.output.text, receipt)
      : { kind: "censored", reason: "Missing or ambiguous server tuple for attempted navigation" };
    return { navigationId, receipt, wire };
  });
  await cleanupCollection(
    [
      [
        "root-result",
        () =>
          durableJSON(join(root, "result.json"), {
            pid: process.pid,
            exitStatus: diagnosticExitStatus(state.failures.primary),
            ...runReceipt(state),
            observationBoundary: "unvalidated-capture-tail",
            classification: classify(
              state.gotoFailure,
              captureRecordsIntact(snapshot) &&
                (state.failures.primary.kind === "none" || state.gotoFailure) &&
                state.failures.cleanupErrors.length === 0 &&
                !interrupted &&
                navigationDiagnosticErrors().length === 0,
              results.map((result) => result.wire),
            ),
            results,
            acknowledgementMeaning:
              "TCP peer stack acknowledgement is not browser application consumption",
          }),
      ],
    ],
    state.failures,
  );
  process.exitCode = diagnosticExitStatus(state.failures.primary);
  if (state.failures.unresolved.length)
    emergencyReceipt("root-child", state.failures, {
      pid: process.pid,
      root,
      contextOwned: !!state.context,
      browserOwned: !!state.browser,
      serverPort: state.server?.port,
      captureRecovery: state.capture,
    });
}

export async function cleanupRun(
  state: RunState,
  journal: Pick<Journal, "event">,
  capture = {
    stop: stopNavigationCapture,
    snapshot: (): Pick<
      ReturnType<typeof navigationCaptureSnapshot>,
      "stopped" | "exitCode" | "serverPort"
    > => navigationCaptureSnapshot(),
  },
): Promise<void> {
  await releaseRunResources(state, journal, [
    [
      "context",
      async () => {
        await state.context?.close();
        state.context = undefined;
      },
    ],
    [
      "browser",
      async () => {
        if (!state.browser) return;
        await state.browser.close();
        state.context = undefined;
        state.browser = undefined;
        state.failures.resolved("context");
      },
    ],
    [
      "capture",
      async () => {
        if (!state.capture) return;
        await capture.stop();
        const snapshot = capture.snapshot();
        if (
          !snapshot.stopped ||
          snapshot.exitCode === null ||
          snapshot.serverPort !== state.capture.serverPort
        )
          throw new Error("Capture shutdown unconfirmed; recovery identity retained");
      },
      12000,
    ],
    [
      "server",
      async () => {
        await state.server?.stop(true);
        state.server = undefined;
      },
    ],
  ]);
  if (!state.failures.unresolved.includes("capture")) state.capture = undefined;
}

export function runReceipt(state: RunState) {
  return { ...state.failures.receipt(), captureRecovery: state.capture };
}

export async function releaseRunResources(
  state: RunState,
  journal: Pick<Journal, "event">,
  stages: readonly Release[],
): Promise<void> {
  for (const stage of stages) {
    const before = state.failures.cleanupErrors.length;
    await cleanupCollection([stage], state.failures);
    if (state.failures.cleanupErrors.length !== before)
      runEvent(state, journal, "cleanup-error", { name: stage[0], ...state.failures.receipt() });
  }
}

async function main(): Promise<void> {
  if (!process.argv.includes("--run-root-control"))
    throw new Error("Explicit reviewed root-control execution grant required");
  const root = durableRoot(process.env.ROOT_NAVIGATION_EVIDENCE ?? "");
  const expected: unknown = JSON.parse(
    readFileSync(process.env.ROOT_NAVIGATION_IDENTITY ?? "", "utf8"),
  );
  const port = Number(process.env.ROOT_NAVIGATION_PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Explicit free unprivileged loopback port required");
  assertIdentity(identity(), expected);
  if (process.argv.includes("--root-child")) return rootChild(root, expected, port);
  const captureRoot = join(root, "wire");
  mkdirSync(captureRoot, { mode: 0o700 });
  process.env.PROCESS_NAVIGATION_WIRE = "1";
  process.env.PROCESS_NAVIGATION_WIRE_FORMAT = "hex";
  process.env.PROCESS_NAVIGATION_WIRE_DIR = captureRoot;
  process.env.DEBUG = "pw:browser,pw:protocol";
  durableJSON(join(root, "identity.json"), identity());
  let status = 1;
  const failures = new Failures();
  try {
    status = await collectChild(
      [
        "/usr/bin/strace",
        "--kill-on-exit",
        "-f",
        "-ttt",
        "-s",
        "256",
        "-e",
        "trace=process,signal",
        process.execPath,
        import.meta.filename,
        "--run-root-control",
        "--root-child",
      ],
      root,
    );
  } catch (error) {
    failures.fail(error);
  }
  const final = finalizeCollection(root, status, failures.primary);
  await cleanupCollection(
    [["final-result", () => durableJSON(join(root, "final-result.json"), final)]],
    failures,
  );
  if (failures.unresolved.length) emergencyReceipt("parent", failures, { pid: process.pid, root });
  failures.rethrow();
  process.exitCode = final.classification === "CENSORED_CAPTURE" ? 1 : status;
}

export function finalizeCollection(root: string, status: number, primary: Primary) {
  let classification = "CENSORED_CAPTURE";
  let child: unknown;
  let terminal = false;
  try {
    child = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
    terminal = terminalEvidence(root, status, child);
    if (
      primary.kind === "none" &&
      status === 0 &&
      terminal &&
      typeof child === "object" &&
      child !== null &&
      "classification" in child &&
      child.classification === "NONREPRODUCTION" &&
      "primaryPresent" in child &&
      child.primaryPresent === false &&
      "cleanupErrors" in child &&
      Array.isArray(child.cleanupErrors) &&
      child.cleanupErrors.length === 0 &&
      "unresolvedOwnership" in child &&
      Array.isArray(child.unresolvedOwnership) &&
      child.unresolvedOwnership.length === 0 &&
      hasProtocolCollection(readFileSync(join(root, "stderr.bin"), "utf8"))
    )
      classification = "NONREPRODUCTION";
  } catch {
    classification = "CENSORED_CAPTURE";
  }
  return {
    classification,
    status,
    terminal,
    primaryPresent: primary.kind === "rejected",
    primary: primary.kind === "rejected" ? reasonText(primary.reason) : null,
    observationBoundary: "unvalidated-capture-tail",
    child,
  };
}

type DiagnosticOwner = { pid: number; executable: string; source: string };

function diagnosticOwner(
  root: string,
  status: number,
  child: unknown,
): DiagnosticOwner | undefined {
  if (!child || typeof child !== "object" || !("pid" in child) || !("exitStatus" in child)) return;
  const owner: unknown = JSON.parse(readFileSync(join(root, "diagnostic-owner.json"), "utf8"));
  if (
    !owner ||
    typeof owner !== "object" ||
    !("pid" in owner) ||
    typeof owner.pid !== "number" ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    !("executable" in owner) ||
    typeof owner.executable !== "string" ||
    !("source" in owner) ||
    typeof owner.source !== "string" ||
    owner.pid !== child.pid ||
    child.exitStatus !== status
  )
    return;
  return { pid: owner.pid, executable: owner.executable, source: owner.source };
}

function collectedStreamsMatch(root: string, status: number): boolean {
  const collector: unknown = JSON.parse(readFileSync(join(root, "collector-result.json"), "utf8"));
  const tracer: unknown = JSON.parse(readFileSync(join(root, "collector-owner.json"), "utf8"));
  if (
    !tracer ||
    typeof tracer !== "object" ||
    !("pid" in tracer) ||
    !collector ||
    typeof collector !== "object" ||
    !("pid" in collector) ||
    collector.pid !== tracer.pid ||
    !("status" in collector) ||
    collector.status !== status ||
    !("signalCode" in collector) ||
    collector.signalCode !== null ||
    !("primaryPresent" in collector) ||
    collector.primaryPresent !== false ||
    !("cleanupErrors" in collector) ||
    !Array.isArray(collector.cleanupErrors) ||
    collector.cleanupErrors.length ||
    !("unresolvedOwnership" in collector) ||
    !Array.isArray(collector.unresolvedOwnership) ||
    collector.unresolvedOwnership.length ||
    !("stdoutSHA256" in collector) ||
    !("stderrSHA256" in collector)
  )
    return false;
  return (
    collector.stdoutSHA256 === sha256(readFileSync(join(root, "stdout.bin"))) &&
    collector.stderrSHA256 === sha256(readFileSync(join(root, "stderr.bin")))
  );
}

function ownedTraceClosed(trace: string, status: number, owner: DiagnosticOwner): boolean {
  const lines = trace.split("\n");
  const prefix = new RegExp(`^\\[pid\\s+${owner.pid}\\]`);
  const owned = lines.filter((line) => prefix.test(line));
  const executed = owned.findIndex(
    (line) =>
      line.includes(`execve(${JSON.stringify(owner.executable)},`) &&
      line.includes(JSON.stringify(owner.source)) &&
      line.includes('"--root-child"') &&
      line.endsWith(" = 0"),
  );
  const terminals = owned.filter((line) => /\+\+\+ (?:exited with|killed by)/.test(line));
  if (
    executed === -1 ||
    terminals.length !== 1 ||
    !terminals[0]!.endsWith(`+++ exited with ${status} +++`) ||
    owned.indexOf(terminals[0]!) <= executed
  )
    return false;
  const traced = new Set(lines.flatMap((line) => /^\[pid\s+(\d+)\]/.exec(line)?.slice(1) ?? []));
  return Array.from(traced).every((pid) =>
    lines.some((line) =>
      new RegExp(
        `^\\[pid\\s+${pid}\\] .*\\+\\+\\+ (?:exited with \\d+|killed by [A-Z0-9]+).*\\+\\+\\+$`,
      ).test(line),
    ),
  );
}

export function terminalEvidence(root: string, status: number, child: unknown): boolean {
  if (status !== 0 && status !== 1) return false;
  const owner = diagnosticOwner(root, status, child);
  if (!owner || !collectedStreamsMatch(root, status)) return false;
  return ownedTraceClosed(readFileSync(join(root, "stderr.bin"), "utf8"), status, owner);
}

if (import.meta.main) await main();
