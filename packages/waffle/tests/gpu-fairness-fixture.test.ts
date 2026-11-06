import { beforeAll, describe, expect, test } from "bun:test";
import { verifiedGpuFixture } from "../scripts/build-gpu-fixture.js";
import { FixtureProtocolHost } from "./gpu-fixture-host.js";
import { decodeCall, wireObject } from "../browser/gpu/codec.js";
import { GpuScheduler } from "../browser/gpu/scheduler.js";
import { LogicalAppend } from "../browser/gpu/transport.js";
import { command, drain, handle, RecordingTarget, rig } from "./fixtures/gpu/core-fixture.js";

const directory = process.env.GPU_FIXTURE_DIR;
let wasm: Uint8Array<ArrayBuffer>;
beforeAll(() => {
  if (directory) wasm = verifiedGpuFixture(directory);
});
const opcode = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset).getUint16(0, true);
class FairnessHost extends FixtureProtocolHost {
  readonly appendSizes: number[] = [];
  override append(ptr: number, length: number) {
    this.appendSizes.push(length);
    return super.append(ptr, length);
  }
  override fdRead(fd: number, iovs: number, count: number, written: number) {
    const result = super.fdRead(fd, iovs, count, written);
    if (this.reads.length === 3) this.put(this.view.getUint32(iovs, true), new Uint8Array([113]));
    return result;
  }
}
function run(args: string[]) {
  const host = new FairnessHost(wasm, args);
  expect(host.run()).toBe(0);
  expect(host.errors.join("")).toBe("");
  expect(host.output.join("")).toContain("GPU_STAGE closed");
  return host;
}
function blobRecords(blob: Uint8Array) {
  const size = new DataView(blob.buffer, blob.byteOffset).getUint32(16, true);
  const commands = blob.subarray(20, 20 + size);
  const records: Uint8Array[] = [];
  for (let at = 0; at < commands.length;) {
    const size = new DataView(commands.buffer, commands.byteOffset + at).getUint32(4, true);
    if (size < 8 || size % 8 || size > commands.length - at)
      throw new Error("Invalid compiled nested framing");
    records.push(commands.subarray(at, at + size));
    at += size;
  }
  return records;
}
function equalBytes(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((value, at) => value === right[at]);
}
function largeBlob() {
  const host = run(["--fairness-heavy"]);
  const blobs = host.commands.filter((bytes) => opcode(bytes) === 0x1001);
  expect(blobs).toHaveLength(1);
  return { host, blob: blobs[0]! };
}

describe.skipIf(!directory)(
  "compiled fairness fixture, protocol and deterministic scheduling",
  () => {
    test("publishes exactly one logical 200000-draw encode larger than the default command ring", () => {
      const { host, blob } = largeBlob();
      expect(blob.byteLength).toBeGreaterThan(4 * 1024 * 1024);
      expect(host.appendSizes.filter((size) => size > 4 * 1024 * 1024)).toEqual([blob.byteLength]);
      const records = blobRecords(blob);
      const draw = new Uint8Array([
        14, 0, 0, 0, 24, 0, 0, 0, 3, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ]);
      const draws = records.filter((bytes) => opcode(bytes) === 14);
      expect(draws).toHaveLength(200000);
      expect(draws.every((bytes) => equalBytes(bytes, draw))).toBe(true);
      expect(records.slice(0, 2).map(opcode)).toEqual([12, 13]);
      expect(records.slice(-2).map(opcode)).toEqual([15, 16]);
      expect(host.readSubmitCounts).toEqual([0, 1]);
      expect(host.readPresentCounts).toEqual([0, 1]);
      expect(host.output.join("")).toContain("GPU_FAIRNESS_REPLAYED draws=200000");
    });

    test("the actual compiled blob yields inside its open pass while a second connection presents", () => {
      const { blob } = largeBlob();
      const target = new RecordingTarget();
      const heavy = rig(target, 4 * 1024 * 1024);
      const peer = rig({
        root: {},
        surfaces: {
          create: () => ({}),
          configure() {},
          acquire: () => ({ kind: "await" }),
          present: () => ({ kind: "ready", status: 1 }),
          unconfigure() {},
          release() {},
        },
      });
      heavy.connection.replay.handles.reserve(handle(10), "command_encoder");
      heavy.connection.replay.handles.bind(handle(10), "command_encoder", {
        kind: "native",
        value: target.encoder,
      });
      heavy.connection.replay.handles.reserve(handle(7), "render_pipeline");
      heavy.connection.replay.handles.bind(handle(7), "render_pipeline", {
        kind: "native",
        value: target.pipeline,
      });
      heavy.connection.replay.handles.reserve(handle(9), "texture_view");
      heavy.connection.replay.handles.bind(handle(9), "texture_view", {
        kind: "native",
        value: target.view,
      });
      peer.connection.replay.handles.reserve(handle(4), "surface");
      peer.connection.replay.handles.bind(handle(4), "surface", { kind: "native", value: {} });
      const scheduler = new GpuScheduler();
      scheduler.add(heavy.connection);
      scheduler.add(peer.connection);
      const append = new LogicalAppend(heavy.commands, blob);
      let clock = 0,
        turns = 0,
        peerPresents = 0,
        published = false;
      try {
        while (
          !published ||
          heavy.connection.replay.busy ||
          target.calls.at(-1)?.member !== "finish"
        ) {
          if (++turns > 10000) throw new Error("Compiled fairness stream stopped progressing");
          if (!published) published = append.advance() === "done";
          const writer = peer.commands.tryAcquireWriter();
          if (writer.kind !== "acquired") throw new Error("Missing peer writer");
          writer.writer.tryWrite(command("surface.present", { receiver: handle(4), token: turns }));
          writer.writer.release();
          scheduler.turn({ bytes: 1024 * 1024, milliseconds: 4, now: () => (clock += 0.02) });
          peerPresents += drain(peer.replies).length;
          expect(heavy.connection.state.kind).toBe("ready");
          expect(peer.connection.state.kind).toBe("ready");
        }
        expect(turns).toBeGreaterThan(100);
        expect(peerPresents).toBeGreaterThan(100);
        expect(target.calls.filter((call) => call.member === "draw")).toHaveLength(200000);
        expect(target.calls.filter((call) => call.member === "beginRenderPass")).toHaveLength(1);
        expect(target.calls.filter((call) => call.member === "finish")).toHaveLength(1);
      } finally {
        append.cancel();
        heavy.connection.close();
        peer.connection.close();
      }
      expect(heavy.credit.used).toBe(0);
      expect(peer.credit.used).toBe(0);
    });

    test("the bounded compiled peer presents distinct frames and stops on stdin q", () => {
      const host = run(["green", "--fairness-peer"]);
      expect(host.readPresentCounts).toEqual([1, 2, 3]);
      expect(host.commands.filter((bytes) => opcode(bytes) === 6)).toHaveLength(3);
      expect(host.output.join("")).toContain("GPU_FRAME colour=green frame=3 validation=none");
    });

    test.each([17, 193, 8191])(
      "seed %i splits three distinct frames at each real completion checkpoint",
      (seed) => {
        const host = run(["blue", "--fairness-seed", String(seed)]);
        const blobs = host.commands.filter((bytes) => opcode(bytes) === 0x1001);
        expect(blobs).toHaveLength(3);
        expect(host.reads).toHaveLength(15);
        expect(host.readPresentCounts).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3]);
        for (const [index, blob] of blobs.entries()) {
          const begin = decodeCall(blobRecords(blob)[0]!);
          const attachments = wireObject(begin.fields.descriptor).color_attachments;
          expect(attachments).toEqual([
            {
              next_in_chain: [],
              view: handle(index ? 65 + index * 8 : 9),
              depth_slice: 0xffffffff,
              resolve_target: null,
              load_op: 2,
              store_op: 1,
              clear_value: {
                r: ((seed + index * 17) % 64) / 255,
                g: ((seed * 3 + index * 11) % 64) / 255,
                b: ((seed * 7 + index * 5) % 64) / 255,
                a: 1,
              },
            },
          ]);
        }
      },
    );
  },
);
