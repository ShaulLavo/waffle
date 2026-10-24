import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { captureDiagnostics, captureTail, wireText } from "./fixtures/navigation-wire-child.ts";

const fixture = fileURLToPath(new URL("./fixtures/navigation-wire-child.ts", import.meta.url));
const source = fileURLToPath(new URL("./process-navigation-observer.ts", import.meta.url));

function signalIfAlive(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

function collect(directory: string): string[] {
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith("snapshot.json"))
    .map((path) => readFileSync(join(directory, path), "utf8"));
}

async function deadline<T>(operation: Promise<T>): Promise<T> {
  const limit = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => limit.reject(new Error("Controlled child deadline exceeded")),
    10000,
  );
  try {
    return await Promise.race([operation, limit.promise]);
  } finally {
    clearTimeout(timer);
  }
}

type Checkpoint = {
  capturePid: number;
  stdoutBytes: number;
  stderrBytes: number;
  expectedStdout: number;
  ready: ReturnType<typeof Promise.withResolvers<void>>;
  consumed: ReturnType<typeof Promise.withResolvers<void>>;
  messages: unknown[];
};

function receiveCheckpoint(state: Checkpoint, message: unknown): void {
  state.messages.push(message);
  if (typeof message !== "object" || message === null) return;
  if ("bytes" in message && typeof message.bytes === "number" && "stream" in message) {
    if (message.stream === "stdout") state.stdoutBytes += message.bytes;
    if (message.stream === "stderr") state.stderrBytes += message.bytes;
    if (state.stdoutBytes >= state.expectedStdout && state.stderrBytes >= captureDiagnostics.length)
      state.consumed.resolve();
    return;
  }
  if (!("capturePid" in message) || typeof message.capturePid !== "number") return;
  state.capturePid = message.capturePid;
  if ("kind" in message && message.kind === "ready") state.ready.resolve();
}

function writeObserver(scratch: string, breakPreflightSink = false): string {
  const observer = join(scratch, "observer.ts");
  const replacement = `${JSON.stringify(process.execPath)}, ${JSON.stringify(fixture)}, "--capture",`;
  const readChunk = "this.append(decoder.decode(chunk.value, { stream: true }), stream);";
  const checkpoint = `${readChunk} process.send?.({ kind: "chunk-consumed", stream, bytes: chunk.value.length });`;
  const text = readFileSync(source, "utf8");
  expect(text.split(readChunk)).toHaveLength(2);
  expect(text.split('"/usr/bin/tcpdump",')).toHaveLength(2);
  writeFileSync(
    observer,
    text
      .replace('"/usr/bin/tcpdump",', replacement)
      .replace(readChunk, checkpoint)
      .replace(
        'this.persist("capture-spawned");',
        breakPreflightSink
          ? 'this.persist("capture-spawned"); require("node:fs").mkdirSync(join(this.evidence!.directory, "snapshot.pending"));'
          : 'this.persist("capture-spawned");',
      ),
  );
  return observer;
}

async function controlledInterruption(
  signal: "SIGTERM" | "SIGKILL",
  fill = false,
  quiet = false,
  breakSink = false,
): Promise<void> {
  const root = mkdtempSync(
    join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "waffle-wire-retention-"),
  );
  const scratch = join(root, "scratch");
  const evidence = join(root, "evidence");
  const result = join(root, "result.json");
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  const state: Checkpoint = {
    capturePid: 0,
    stdoutBytes: 0,
    stderrBytes: 0,
    expectedStdout: (fill ? 600 * 1024 : 0) + wireText.length,
    ready: Promise.withResolvers<void>(),
    consumed: Promise.withResolvers<void>(),
    messages: [],
  };
  try {
    mkdirSync(scratch);
    mkdirSync(evidence);
    const observer = writeObserver(scratch);
    child = Bun.spawn([process.execPath, fixture], {
      env: {
        ...process.env,
        TMPDIR: scratch,
        PROCESS_NAVIGATION_WIRE: "1",
        PROCESS_NAVIGATION_WIRE_DIR: evidence,
        OBSERVER_PATH: observer,
        RESULT_PATH: result,
        WIRE_FILL: fill ? "1" : "0",
        WIRE_QUIET: quiet ? "1" : "0",
      },
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
      ipc: (message: unknown) => receiveCheckpoint(state, message),
    });
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    await deadline(
      Promise.race([
        Promise.all([state.ready.promise, state.consumed.promise]),
        child.exited.then(() => {
          throw new Error("Observer exited before checkpoint");
        }),
      ]),
    );
    if (breakSink) {
      const directories = readdirSync(evidence);
      expect(directories).toHaveLength(1);
      mkdirSync(join(evidence, directories[0]!, "snapshot.pending"));
    }
    expect(state.capturePid).toBeGreaterThan(0);
    child.kill(signal);
    const status = await deadline(child.exited);
    if (signal === "SIGKILL") signalIfAlive(-child.pid, "SIGKILL");
    const saved = collect(evidence);
    const collected = join(root, "collected.json");
    writeFileSync(collected, JSON.stringify(saved));
    rmSync(scratch, { recursive: true });
    const transcript = await output;
    expect(transcript).toContain("PROCESS_NAVIGATION_CAPTURE_OWNER");
    if (quiet) expect(transcript).not.toContain("PROCESS_NAVIGATION_WIRE ");
    else expect(transcript).toContain(wireText.replace(/\r/g, "\\r").replace(/\n/g, "\\n"));
    expect(await errors).not.toContain("Unhandled");
    expect(saved).toHaveLength(1);
    const snapshot = JSON.parse(saved[0]!);
    expect(snapshot.output.text.endsWith(wireText)).toBe(true);
    expect(snapshot.output.retainedBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(snapshot.output.retainedBytes + snapshot.output.evictedBytes).toBe(
      ((fill ? 600 * 1024 : 0) + wireText.length) * 2,
    );
    expect(snapshot.failureCount).toBe(signal === "SIGTERM" && !breakSink ? 1 : 0);
    expect(Buffer.byteLength(saved[0]!)).toBeLessThan(3 * (1024 * 1024 + 32 * 1024) + 4096);
    if (!fill) expect(snapshot.output.text).toBe(wireText);
    expect(snapshot.diagnostics.text).toContain(captureDiagnostics);
    expect(snapshot.output.evictedBytes).toBe(
      fill ? (600 * 1024 + wireText.length) * 2 - snapshot.output.retainedBytes : 0,
    );
    expect(snapshot.diagnostics.evictedBytes).toBe(0);
    expect(readFileSync(collected, "utf8")).toBe(JSON.stringify(saved));
    if (process.env.WAFFLE_WIRE_TEST_REPORT)
      writeFileSync(
        join(
          process.env.WAFFLE_WIRE_TEST_REPORT,
          `${signal}-${fill ? "bounded" : quiet ? "quiet" : breakSink ? "sink-error" : "exact"}.json`,
        ),
        saved[0]!,
      );
    if (signal === "SIGKILL") return;
    expect(status).toBe(23);
    const outcome = JSON.parse(readFileSync(result, "utf8"));
    expect(outcome.primaryPreserved).toBe(true);
    expect(outcome.errors).toContain("Error: Capture exit status 7");
    if (breakSink) {
      expect(snapshot.stopped).toBe(false);
      expect(outcome.errors.some((error: string) => error.includes("snapshot.pending"))).toBe(true);
      return;
    }
    expect(snapshot.diagnostics.text).toContain(captureTail);
    expect(snapshot.stopped).toBe(true);
    expect(snapshot.exitCode).toBe(7);
    expect(snapshot.errors.text).toContain("Capture exit status 7");
  } catch (error) {
    console.error("CONTROLLED_CHILD_STATE", JSON.stringify(state));
    throw error;
  } finally {
    if (child) signalIfAlive(-child.pid, "SIGKILL");
    if (child) await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
}

test(
  "collects exact wire/error/counter evidence before interrupted scratch cleanup without replacing primary failure",
  () => controlledInterruption("SIGTERM"),
  15000,
);
test(
  "retains a bounded durable wire checkpoint when the observer is killed before cleanup",
  () => controlledInterruption("SIGKILL"),
  15000,
);

test(
  "bounds durable snapshots and accounts for evicted wire bytes",
  () => controlledInterruption("SIGTERM", true),
  15000,
);

test(
  "retains consumed streams without waiting for failure or stop emission",
  () => controlledInterruption("SIGKILL", false, true),
  15000,
);

test(
  "preserves primary failure and cleanup when later snapshot persistence fails",
  () => controlledInterruption("SIGTERM", false, false, true),
  15000,
);

async function assertSetup(
  observer: string,
  scratch: string,
  directory: string,
  expectedError: string | undefined,
  wire = "1",
): Promise<void> {
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    child = Bun.spawn([process.execPath, fixture, "--setup"], {
      env: {
        ...process.env,
        TMPDIR: scratch,
        PROCESS_NAVIGATION_WIRE: wire,
        PROCESS_NAVIGATION_WIRE_DIR: directory,
        OBSERVER_PATH: observer,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    expect(await deadline(child.exited)).toBe(expectedError ? 24 : 0);
    expect(await output).not.toContain("PROCESS_NAVIGATION_CAPTURE_OWNER");
    if (expectedError) expect(await errors).toContain(expectedError);
    else expect(await errors).toBe("");
  } finally {
    if (child) signalIfAlive(-child.pid, "SIGKILL");
    if (child) await child.exited;
  }
}

test("rejects missing, relative and disposable evidence paths before capture, while disabled capture stays inert", async () => {
  const root = mkdtempSync(
    join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "waffle-wire-retention-"),
  );
  try {
    const scratch = join(root, "scratch");
    mkdirSync(scratch);
    const observer = writeObserver(scratch);
    const unsafe = join(scratch, "evidence");
    mkdirSync(unsafe);
    const alias = join(root, "alias");
    symlinkSync(unsafe, alias);
    await assertSetup(observer, scratch, "", "absolute task-owned");
    await assertSetup(observer, scratch, "relative", "absolute task-owned");
    await assertSetup(observer, scratch, scratch, "outside disposable TMPDIR");
    await assertSetup(observer, scratch, alias, "outside disposable TMPDIR");
    await assertSetup(observer, scratch, "", undefined, "0");
    expect(readdirSync(unsafe)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test("strict capture admission rejects a lost durable sink before any navigation", async () => {
  const root = mkdtempSync(
    join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "waffle-wire-preflight-"),
  );
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    const scratch = join(root, "scratch");
    const evidence = join(root, "evidence");
    mkdirSync(scratch);
    mkdirSync(evidence);
    const observer = writeObserver(scratch, true);
    child = Bun.spawn([process.execPath, fixture, "--setup"], {
      env: {
        ...process.env,
        TMPDIR: scratch,
        PROCESS_NAVIGATION_WIRE: "1",
        PROCESS_NAVIGATION_WIRE_DIR: evidence,
        OBSERVER_PATH: observer,
        WIRE_STRICT: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    expect(await deadline(child.exited)).toBe(24);
    expect(await output).toContain("PROCESS_NAVIGATION_CAPTURE_OWNER");
    expect(await errors).toContain("durable sink");
  } finally {
    if (child) signalIfAlive(-child.pid, "SIGKILL");
    if (child) await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
