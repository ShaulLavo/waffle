import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cleanupCollection,
  collectChild,
  cleanupRun,
  runReceipt,
  finishStreams,
  stopCollectedChild,
  runContextAttempt,
  runFreshContexts,
  releaseRunResources,
  type RunState,
  assertIdentity,
  assertSourceProvenance,
  historicalRunnerPath,
  captureRecordsIntact,
  Failures,
  terminalEvidence,
  diagnosticExitStatus,
  classify,
  correlateWire,
  decodeWire,
  durableJSON,
  hasProtocolCollection,
  finalizeCollection,
  rootHeaders,
  rootHTML,
  sha256,
} from "./process-root-navigation-diagnostic.ts";

const receipt = { navigationId: "page-1-target", clientPort: 34567, serverPort: 43037 };
const request = `GET / HTTP/1.1\r\nx-waffle-navigation-id: ${receipt.navigationId}\r\n\r\n`;
const response = `HTTP/1.1 200 OK\r\n${Object.entries(rootHeaders)
  .map(([key, value]) => `${key}: ${value}\r\n`)
  .join("")}Content-Length: 53\r\n\r\n${rootHTML}`;
const protocolTrace =
  "pw:browser <launched> pid=123\npw:protocol SEND ► command\npw:protocol ◀ RECV result\n";

function packet(from: number, sequence: number, ack: number, flags: number, payload = ""): string {
  const body = Buffer.from(payload);
  const bytes = Buffer.alloc(54 + body.length);
  bytes.writeUInt16BE(0x0800, 12);
  bytes[14] = 0x45;
  bytes.writeUInt16BE(40 + body.length, 16);
  bytes[23] = 6;
  bytes.writeUInt32BE(0x7f000001, 26);
  bytes.writeUInt32BE(0x7f000001, 30);
  bytes.writeUInt16BE(from, 34);
  bytes.writeUInt16BE(from === receipt.clientPort ? receipt.serverPort : receipt.clientPort, 36);
  bytes.writeUInt32BE(sequence, 38);
  bytes.writeUInt32BE(ack, 42);
  bytes[46] = 0x50;
  bytes[47] = flags;
  body.copy(bytes, 54);
  const rows: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const hex = bytes
      .subarray(offset, offset + 16)
      .toString("hex")
      .match(/.{1,4}/g)!
      .join(" ");
    rows.push(`\t0x${offset.toString(16).padStart(4, "0")}:  ${hex}\n`);
  }
  return `1792831189.185304 IP synthetic packet\n${rows.join("")}`;
}

function exchange(body = response): string[] {
  return [
    packet(receipt.clientPort, 100, 0, 2),
    packet(receipt.serverPort, 200, 101, 18),
    packet(receipt.clientPort, 101, 201, 24, request),
    packet(receipt.serverPort, 201, 101 + request.length, 24, body),
    packet(receipt.clientPort, 101 + request.length, 201 + body.length, 16),
  ];
}

test("root contract is exactly the main88 script-free 53-byte body and isolation headers", () => {
  expect(Buffer.byteLength(rootHTML)).toBe(53);
  expect(rootHTML).toBe("<!doctype html><title>Process transport tests</title>");
  expect(rootHeaders).toEqual({
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Content-Type": "text/html",
  });
  expect(
    readFileSync(new URL("./process-root-navigation-diagnostic.ts", import.meta.url), "utf8"),
  ).not.toContain("/tests.js");
});

test("pairs exact request/response bytes through one TCP tuple and ACK, without a response correlation header", () => {
  const wire = correlateWire(exchange().join(""), receipt);
  expect(wire).toMatchObject({
    kind: "correlated",
    response: "acknowledged",
    requestHex: Buffer.from(request).toString("hex"),
    responseHex: Buffer.from(response).toString("hex"),
    packets: 5,
  });
  expect(
    correlateWire(exchange().join(""), { ...receipt, navigationId: "page-2-target" }).kind,
  ).toBe("censored");
  expect(correlateWire(exchange().join(""), { ...receipt, clientPort: 34568 }).kind).toBe(
    "censored",
  );
});

test("does not promote missing, partial, or unacknowledged response bytes to delivery", () => {
  expect(correlateWire(exchange().slice(0, 3).join(""), receipt)).toMatchObject({
    kind: "correlated",
    response: "absent",
  });
  expect(correlateWire(exchange("HTTP/1.1 200").join(""), receipt)).toMatchObject({
    kind: "correlated",
    response: "partial",
  });
  expect(correlateWire(exchange().slice(0, 4).join(""), receipt)).toMatchObject({
    kind: "correlated",
    response: "complete",
  });
});

test("reassembles reordered segments and consistent retransmits but rejects holes, truncation, conflicts and tuple reuse", () => {
  const parts = exchange();
  const head = response.slice(0, 60);
  const tail = response.slice(60);
  const reordered = parts
    .slice(0, 3)
    .concat([
      packet(receipt.serverPort, 261, 101 + request.length, 24, tail),
      packet(receipt.serverPort, 201, 101 + request.length, 24, head),
      parts[3]!,
      parts[4]!,
    ]);
  expect(correlateWire(reordered.join(""), receipt)).toMatchObject({
    kind: "correlated",
    response: "acknowledged",
  });
  expect(correlateWire(parts.slice(0, 3).concat([reordered[3]!]).join(""), receipt).kind).toBe(
    "censored",
  );
  expect(
    correlateWire(parts.concat([packet(receipt.serverPort, 201, 0, 24, "wrong")]).join(""), receipt)
      .kind,
  ).toBe("censored");
  expect(
    correlateWire(parts.concat([packet(receipt.clientPort, 999, 0, 2)]).join(""), receipt).kind,
  ).toBe("censored");
  expect(() => decodeWire(parts.join("").slice(0, -30))).toThrow();
});

test("retained-record integrity requires durable full hex, zero recorded losses/evictions and matching decoded count, not tail completeness", () => {
  const state = {
    reason: "test",
    wallClockMs: 0,
    monotonicMs: 0,
    serverPort: receipt.serverPort,
    ready: true,
    stopped: true,
    exitCode: 0,
    unexpectedExit: false,
    snaplen: 0,
    format: "ethernet-hex",
    durable: true,
    inference: "test",
    closingBoundary: "unvalidated",
    failureCount: 0,
    output: { text: exchange().join(""), retainedBytes: 1, evictedBytes: 0 },
    diagnostics: {
      text: "listening on lo, link-type EN10MB\n5 packets captured\n0 packets dropped by kernel\n",
      retainedBytes: 1,
      evictedBytes: 0,
    },
    errors: { text: "", retainedBytes: 0, evictedBytes: 0 },
  };
  expect(captureRecordsIntact(state)).toBe(true);
  const queuedTail = {
    ...state,
    output: { ...state.output, text: exchange().slice(0, 3).join("") },
    diagnostics: {
      ...state.diagnostics,
      text: "listening on lo, link-type EN10MB\n3 packets captured\n10 packets received by filter\n0 packets dropped by kernel\n",
    },
  };
  expect(captureRecordsIntact(queuedTail)).toBe(true);
  expect(
    classify(true, captureRecordsIntact(queuedTail), [
      correlateWire(queuedTail.output.text, receipt),
    ]),
  ).toBe("CENSORED_CAPTURE");
  expect(
    classify(true, captureRecordsIntact(state), [correlateWire(state.output.text, receipt)]),
  ).toBe("CENSORED_CAPTURE");

  expect(captureRecordsIntact({ ...state, durable: false })).toBe(false);
  expect(captureRecordsIntact({ ...state, stopped: false })).toBe(false);
  expect(captureRecordsIntact({ ...state, exitCode: 7 })).toBe(false);
  expect(captureRecordsIntact({ ...state, failureCount: 1 })).toBe(false);
  expect(captureRecordsIntact({ ...state, output: { ...state.output, evictedBytes: 1 } })).toBe(
    false,
  );
  expect(
    captureRecordsIntact({
      ...state,
      diagnostics: {
        ...state.diagnostics,
        text: state.diagnostics.text.replace("0 packets dropped", "1 packets dropped"),
      },
    }),
  ).toBe(false);
  expect(
    captureRecordsIntact({
      ...state,
      diagnostics: {
        ...state.diagnostics,
        text: state.diagnostics.text.replace("5 packets captured", "4 packets captured"),
      },
    }),
  ).toBe(false);
  expect(
    captureRecordsIntact({
      ...state,
      output: { ...state.output, text: state.output.text.slice(0, -30) },
    }),
  ).toBe(false);
  const good = correlateWire(state.output.text, receipt);
  expect(classify(false, true, [good])).toBe("NONREPRODUCTION");
  expect(classify(true, true, [good])).toBe("CENSORED_CAPTURE");
  expect(classify(true, false, [good])).toBe("CENSORED_CAPTURE");
  expect(classify(false, true, [])).toBe("CENSORED_CAPTURE");
  expect(classify(true, true, [{ kind: "censored", reason: "missing attempt" }])).toBe(
    "CENSORED_CAPTURE",
  );
});

test("refuses engine/version and approved executable identity mismatch", () => {
  const identity = {
    playwright: "1.64.1",
    webkit: "27.2",
    revision: "2370",
    bun: "1.4.4",
    executableSHA256: "fixed",
  };
  expect(() => assertIdentity(identity, identity)).not.toThrow();
  expect(() => assertIdentity({ ...identity, webkit: "27.3" }, identity)).toThrow("Exact");
  expect(() => assertIdentity(identity, { ...identity, executableSHA256: "other" })).toThrow(
    "Identity mismatch",
  );
  expect(() => assertIdentity(identity, {})).toThrow();
});

test("source provenance accepts the frozen historical reference and rejects wrong bytes", () => {
  const lockfile = new URL("../../../bun.lock", import.meta.url).pathname;
  const runner = historicalRunnerPath;
  const root = mkdtempSync(
    join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "waffle-root-source-"),
  );
  try {
    expect(readFileSync(runner)).toHaveLength(14_361);
    expect(() => assertSourceProvenance(lockfile, runner)).not.toThrow();
    const wrongLockfile = join(root, "bun.lock");
    writeFileSync(wrongLockfile, `${readFileSync(lockfile, "utf8")}\n`);
    expect(() => assertSourceProvenance(wrongLockfile, runner)).toThrow("Lockfile");
    const wrongRunner = join(root, "process-recycling-browser-runner.ts");
    writeFileSync(wrongRunner, `${readFileSync(runner, "utf8")}\n`);
    expect(() => assertSourceProvenance(lockfile, wrongRunner)).toThrow("Original runner changed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function killIfAlive(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
  }
}

async function waitForReady(
  path: string,
  child: Bun.Subprocess,
  errors: Promise<string>,
): Promise<void> {
  const start = performance.now();
  while (!(await Bun.file(path).exists())) {
    if (child.exitCode !== null && !(await Bun.file(path).exists())) {
      throw new Error(`Collector fixture exited before admission: ${await errors}`);
    }
    if (performance.now() - start > 5000) throw new Error("Synthetic collector readiness timeout");
    await Bun.sleep(10);
  }
}

async function collectorControl(interrupt: boolean, breakSink = false): Promise<void> {
  const root = mkdtempSync(
    join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "waffle-root-collector-"),
  );
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let capturedPid: number | undefined;
  try {
    const evidence = join(root, "evidence");
    const scratch = join(root, "scratch");
    mkdirSync(evidence);
    mkdirSync(scratch);
    if (breakSink) mkdirSync(join(evidence, "stdout.bin"));
    child = Bun.spawn(
      [
        process.execPath,
        new URL("./fixtures/navigation-wire-child.ts", import.meta.url).pathname,
        "--collector",
      ],
      {
        env: {
          ...process.env,
          TMPDIR: scratch,
          ROOT_NAVIGATION_EVIDENCE: evidence,
          ROOT_DIAGNOSTIC_PATH: new URL("./process-root-navigation-diagnostic.ts", import.meta.url)
            .pathname,
          ROOT_COLLECTION_MODE: interrupt ? "wait" : "complete",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      },
    );
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    if (!breakSink) {
      await waitForReady(join(evidence, "fixture-ready.json"), child, errors);
      const owner = JSON.parse(readFileSync(join(evidence, "collector-owner.json"), "utf8"));
      capturedPid = owner.pid;
      if (interrupt) child.kill("SIGTERM");
    }
    const status = await child.exited;
    const stderr = await errors;
    expect(await output).toBe("");
    if (breakSink) {
      expect(status).toBe(1);
      expect(stderr).toContain("stdout.bin");
      expect(await Bun.file(join(evidence, "collector-owner.json")).exists()).toBe(false);
      expect(await Bun.file(join(evidence, "fixture-ready.json")).exists()).toBe(false);
      return;
    }
    const bytes = readFileSync(join(evidence, "stdout.bin"));
    expect(bytes.subarray(-5)).toEqual(Buffer.from([0, 255, 128, 13, 10]));
    const savedErrors = readFileSync(join(evidence, "stderr.bin"), "utf8");
    expect(savedErrors).toContain(
      "Error: synthetic primary interruption\nsynthetic child cleanup\n",
    );
    const result = JSON.parse(readFileSync(join(evidence, "collector-result.json"), "utf8"));
    expect(result.stdoutSHA256).toBe(sha256(bytes));
    expect(result.stderrSHA256).toBe(sha256(readFileSync(join(evidence, "stderr.bin"))));
    expect(result.cleanupErrors).toEqual([]);
    expect(status).toBe(interrupt ? 1 : 23);
    expect(result.primary).toBe(interrupt ? "Error: Collector interrupted" : null);
    rmSync(scratch, { recursive: true });
    expect(readFileSync(join(evidence, "stdout.bin"))).toEqual(bytes);
    expect(() => process.kill(capturedPid!, 0)).toThrow();
    if (process.env.WAFFLE_WIRE_TEST_REPORT)
      writeFileSync(
        join(
          process.env.WAFFLE_WIRE_TEST_REPORT,
          `collector-${interrupt ? "interrupt" : "complete"}.json`,
        ),
        JSON.stringify({ status, result, stdoutHex: bytes.toString("hex"), stderr: savedErrors }),
      );
  } finally {
    if (child) killIfAlive(-child.pid);
    if (capturedPid) killIfAlive(-capturedPid);
    if (child) await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
}

test(
  "collector retains exact bytes, primary failure and cleanup across normal completion",
  () => collectorControl(false),
  15000,
);
test(
  "collector drains owned child cleanup after interruption and retains primary failure",
  () => collectorControl(true),
  15000,
);
test(
  "collector rejects an unwritable durable sink before spawning its fixture",
  () => collectorControl(false, true),
  15000,
);

test("collector forwards capture environment set immediately before spawn", async () => {
  const root = mkdtempSync(
    join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "waffle-root-environment-"),
  );
  const evidence = join(root, "evidence");
  mkdirSync(evidence);
  mkdirSync(join(root, "scratch"));
  const previousTMPDIR = process.env.TMPDIR;
  try {
    process.env.TMPDIR = join(root, "scratch");
    process.env.ROOT_NAVIGATION_DYNAMIC_CAPTURE = "present";
    const status = await collectChild(
      [
        process.execPath,
        "-e",
        'process.stdout.write(process.env.ROOT_NAVIGATION_DYNAMIC_CAPTURE ?? "missing")',
      ],
      evidence,
    );
    expect(status).toBe(0);
    expect(readFileSync(join(evidence, "stdout.bin"), "utf8")).toBe("present");
    expect(JSON.parse(readFileSync(join(evidence, "collector-result.json"), "utf8"))).toMatchObject(
      {
        status: 0,
        primaryPresent: false,
        cleanupErrors: [],
        unresolvedOwnership: [],
      },
    );
  } finally {
    if (previousTMPDIR === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTMPDIR;
    delete process.env.ROOT_NAVIGATION_DYNAMIC_CAPTURE;
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test("durable evidence refuses accidental overwrite", () => {
  const root = mkdtempSync(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "waffle-root-json-"));
  try {
    const path = join(root, "checkpoint.json");
    durableJSON(path, { exact: "retained" });
    expect(() => durableJSON(path, { exact: "replacement" })).toThrow();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ exact: "retained" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("admission requires protocol/browser readback and final collection cannot clear missing or interrupted evidence", () => {
  const root = mkdtempSync(
    join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "waffle-root-final-"),
  );
  const trace = `${protocolTrace}[pid 123] execve("/engine/bin/MiniBrowser", [], [])\n`;
  try {
    expect(hasProtocolCollection(trace)).toBe(true);
    expect(hasProtocolCollection(trace.replace("◀ RECV", "RECV"))).toBe(false);
    expect(hasProtocolCollection(trace.replace("◀ RECV", "◀ RECVIVED"))).toBe(false);
    expect(finalizeCollection(root, 0, { kind: "none" }).classification).toBe("CENSORED_CAPTURE");
    writeTerminalFixture(root, 0, "NONREPRODUCTION");
    expect(finalizeCollection(root, 0, { kind: "none" }).classification).toBe("NONREPRODUCTION");
    const child = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
    writeFileSync(
      join(root, "stderr.bin"),
      readFileSync(join(root, "stderr.bin"), "utf8").replace("◀ RECV", "RECV"),
    );
    const collectorPath = join(root, "collector-result.json");
    const collector = JSON.parse(readFileSync(collectorPath, "utf8"));
    collector.stderrSHA256 = sha256(readFileSync(join(root, "stderr.bin")));
    writeFileSync(collectorPath, JSON.stringify(collector));
    expect(terminalEvidence(root, 0, child)).toBe(true);
    expect(finalizeCollection(root, 0, { kind: "none" }).classification).toBe("CENSORED_CAPTURE");
    writeTerminalFixture(root, 0, "NONREPRODUCTION");
    expect(finalizeCollection(root, 1, { kind: "none" }).classification).toBe("CENSORED_CAPTURE");
    expect(
      finalizeCollection(root, 0, { kind: "rejected", reason: new Error("interrupted") })
        .classification,
    ).toBe("CENSORED_CAPTURE");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function sampleState(): RunState {
  return { gotoFailure: false, attempts: [], failures: new Failures(), receipts: [] };
}
const quietJournal = { event() {} };

test("R66 queued capture tail and late response or ACK never certify a complete cancellation window", () => {
  const parts = exchange();
  const requestOnly = correlateWire(parts.slice(0, 3).join(""), receipt);
  const lateResponse = correlateWire(parts.slice(0, 4).join(""), receipt);
  const lateACK = correlateWire(parts.join(""), receipt);
  expect(requestOnly).toMatchObject({ kind: "correlated", response: "absent" });
  expect(lateResponse).toMatchObject({ kind: "correlated", response: "complete" });
  expect(lateACK).toMatchObject({ kind: "correlated", response: "acknowledged" });
  for (const retained of [requestOnly, lateResponse, lateACK])
    expect(classify(true, true, [retained])).toBe("CENSORED_CAPTURE");
});

test("R66 failed context close stops the factory and retains ownership", async () => {
  const state = sampleState();
  const closeFailure = new Error("context close rejected");
  const context = {
    close: async () => {
      throw closeFailure;
    },
  };
  let calls = 0;
  let caught: unknown;
  try {
    await runFreshContexts(
      state,
      () => undefined,
      async () => {
        calls++;
        state.context = context;
        await runContextAttempt(state, quietJournal, async () => {});
      },
    );
  } catch (error) {
    caught = error;
  }
  expect(calls).toBe(1);
  expect(state.context).toBe(context);
  expect(caught).toBe(closeFailure);
});

test("R66 abnormal tracer status or missing terminal records cannot promote a saved loss", () => {
  const root = mkdtempSync(join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "waffle-r66-trace-"));
  try {
    const trace =
      'pw:browser <launched> pid=123\npw:protocol SEND command\npw:protocol RECV result\n[pid 123] execve("/engine/bin/MiniBrowser", [], [])\n';
    durableJSON(join(root, "result.json"), {
      classification: "COMPLETE_CORRELATED_LOSS",
      pid: 456,
    });
    writeFileSync(join(root, "stderr.bin"), trace);
    for (const status of [2, 137, 1])
      expect(finalizeCollection(root, status, { kind: "none" }).classification).toBe(
        "CENSORED_CAPTURE",
      );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R66 collector independently attempts every release after termination failure", async () => {
  const attempted: string[] = [];
  await cleanupCollection([
    [
      "child",
      () => {
        attempted.push("child");
        throw new Error("termination failure");
      },
    ],
    [
      "streams",
      () => {
        attempted.push("streams");
        throw new Error("reader failure");
      },
    ],
    [
      "journal",
      () => {
        attempted.push("journal");
      },
    ],
    [
      "handlers",
      () => {
        attempted.push("handlers");
      },
    ],
  ]).catch(() => {});
  expect(attempted).toEqual(["child", "streams", "journal", "handlers"]);
});

test("R66 failed and cancel-stalled readers are bounded and release locks", async () => {
  let released = 0;
  const errors = new Failures();
  const readers = [
    {
      cancel: async () => {
        throw new Error("reader cancel rejected");
      },
      releaseLock: () => {
        released++;
      },
    },
    {
      cancel: () => new Promise<void>(() => {}),
      releaseLock: () => {
        released++;
      },
    },
  ];
  let settled = false;
  const operation = finishStreams(
    Promise.reject(new Error("reader read rejected")),
    readers,
    errors,
  ).then(() => {
    settled = true;
  });
  await Promise.race([operation, Bun.sleep(4500)]);
  expect(settled).toBe(true);
  expect(released).toBe(2);
  expect(errors.cleanupErrors.join("\n")).toContain("reader read rejected");
  expect(errors.cleanupErrors.join("\n")).toContain("reader cancel rejected");
}, 6000);

test("R66 failed journal cannot abort later owned cleanup releases", async () => {
  const state = sampleState();
  const primary = new Error("original failure");
  state.failures.fail(primary);
  const attempted: string[] = [];
  await releaseRunResources(
    state,
    {
      event() {
        throw new Error("journal failed");
      },
    },
    [
      [
        "context",
        () => {
          attempted.push("context");
          throw new Error("close rejected");
        },
      ],
      [
        "capture",
        () => {
          attempted.push("capture");
        },
      ],
      [
        "server",
        () => {
          attempted.push("server");
        },
      ],
    ],
  ).catch(() => {});
  expect(attempted).toEqual(["context", "capture", "server"]);
  expect(state.failures.primary).toEqual({ kind: "rejected", reason: primary });
  expect(state.failures.cleanupErrors.join("\n")).toContain("journal failed");
});

for (const reason of [null, undefined, false, 0, "", Object.freeze({ exact: "identity" })]) {
  test(`R66 exact first rejection survives cleanup: ${String(reason)}`, async () => {
    const state = sampleState();
    const context = {
      close: async () => {
        throw new Error("later cleanup failure");
      },
    };
    state.context = context;
    let caught: unknown = Symbol("not rejected");
    try {
      await runContextAttempt(state, quietJournal, async () => {
        throw reason;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(reason);
    expect(state.failures.primary.kind).toBe("rejected");
    if (state.failures.primary.kind === "rejected")
      expect(state.failures.primary.reason).toBe(reason);
    expect(state.context).toBe(context);
  });
}

test("R66 signal failure still attempts both owned child signals", async () => {
  const signals: string[] = [];
  const errors = new Failures();
  await stopCollectedChild({ pid: 123, exited: Promise.resolve(1) }, errors, (_child, signal) => {
    signals.push(signal);
    throw new Error(`signal failed ${signal}`);
  }).catch(() => {});
  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(errors.cleanupErrors.join("\n")).toContain("SIGKILL");
});

for (const reason of [null, undefined, false, 0, "", Object.freeze({ exact: "collector" })]) {
  test(`R66 falsy supplied collector primary cannot clear failure: ${String(reason)}`, () => {
    const root = mkdtempSync(
      join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "waffle-r66-falsy-"),
    );
    try {
      writeTerminalFixture(root, 0, "NONREPRODUCTION");
      expect(finalizeCollection(root, 0, { kind: "none" }).classification).toBe("NONREPRODUCTION");
      expect(finalizeCollection(root, 0, { kind: "rejected", reason }).classification).toBe(
        "CENSORED_CAPTURE",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

function writeTerminalFixture(
  root: string,
  status: number,
  classification: string,
  ending?: string,
): void {
  const trace =
    protocolTrace +
    '[pid 123] 1.0 execve("/engine/bin/MiniBrowser", [], []) = 0\n' +
    '[pid 456] 1.0 execve("/tools/bun", ["bun", "/owned/root.ts", "--root-child"], []) = 0\n' +
    "[pid 123] 2.0 +++ exited with 0 +++\n" +
    (ending ?? `[pid 456] 2.1 +++ exited with ${status} +++\n`);
  writeFileSync(join(root, "stderr.bin"), trace);
  writeFileSync(join(root, "stdout.bin"), "exact owned output");
  writeFileSync(
    join(root, "diagnostic-owner.json"),
    JSON.stringify({ pid: 456, executable: "/tools/bun", source: "/owned/root.ts" }),
  );
  writeFileSync(join(root, "collector-owner.json"), JSON.stringify({ pid: 789 }));
  writeFileSync(
    join(root, "collector-result.json"),
    JSON.stringify({
      pid: 789,
      status,
      signalCode: null,
      primaryPresent: false,
      cleanupErrors: [],
      unresolvedOwnership: [],
      stdoutSHA256: sha256(readFileSync(join(root, "stdout.bin"))),
      stderrSHA256: sha256(readFileSync(join(root, "stderr.bin"))),
    }),
  );
  writeFileSync(
    join(root, "result.json"),
    JSON.stringify({
      pid: 456,
      exitStatus: status,
      classification,
      primaryPresent: status !== 0,
      cleanupErrors: [],
      unresolvedOwnership: [],
    }),
  );
}

test("R66 expected loss exit is closed but censored; abnormal, missing and signal trace ends are not closed", () => {
  const root = mkdtempSync(
    join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "waffle-r66-terminal-"),
  );
  try {
    writeTerminalFixture(root, 1, "CENSORED_CAPTURE");
    const child = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
    expect(terminalEvidence(root, 1, child)).toBe(true);
    expect(finalizeCollection(root, 1, { kind: "none" })).toMatchObject({
      terminal: true,
      classification: "CENSORED_CAPTURE",
    });
    for (const status of [2, 137]) expect(terminalEvidence(root, status, child)).toBe(false);
    writeTerminalFixture(
      root,
      1,
      "COMPLETE_CORRELATED_LOSS",
      "[pid 456] 2.1 +++ killed by SIGKILL +++\n",
    );
    expect(terminalEvidence(root, 1, child)).toBe(false);
    writeTerminalFixture(root, 1, "COMPLETE_CORRELATED_LOSS", "");
    expect(terminalEvidence(root, 1, child)).toBe(false);
    writeTerminalFixture(root, 1, "COMPLETE_CORRELATED_LOSS");
    writeFileSync(
      join(root, "collector-result.json"),
      JSON.stringify({ pid: 789, status: 1, signalCode: "SIGTERM" }),
    );
    expect(terminalEvidence(root, 1, child)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const reason of [
  null,
  undefined,
  false,
  0,
  "",
  Object.freeze({ retained: "object identity" }),
]) {
  test(`R66 rejection presence, exit and rethrow retain ${String(reason)}`, async () => {
    const failures = new Failures();
    expect(diagnosticExitStatus(failures.primary)).toBe(0);
    failures.fail(reason);
    await cleanupCollection(
      [
        [
          "later-cleanup",
          () => {
            throw new Error("later secondary");
          },
        ],
      ],
      failures,
    );
    expect(diagnosticExitStatus(failures.primary)).toBe(1);
    expect(failures.receipt().primaryPresent).toBe(true);
    let caught: unknown = Symbol("no failure");
    try {
      failures.rethrow();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(reason);
    expect(failures.cleanupErrors.join("\n")).toContain("later secondary");
    expect(failures.unresolved).toEqual(["later-cleanup"]);
  });
}

test("R66 cleanup bounds a never-settling release and retains ownership without skipping later journals/handlers", async () => {
  const failures = new Failures();
  const primary = Object.freeze({ first: "retain identity" });
  failures.fail(primary);
  const attempted: string[] = [];
  await cleanupCollection(
    [
      [
        "termination",
        () => {
          attempted.push("termination");
          return new Promise(() => {});
        },
        20,
      ],
      [
        "first-journal",
        () => {
          attempted.push("first-journal");
          throw new Error("journal close rejected");
        },
      ],
      [
        "second-journal",
        () => {
          attempted.push("second-journal");
        },
      ],
      [
        "first-handler",
        () => {
          attempted.push("first-handler");
          throw new Error("handler remove rejected");
        },
      ],
      [
        "second-handler",
        () => {
          attempted.push("second-handler");
        },
      ],
    ],
    failures,
  );
  expect(attempted).toEqual([
    "termination",
    "first-journal",
    "second-journal",
    "first-handler",
    "second-handler",
  ]);
  expect(failures.unresolved).toEqual(["termination", "first-journal", "first-handler"]);
  expect(failures.primary).toEqual({ kind: "rejected", reason: primary });
  if (failures.primary.kind === "rejected") expect(failures.primary.reason).toBe(primary);
});

test("R66 unknown object formatting cannot overwrite the first primary or abort releases", async () => {
  const failures = new Failures();
  const primary = Object.freeze({
    toString() {
      throw new Error("cannot format");
    },
  });
  failures.fail(primary);
  let released = false;
  await cleanupCollection(
    [
      [
        "broken",
        () => {
          throw primary;
        },
      ],
      [
        "remaining",
        () => {
          released = true;
        },
      ],
    ],
    failures,
  );
  expect(released).toBe(true);
  expect(failures.receipt().primaryPresent).toBe(true);
  expect(failures.receipt().primary).toBe("<unprintable rejection reason>");
  let caught: unknown;
  try {
    failures.rethrow();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(primary);
});

test("R66 current child identity, descendant terminals and exact collected hashes are required", () => {
  const root = mkdtempSync(
    join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "waffle-r66-current-"),
  );
  try {
    writeTerminalFixture(root, 0, "NONREPRODUCTION");
    const child = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
    expect(terminalEvidence(root, 0, child)).toBe(true);
    expect(terminalEvidence(root, 0, { ...child, pid: 457 })).toBe(false);
    writeFileSync(
      join(root, "stderr.bin"),
      readFileSync(join(root, "stderr.bin"), "utf8").replace(
        "[pid 123] 2.0 +++ exited with 0 +++\n",
        "",
      ),
    );
    const collectorPath = join(root, "collector-result.json");
    const collector = JSON.parse(readFileSync(collectorPath, "utf8"));
    collector.stderrSHA256 = sha256(readFileSync(join(root, "stderr.bin")));
    writeFileSync(collectorPath, JSON.stringify(collector));
    expect(terminalEvidence(root, 0, child)).toBe(false);
    writeTerminalFixture(root, 0, "NONREPRODUCTION");
    writeFileSync(join(root, "stdout.bin"), "changed after receipt");
    expect(terminalEvidence(root, 0, child)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function unconfirmedCaptureCleanup(
  primary: { kind: "none" } | { kind: "rejected"; reason: unknown },
): Promise<void> {
  const root = mkdtempSync(
    join(process.env.STORAGE_SCRATCH_ROOT ?? tmpdir(), "waffle-r69-cleanup-"),
  );
  try {
    await checkUnconfirmedCapture(root, primary);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function checkUnconfirmedCapture(
  root: string,
  primary: { kind: "none" } | { kind: "rejected"; reason: unknown },
): Promise<void> {
  const state = sampleState();
  if (primary.kind === "rejected") state.failures.fail(primary.reason);
  const recovery = {
    diagnosticPid: 456,
    root,
    serverPort: 43037,
    ownerLog: join(root, "stdout.bin"),
  };
  state.capture = recovery;
  const attempted: string[] = [];
  state.server = {
    port: 43037,
    async stop() {
      attempted.push("server");
    },
  };
  await cleanupRun(
    state,
    {
      event() {
        attempted.push("journal-event");
        throw new Error("journal unavailable");
      },
    },
    {
      async stop() {
        attempted.push("capture-stop-fulfilled");
      },
      snapshot() {
        attempted.push("capture-snapshot");
        return { stopped: false, exitCode: null, serverPort: 43037 };
      },
    },
  );
  await cleanupCollection(
    [
      [
        "SIGTERM-handler",
        () => {
          attempted.push("SIGTERM-handler");
        },
      ],
      [
        "SIGINT-handler",
        () => {
          attempted.push("SIGINT-handler");
        },
      ],
      [
        "events-journal-close",
        () => {
          attempted.push("events-journal-close");
        },
      ],
      [
        "root-result",
        () => {
          attempted.push("root-result");
          durableJSON(join(root, "result.json"), {
            ...runReceipt(state),
            exitStatus: diagnosticExitStatus(state.failures.primary),
            classification: classify(false, state.failures.cleanupErrors.length === 0, [
              {
                kind: "correlated",
                requestHex: "00",
                responseHex: "00",
                response: "acknowledged",
                packets: 5,
              },
            ]),
          });
        },
      ],
    ],
    state.failures,
  );
  expect(attempted).toContain("capture-stop-fulfilled");
  expect(attempted).toContain("server");
  expect(attempted.slice(-4)).toEqual([
    "SIGTERM-handler",
    "SIGINT-handler",
    "events-journal-close",
    "root-result",
  ]);
  const result = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
  expect(result.unresolvedOwnership).toContain("capture");
  expect(result.captureRecovery).toEqual(recovery);
  expect(state.capture).toBe(recovery);
  expect(result.exitStatus).toBe(1);
  expect(result.classification).toBe("CENSORED_CAPTURE");
  expect(state.failures.cleanupErrors.join("\n")).toContain("Capture shutdown unconfirmed");
  expect(attempted).toContain("journal-event");
  if (primary.kind === "none") return;
  expect(state.failures.primary.kind).toBe("rejected");
  if (state.failures.primary.kind === "rejected")
    expect(state.failures.primary.reason).toBe(primary.reason);
  let caught: unknown = Symbol("not rejected");
  try {
    state.failures.rethrow();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(primary.reason);
}

test("R69 fulfilled capture stop with unconfirmed shutdown is unresolved and nonzero", async () => {
  await unconfirmedCaptureCleanup({ kind: "none" });
});

for (const reason of [null, undefined, false, 0, "", Object.freeze({ exact: "capture-primary" })]) {
  test(`R69 capture cleanup preserves earlier primary ${String(reason)}`, async () => {
    await unconfirmedCaptureCleanup({ kind: "rejected", reason });
  });
}

test("R69 confirmed stopped capture releases ownership", async () => {
  const state = sampleState();
  state.capture = {
    diagnosticPid: 456,
    root: "/owned/evidence",
    serverPort: 43037,
    ownerLog: "/owned/evidence/stdout.bin",
  };
  const attempted: string[] = [];
  await cleanupRun(state, quietJournal, {
    async stop() {
      attempted.push("stop");
    },
    snapshot() {
      attempted.push("snapshot");
      return { stopped: true, exitCode: 0, serverPort: 43037 };
    },
  });
  expect(attempted).toEqual(["stop", "snapshot"]);
  expect(state.capture).toBeUndefined();
  expect(state.failures.unresolved).toEqual([]);
  expect(diagnosticExitStatus(state.failures.primary)).toBe(0);
});

for (const mode of ["disabled", "unstarted"]) {
  test(`R69 ${mode} capture has no owned release or snapshot requirement`, async () => {
    const state = sampleState();
    let calls = 0;
    await cleanupRun(state, quietJournal, {
      async stop() {
        calls++;
      },
      snapshot() {
        calls++;
        throw new Error("No capture exists");
      },
    });
    expect(calls).toBe(0);
    expect(state.capture).toBeUndefined();
    expect(state.failures.primary.kind).toBe("none");
    expect(state.failures.unresolved).toEqual([]);
  });
}

for (const snapshot of [
  { stopped: false, exitCode: 0, serverPort: 43037 },
  { stopped: true, exitCode: null, serverPort: 43037 },
  { stopped: true, exitCode: 0, serverPort: 43038 },
]) {
  test(`R69 unconfirmed reader, process or capture identity retains ownership ${JSON.stringify(snapshot)}`, async () => {
    const state = sampleState();
    const recovery = {
      diagnosticPid: 456,
      root: "/owned/evidence",
      serverPort: 43037,
      ownerLog: "/owned/evidence/stdout.bin",
    };
    state.capture = recovery;
    await cleanupRun(state, quietJournal, { async stop() {}, snapshot: () => snapshot });
    expect(state.failures.unresolved).toEqual(["capture"]);
    expect(state.capture).toBe(recovery);
    expect(diagnosticExitStatus(state.failures.primary)).toBe(1);
  });
}

test("R69 default observer boundary is inert before any capture start", async () => {
  const state = sampleState();
  await cleanupRun(state, quietJournal);
  expect(state.failures.receipt().primaryPresent).toBe(false);
  expect(state.failures.unresolved).toEqual([]);
  expect(runReceipt(state).captureRecovery).toBeUndefined();
});
