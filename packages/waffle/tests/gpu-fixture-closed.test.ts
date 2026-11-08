import { beforeAll, describe, expect, test } from "bun:test";
import { verifiedGpuFixture } from "../scripts/build-gpu-fixture.js";
import { gpuStream } from "../browser/gpu/generated/tables.js";
import { encodeGpuCompletion } from "../tooling/gpu-stream-layout.js";
import { FixtureProtocolHost, type ReplyFault } from "./gpu-fixture-host.js";

const directory = process.env.GPU_FIXTURE_DIR;
let wasm: Uint8Array<ArrayBuffer>;
beforeAll(() => {
  if (directory) wasm = verifiedGpuFixture(directory);
});

type Batch =
  | { readonly kind: "records"; readonly records: readonly Uint8Array[]; readonly queued?: boolean }
  | { readonly kind: "import-error"; readonly status: number };

class ClosedReplyHost extends FixtureProtocolHost {
  readonly calls: {
    status: number;
    bytes: number;
    commands: number;
    errors: string;
    timeout: bigint;
    closes: number;
  }[] = [];
  private batch = 0;
  constructor(
    readonly at: number,
    readonly batches: readonly Batch[],
    fault: ReplyFault = "none",
    args: readonly string[] = ["red"],
  ) {
    super(wasm, args, fault);
  }
  override completions(ptr: number, length: number, timeout: bigint, written: number): number {
    const status =
      this.calls.length < this.at - 1
        ? super.completions(ptr, length, timeout, written)
        : this.controlledRead(ptr, length, timeout, written);
    this.calls.push({
      status,
      bytes: status === 0 ? this.view.getUint32(written, true) : 0,
      commands: this.commands.length,
      errors: this.errors.join(""),
      timeout,
      closes: this.closes,
    });
    return status;
  }
  private controlledRead(ptr: number, length: number, timeout: bigint, written: number): number {
    const batch = this.batches[this.batch++];
    if (!batch) throw new Error("C read past the scripted terminal result");
    if (batch.kind === "import-error") return batch.status;
    let prefix: Uint8Array[] = [];
    if (batch.queued) {
      super.completions(ptr, length, timeout, written);
      prefix = [this.bytes(ptr, this.view.getUint32(written, true))];
    }
    const bytes = Buffer.concat(prefix.concat(batch.records));
    if (bytes.length > length) throw new Error("Control exceeds completion destination");
    this.put(ptr, bytes);
    this.word(written, bytes.length);
    return 0;
  }
}

function closed(reason = 4): Uint8Array {
  return encodeGpuCompletion(gpuStream, "closed", 0, 0, { reason });
}
function changed(offset: number, value: number): Uint8Array {
  const bytes = Buffer.from(closed());
  bytes.writeUInt32LE(value, offset);
  return bytes;
}
function terminal(status: number): Batch {
  return { kind: "import-error", status };
}
function failed(host: ClosedReplyHost, stage: string, status: number): void {
  expect(host.run()).toBe(1);
  expect(host.errors.join("")).toBe(`GPU_FAIL stage=${stage} status=${status}\n`);
  expect(host.output.join("")).not.toContain("GPU_FRAME");
  expect(host.output.join("")).not.toContain("GPU_STAGE closed");
  expect(host.closes).toBe(1);
  expect(host.closed).toBe(true);
}

// These are executions of the real producer's WASI C command, not rendering acceptance.
describe.skipIf(!directory)("compiled C closed replies during waits", () => {
  const waits = [1, 2, 3, 4, 5, 6].flatMap((at) => [
    { at, queued: false },
    { at, queued: true },
  ]);
  test.each([1, 2, 3, 4, 5].flatMap((reason) => waits.map((wait) => ({ reason, ...wait }))))(
    "reason $reason during wait $at with queued success $queued drains before actual terminal import",
    ({ reason, at, queued }) => {
      const status = reason === 3 ? -48 : -64;
      const host = new ClosedReplyHost(at, [
        { kind: "records", records: [closed(reason)], queued },
        terminal(status),
      ]);
      failed(host, "completions", status);
      expect(host.calls.map((call) => call.status)).toEqual(Array(at).fill(0).concat(status));
      const batch = host.calls.at(-2);
      const actual = host.calls.at(-1);
      expect(batch?.bytes).toBeGreaterThanOrEqual(24);
      expect(actual?.errors).toBe("");
      expect(actual?.commands).toBe(batch?.commands);
      expect(actual?.closes).toBe(0);
      expect(host.calls.slice(-2).map((call) => call.timeout)).toEqual([-1n, -1n]);
    },
  );

  test("revocation during the compiled heavy scope wait reads the actual terminal errno", () => {
    const host = new ClosedReplyHost(
      5,
      [{ kind: "records", records: [closed()] }, terminal(-64)],
      "none",
      ["--fairness-heavy"],
    );
    failed(host, "completions", -64);
    expect(host.output.join("")).toContain(
      "GPU_FAIRNESS_BLOB draws=200000 bytes=4800184 appends=1",
    );
    expect(host.output.join("")).toContain("GPU_FAIRNESS_PUBLISHED");
    expect(host.output.join("")).not.toContain("GPU_FAIRNESS_REPLAYED");
    expect(host.commands.filter((bytes) => bytes[0] === 17)).toHaveLength(0);
    expect(host.calls.map((call) => call.status)).toEqual([0, 0, 0, 0, 0, -64]);
  });

  test("ordinary zero-time close drain cannot ignore closed or report a clean close", () => {
    const host = new ClosedReplyHost(7, [{ kind: "records", records: [closed()] }, terminal(-64)]);
    expect(host.run()).toBe(1);
    expect(host.errors.join("")).toBe("GPU_FAIL stage=completions status=-64\n");
    expect(host.output.join("").match(/GPU_FRAME/g)).toHaveLength(1);
    expect(host.output.join("")).not.toContain("GPU_STAGE closed");
    expect(host.closes).toBe(1);
    expect(host.calls.slice(-2).map((call) => call.timeout)).toEqual([0n, 0n]);
    expect(host.calls.map((call) => call.status)).toEqual([0, 0, 0, 0, 0, 0, 0, -64]);
  });

  test.each([
    { reason: 4, status: -29 },
    { reason: 3, status: -64 },
  ])("reason $reason never fabricates errno instead of actual $status", ({ reason, status }) => {
    const host = new ClosedReplyHost(1, [
      { kind: "records", records: [closed(reason)] },
      terminal(status),
    ]);
    failed(host, "completions", status);
    expect(host.calls.map((call) => call.status)).toEqual([0, status]);
  });

  test.each([
    { name: "flags", record: changed(0, 0x1000c), stage: "reply-flags" },
    { name: "token", record: changed(8, 1), stage: "closed-token" },
    { name: "bridge status", record: changed(12, 28), stage: "reply-status", status: 28 },
    { name: "framing", record: changed(4, 15), stage: "reply-framing" },
    { name: "truncated header", record: closed().subarray(0, 8), stage: "reply-size" },
    { name: "missing reason", record: changed(4, 16).subarray(0, 16), stage: "closed-size" },
    {
      name: "extra bytes",
      record: Buffer.concat([changed(4, 32), Buffer.alloc(8)]),
      stage: "closed-size",
    },
    { name: "zero reason", record: changed(16, 0), stage: "closed-reason" },
    { name: "unknown reason", record: changed(16, 6), stage: "closed-reason" },
    { name: "negative reason", record: changed(16, 0xffffffff), stage: "closed-reason" },
    { name: "padding", record: changed(20, 1), stage: "closed-padding" },
  ])("rejects invalid closed $name for its own reason", ({ record, stage, status = -28 }) => {
    const host = new ClosedReplyHost(1, [{ kind: "records", records: [record] }, terminal(-64)]);
    failed(host, stage, status);
    expect(host.calls.map((call) => call.status)).toEqual([0]);
  });

  test.each([false, true])("rejects records after closed, split batch %s", (split) => {
    const credit = encodeGpuCompletion(gpuStream, "frame-credit", 0, 0, {
      surface: { id: 4, generation: 1 },
    });
    const batches: Batch[] = split
      ? [
          { kind: "records", records: [closed()] },
          { kind: "records", records: [credit] },
        ]
      : [{ kind: "records", records: [closed(), credit] }];
    const host = new ClosedReplyHost(1, batches.concat(terminal(-64)));
    failed(host, "reply-after-closed", -28);
    expect(host.calls.map((call) => call.status)).toEqual(split ? [0, 0] : [0]);
  });

  test.each([false, true])("rejects a second closed record, split batch %s", (split) => {
    const batches: Batch[] = split
      ? [
          { kind: "records", records: [closed()] },
          { kind: "records", records: [closed()] },
        ]
      : [{ kind: "records", records: [closed(), closed()] }];
    const host = new ClosedReplyHost(1, batches.concat(terminal(-64)));
    failed(host, "reply-after-closed", -28);
    expect(host.calls).toHaveLength(split ? 2 : 1);
  });

  test("rejects malformed framing after a previously consumed closed record", () => {
    const host = new ClosedReplyHost(1, [
      { kind: "records", records: [closed()] },
      { kind: "records", records: [changed(4, 15)] },
      terminal(-64),
    ]);
    failed(host, "reply-framing", -28);
    expect(host.calls.map((call) => call.status)).toEqual([0, 0]);
  });

  test.each([
    { fault: "adapter", at: 1, stage: "request-result", status: 3 },
    { fault: "scope", at: 4, stage: "validation-scope", status: 2 },
    { fault: "present", at: 5, stage: "present", status: 2 },
  ] satisfies { fault: ReplyFault; at: number; stage: string; status: number }[])(
    "preserves a real $fault failure committed before closed",
    ({ fault, at, stage, status }) => {
      const host = new ClosedReplyHost(
        at,
        [{ kind: "records", records: [closed()], queued: true }, terminal(-64)],
        fault,
      );
      failed(host, stage, status);
      expect(host.calls).toHaveLength(at);
      expect(host.calls.every((call) => call.status === 0)).toBe(true);
    },
  );
});
