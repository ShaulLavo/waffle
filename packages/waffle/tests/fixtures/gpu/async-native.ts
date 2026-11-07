import { gpuPayloadLayout, gpuStream } from "../../../browser/gpu/generated/tables.js";
import { GpuConnection } from "../../../browser/gpu/scheduler.js";
import { RecordRing } from "../../../browser/gpu/ring.js";
import { PayloadDirectory } from "../../../browser/gpu/payload.js";
import { ServiceCredit } from "../../../browser/gpu/protocol.js";
import { LogicalAppend } from "../../../browser/gpu/transport.js";
import { nativeObject } from "../../../browser/gpu/lowering.js";
import {
  WireReader,
  wireHandle,
  wireNumber,
  wireObject,
  wireArray,
  type WireObject,
} from "../../../browser/gpu/codec.js";
import { encodeGpuCommand, encodeGpuPrivate } from "../../../tooling/gpu-stream-layout.js";
import { blob, h } from "./bundle-query-fixture.js";

interface Reply {
  kind: number;
  token: number;
  status: number;
  fields: WireObject;
}
class AsyncNativeRig {
  readonly credit = new ServiceCredit();
  readonly backing = new SharedArrayBuffer(gpuPayloadLayout.byteLength);
  readonly directory = new PayloadDirectory(this.backing);
  readonly replies = new RecordRing(new SharedArrayBuffer(65536 + 64), 16);
  readonly connection: GpuConnection;
  readonly received: Reply[] = [];
  token = 3;
  constructor(gpu: object) {
    this.connection = new GpuConnection(
      new RecordRing(new SharedArrayBuffer(65536 + 64), 8),
      this.replies,
      { root: gpu },
      this.credit,
      { arena: new Uint8Array(this.backing) },
    );
  }
  async open(): Promise<void> {
    this.call("instance.request_adapter", {
      result: h(2),
      token: 1,
      receiver: h(1),
      options: null,
    });
    check((await this.reply(1)).fields.status === 1, "Adapter request failed");
    check(
      Reflect.get(nativeObject(Reflect.get(this.native(2, "adapter"), "info")), "architecture") ===
        "swiftshader",
      "Async controls require designated SwiftShader",
    );
    this.call("adapter.request_device", {
      result: h(3),
      token: 2,
      receiver: h(2),
      descriptor: null,
    });
    check((await this.reply(2)).fields.status === 1, "Device request failed");
    this.call("device.get_queue", { result: h(4), receiver: h(3) });
  }
  native(id: number, kind: "device" | "adapter" | "buffer" | "shader_module"): object {
    return this.connection.replay.handles.native(h(id), kind);
  }
  call(name: string, fields: unknown): void {
    this.publish(encodeGpuCommand(gpuStream, name, fields));
  }
  publish(bytes: Uint8Array): void {
    const append = new LogicalAppend(this.connection.commands, bytes);
    try {
      for (let turn = 0; turn < 100000; turn++) {
        const state = append.advance();
        this.connection.slice();
        if (state === "terminal" || (state === "done" && !this.connection.replay.busy)) return;
      }
      throw new Error("Async control publication exceeded bound");
    } finally {
      if (this.connection.state.kind === "terminal") append.cancel();
    }
  }
  buffer(id: number, usage: number, mapped = false): void {
    this.call("device.create_buffer", {
      result: h(id),
      receiver: h(3),
      descriptor: {
        next_in_chain: [],
        label: "G2 original buffer",
        usage,
        size: 32,
        mapped_at_creation: mapped,
      },
    });
  }
  async query(name: string, id: number, extra: WireObject = {}): Promise<WireObject> {
    const token = this.token++;
    this.call(name, { token, receiver: h(id), ...extra });
    const result = await this.reply(token);
    check(result.kind === 19 && result.status === 0, "Typed query failed");
    const output = this.payload(result);
    return wireObject(
      new WireReader(output).type(`struct.query_${wireNumber(result.fields.opcode)}`),
    );
  }
  async map(id: number, mode: number, offset = 0, size = 0xffffffffffffffffn): Promise<Reply> {
    const token = this.token++;
    this.call("buffer.map_async", { token, receiver: h(id), mode, offset, size });
    return this.reply(token);
  }
  writes(id: number, ranges: readonly { offset: number; data: readonly number[] }[]): void {
    this.publish(encodeGpuPrivate(gpuStream, "buffer-unmap-writes", { buffer: h(id), ranges }));
  }
  copy(source: number, destination: number, encoder: number): void {
    this.call("device.create_command_encoder", {
      result: h(encoder),
      receiver: h(3),
      descriptor: null,
    });
    this.publish(
      blob(0x1001, encoder, [
        encodeGpuCommand(gpuStream, "command_encoder.copy_buffer_to_buffer", {
          source: h(source),
          source_offset: 0,
          destination: h(destination),
          destination_offset: 0,
          size: 32,
        }),
        encodeGpuCommand(gpuStream, "command_encoder.finish", {
          result: h(encoder + 1),
          descriptor: null,
        }),
      ]),
    );
    this.call("queue.submit", { receiver: h(4), commands: [h(encoder + 1)] });
  }
  async work(): Promise<Reply> {
    const token = this.token++;
    this.call("queue.on_submitted_work_done", { token, receiver: h(4) });
    return this.reply(token);
  }
  push(filter = 1): void {
    this.call("device.push_error_scope", { receiver: h(3), filter });
  }
  async pop(): Promise<Reply> {
    const token = this.token++;
    this.call("device.pop_error_scope", { receiver: h(3), token });
    return this.reply(token);
  }
  payload(reply: Reply): Uint8Array {
    const bytes = new Uint8Array(wireNumber(reply.fields.length));
    const result = this.directory.copyOnce(
      wireHandle(reply.fields.payload),
      bytes,
      () => this.connection.commands.terminal()?.reason,
      (reason) => {
        this.connection.close(reason);
        return this.connection.commands.terminal()?.reason ?? 0;
      },
    );
    check(result === 0, `Native payload copy failed ${result}`);
    return bytes;
  }
  async reply(token: number, kind?: number): Promise<Reply> {
    const deadline = performance.now() + 20000;
    while (performance.now() < deadline) {
      this.drain();
      const index = this.received.findIndex(
        (reply) => reply.token === token && (kind === undefined || reply.kind === kind),
      );
      if (index >= 0) {
        const reply = this.received.splice(index, 1)[0];
        if (reply) return reply;
      }
      check(
        this.connection.state.kind === "ready",
        `Native async connection terminated ${JSON.stringify(this.connection.state)} ${JSON.stringify(this.connection.replay.snapshot())} ${this.connection.completions.failure}`,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    throw new Error(
      `Native async reply timed out ${token}/${kind}, queued ${JSON.stringify(this.received)}, replay ${JSON.stringify(this.connection.replay.snapshot())}`,
    );
  }
  drain(): void {
    const bytes = new Uint8Array(this.replies.capacity);
    for (let turns = 0; turns < 1000; turns++) {
      const result = this.replies.readInto(bytes);
      if (result.kind !== "record") return;
      const record = bytes.slice(0, result.bytes),
        view = new DataView(record.buffer),
        kind = view.getUint16(0, true);
      const layout = gpuStream.completions.find((entry) => entry.kind === kind);
      if (!layout) throw new Error("Unknown native reply");
      this.received.push({
        kind,
        token: view.getUint32(8, true),
        status: view.getInt32(12, true),
        fields: new WireReader(record, 16).fields(layout.fields),
      });
    }
    throw new Error("Native async reply drain exceeded bound");
  }
  close(): void {
    this.connection.close();
    check(this.credit.used === 0, "Async control retained heap credit");
    check(
      this.connection.replay.snapshot().views === 0,
      "Async control retained native mapping views",
    );
  }
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected native output array");
  return value;
}
async function metadata(rig: AsyncNativeRig): Promise<void> {
  const info = wireObject((await rig.query("adapter.get_info", 2)).info);
  check(
    wireObject((await rig.query("device.get_adapter_info", 3)).adapter_info).vendor === info.vendor,
    "Device adapter_info output name/identity differs",
  );
  const actual = nativeObject(Reflect.get(rig.native(2, "adapter"), "info"));
  for (const key of ["vendor", "architecture", "device", "description"])
    check(info[key] === Reflect.get(actual, key), `Native adapter ${key} changed`);
  for (const [prefix, id] of [
    ["adapter", 2],
    ["device", 3],
  ] as const) {
    const result = await rig.query(`${prefix}.get_features`, id);
    const features = array(wireObject(result.features).features);
    for (const feature of features)
      check(
        (await rig.query(`${prefix}.has_feature`, id, { feature: Number(feature) })).returned ===
          true,
        "Feature query disagrees with enumeration",
      );
    const limits = wireObject((await rig.query(`${prefix}.get_limits`, id)).limits);
    const native = nativeObject(Reflect.get(rig.native(id, prefix), "limits"));
    check(
      limits.max_texture_dimension_2D === Reflect.get(native, "maxTextureDimension2D"),
      "Native granted limits changed",
    );
  }
  const wgsl = array(
    wireObject((await rig.query("instance.get_WGSL_language_features", 1)).features).features,
  );
  for (const feature of wgsl)
    check(
      (await rig.query("instance.has_WGSL_language_feature", 1, { feature: Number(feature) }))
        .returned === true,
      "WGSL feature enumeration differs",
    );
  const limits: WireObject = {};
  for (const field of gpuStream.structs.limits.fields)
    limits[field.name] =
      field.name === "next_in_chain"
        ? []
        : field.type === "uint64"
          ? 0xffffffffffffffffn
          : 0xffffffff;
  const adapterToken = rig.token++;
  rig.call("instance.request_adapter", {
    result: h(30),
    token: adapterToken,
    receiver: h(1),
    options: null,
  });
  check(
    (await rig.reply(adapterToken)).fields.status === 1,
    "Fresh adapter for limit request failed",
  );
  limits.max_texture_dimension_2D =
    Number(
      Reflect.get(
        nativeObject(Reflect.get(rig.native(30, "adapter"), "limits")),
        "maxTextureDimension2D",
      ),
    ) + 1;
  const token = rig.token++;
  rig.call("adapter.request_device", {
    result: h(31),
    token,
    receiver: h(30),
    descriptor: {
      next_in_chain: [],
      label: "excessive native limit",
      required_features: [],
      required_limits: limits,
      default_queue: { next_in_chain: [], label: "" },
    },
  });
  check(
    (await rig.reply(token)).fields.status !== 1,
    "Excessive native limit was clamped into a grant",
  );
  check(rig.connection.state.kind === "ready", "Excessive limit terminated protocol");
}
async function mapping(rig: AsyncNativeRig): Promise<void> {
  rig.buffer(5, 36, true);
  rig.buffer(6, 9);
  const identity = rig.native(5, "buffer"),
    usage = Reflect.get(identity, "usage");
  rig.push();
  rig.copy(5, 6, 10);
  check(
    (await rig.pop()).fields.type === gpuStream.enums["enum.error_type"].validation,
    "Submit while mapped did not reach native validation",
  );
  rig.push();
  rig.writes(5, [{ offset: 8, data: [37, 37, 37, 37] }]);
  rig.copy(5, 6, 12);
  check((await rig.work()).fields.status === 1, "Specific queue work completion failed");
  check(
    (await rig.pop()).fields.type === gpuStream.enums["enum.error_type"].no_error,
    "Native mapped write failed",
  );
  const read = await rig.map(6, 1);
  check(read.fields.status === 1, "Native read map failed");
  const bytes = rig.payload(read);
  check(
    bytes.every((value, index) => value === (index >= 8 && index < 12 ? 37 : 0)),
    "Native mapped-at-creation bytes or untouched zeroes differ",
  );
  rig.call("buffer.unmap", { receiver: h(6) });
  check(
    rig.native(5, "buffer") === identity &&
      Reflect.get(identity, "usage") === usage &&
      usage === 36,
    "Native buffer identity or original usage changed",
  );
  rig.buffer(7, 6);
  const write = await rig.map(7, 2);
  check(write.fields.status === 1, "Real native MAP_WRITE failed");
  rig.payload(write);
  rig.writes(7, [{ offset: 0, data: [53, 53, 53, 53] }]);
  const remap = await rig.map(7, 2);
  check(remap.fields.status === 1, "Native remap failed");
  check(
    rig
      .payload(remap)
      .slice(0, 4)
      .every((value) => value === 53),
    "Write remap lost prior contents",
  );
  rig.call("buffer.unmap", { receiver: h(7) });
  const again = await rig.map(6, 1);
  check(again.fields.status === 1, "Native read remap failed");
  const shadow = rig.payload(again);
  shadow.fill(99);
  rig.call("buffer.unmap", { receiver: h(6) });
  const preserved = await rig.map(6, 1);
  check(rig.payload(preserved)[8] === 37, "Read shadow writes changed native bytes");
  rig.call("buffer.unmap", { receiver: h(6) });
}
async function scopesCompilationLoss(rig: AsyncNativeRig): Promise<void> {
  rig.push(3);
  rig.push(1);
  rig.buffer(5, 10);
  rig.buffer(6, 9);
  rig.copy(5, 6, 10);
  check(
    rig.connection.replay.handles.get(h(5), "buffer").kind === "native",
    "Invalid native buffer became an exception placeholder",
  );
  check(
    (await rig.pop()).fields.type === gpuStream.enums["enum.error_type"].validation,
    "Invalid creation/dependent use bypassed real scope",
  );
  check(
    (await rig.pop()).fields.type === gpuStream.enums["enum.error_type"].no_error,
    "Nested scope was fabricated",
  );
  check((await rig.pop()).status < 0, "Empty native scope pop did not fail");
  const source = "// λ😀\n@compute @workgroup_size(1) fn main() { let 猫 = ; }";
  rig.push();
  rig.call("device.create_shader_module", {
    result: h(7),
    receiver: h(3),
    descriptor: {
      next_in_chain: [{ sType: 2, value: { code: source } }],
      label: "native compilation",
    },
  });
  const module = rig.native(7, "shader_module");
  const getInfo: unknown = Reflect.get(module, "getCompilationInfo");
  if (typeof getInfo !== "function") throw new Error("Missing native compilation method");
  let observed: object | undefined;
  Object.defineProperty(module, "getCompilationInfo", {
    value: () => {
      const promise: unknown = Reflect.apply(getInfo, module, []);
      if (!(promise instanceof Promise))
        throw new Error("Native compilation method returned no promise");
      void promise.then((info: unknown) => {
        observed = nativeObject(info);
      });
      return promise;
    },
  });
  const token = rig.token++;
  rig.call("shader_module.get_compilation_info", { receiver: h(7), token });
  const result = await rig.reply(token);
  check(
    result.kind === 17 && result.status === 0 && result.fields.status === 1,
    "Native compilation info failed",
  );
  const info = wireObject(new WireReader(rig.payload(result)).type("struct.compilation_info"));
  const messages = wireArray(info.messages);
  check(messages.length > 0, "Invalid WGSL returned no native messages");
  if (!observed) throw new Error("Native compilation observation missing");
  const nativeInfo = observed;
  const nativeMessages = array(Reflect.get(nativeInfo, "messages"));
  check(messages.length === nativeMessages.length, "Compilation messages truncated");
  for (let index = 0; index < messages.length; index++) {
    const message = wireObject(messages[index]),
      native = nativeObject(nativeMessages[index]);
    const offset = Number(Reflect.get(native, "offset")),
      length = Number(Reflect.get(native, "length"));
    check(message.message === Reflect.get(native, "message"), "Native compilation message changed");
    check(
      message.offset === BigInt(new TextEncoder().encode(source.slice(0, offset)).length) &&
        message.length ===
          BigInt(new TextEncoder().encode(source.slice(offset, offset + length)).length),
      "C compilation byte positions differ from UTF-8 source",
    );
  }
  await rig.pop();
  rig.buffer(8, 0);
  check(
    (await rig.work()).fields.status === 1,
    "Queue completion did not flush native uncaptured delivery",
  );
  check(
    (await rig.reply(0, 6)).fields.type === gpuStream.enums["enum.error_type"].validation,
    "Native uncaptured error was not routed",
  );
  rig.call("device.destroy", { receiver: h(3) });
  const lost = await rig.reply(0, 7),
    nativeLoss = nativeObject(await Reflect.get(rig.native(3, "device"), "lost"));
  check(
    lost.fields.reason === gpuStream.enums["enum.device_lost_reason"].destroyed &&
      lost.fields.message === Reflect.get(nativeLoss, "message"),
    "Native device loss fields were not explicitly read",
  );
  check(
    rig.connection.replay.devicesLive === 0 && rig.connection.state.kind === "ready",
    "Device loss closed the connection or retained native count",
  );
}
async function mappingNegative(rig: AsyncNativeRig): Promise<void> {
  rig.buffer(5, 9);
  for (const mode of [0, 3]) {
    rig.push();
    check(
      (await rig.map(5, mode)).fields.status === gpuStream.enums["enum.map_async_status"].error,
      "Invalid raw native mode succeeded",
    );
    check(
      (await rig.pop()).fields.type === gpuStream.enums["enum.error_type"].validation,
      "Invalid raw mode did not reach native scope",
    );
  }
  rig.push();
  check(
    (await rig.map(5, 1, 4, 8n)).fields.status === gpuStream.enums["enum.map_async_status"].error,
    "Misaligned native map succeeded",
  );
  check(
    (await rig.pop()).fields.type === gpuStream.enums["enum.error_type"].validation,
    "Misaligned map did not reach native validation",
  );
  check(rig.connection.state.kind === "ready", "Ordinary map validation terminated protocol");
}
/** Page-authored host control only. The separate C fixture owns compiled guest acceptance. */
export async function asyncNativeControl(control: string) {
  const gpu = nativeObject(Reflect.get(navigator, "gpu"));
  const rig = new AsyncNativeRig(gpu),
    other = new AsyncNativeRig(gpu);
  try {
    await rig.open();
    await other.open();
    if (control === "metadata") await metadata(rig);
    else if (control === "mapping") await mapping(rig);
    else if (control === "scopes-compilation-work-loss") await scopesCompilationLoss(rig);
    else if (control === "mapping-negative") await mappingNegative(rig);
    else throw new Error(`Unknown async native control ${control}`);
    check(
      (await other.work()).fields.status === 1,
      "Other connection/device stopped making progress",
    );
    return {
      control,
      kind: "native-lowering-control",
      compiledGuest: false,
      status: "passed",
      adapter: "swiftshader",
    };
  } finally {
    rig.close();
    other.close();
  }
}
