import { FixtureProtocolHost } from "../../gpu-fixture-host.js";
import { decodeCall, wireHandle, wireNumber } from "../../../browser/gpu/codec.js";
import { gpuStream } from "../../../browser/gpu/generated/tables.js";
import { encodeGpuStruct } from "../../../tooling/gpu-stream-layout.js";

export type AsyncReplyFault =
  | "none"
  | "token"
  | "query-opcode"
  | "query-truncated"
  | "void-scalar"
  | "output-chain"
  | "map-length"
  | "map-status"
  | "compilation-location"
  | "compilation-chain"
  | "loss-reason"
  | "payload-reusable"
  | "short-consumes";
const handle = (id: number) => ({ id, generation: 1 });
const creation = () => {
  const bytes = new Uint8Array(64);
  bytes.fill(37, 8, 16);
  bytes.fill(61, 24, 32);
  return bytes;
};
const writeMap = () => {
  const bytes = new Uint8Array(64);
  bytes.fill(53, 8, 16);
  return bytes;
};

/** Controlled replies for the real C decoder. No native API or validation is implemented here. */
export class AsyncProtocolHost extends FixtureProtocolHost {
  private payloads = new Map<number, Uint8Array>();
  private consumed = new Set<number>();
  private serial = 0;
  private maps = 0;
  private pops = 0;
  private omittedWrites = false;
  private terminal = 0;
  readonly protocolErrors: string[] = [];
  readonly decoded: ReturnType<typeof decodeCall>[] = [];
  readonly payloadCalls: { capacity: number; status: number }[] = [];
  constructor(
    wasm: Uint8Array<ArrayBuffer>,
    args: readonly string[] = [],
    readonly asyncFault: AsyncReplyFault = "none",
  ) {
    super(wasm, args);
  }
  private publish(bytes: Uint8Array) {
    const id = ++this.serial;
    this.payloads.set(id, bytes);
    return handle(id);
  }
  override command(bytes: Uint8Array): void {
    this.commands.push(bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const opcode = view.getUint16(0, true);
    if (opcode === 0x1003) {
      const count = view.getUint32(16, true);
      if (this.maps === 0 && count === 0) this.omittedWrites = true;
      let cursor = 20;
      for (let i = 0; i < count; i++) {
        cursor = Math.ceil(cursor / 8) * 8;
        if (view.getBigUint64(cursor, true) % 8n !== 0n) this.terminal = -64;
        cursor += 12 + view.getUint32(cursor + 8, true);
      }
      return;
    }
    if (opcode >= 0x1000) return;
    const call = decodeCall(bytes);
    this.decoded.push(call);
    const token = wireNumber(call.fields.token ?? 0);
    if (opcode === 1 || opcode === 2) {
      const id = wireHandle(call.fields.result).id;
      this.reply(opcode === 1 ? "adapter" : "device", token, {
        status: id === 70 ? 3 : 1,
        [opcode === 1 ? "adapter" : "device"]: handle(id),
        message: id === 70 ? "controlled excessive limit failure" : "",
      });
      return;
    }
    if (opcode === 20) {
      const type = [1, 2, 1, 1, 2, 2, 1, 2][this.pops++];
      if (!type) throw new Error("Unexpected C scope pop");
      this.reply("error-scope", token, {
        status: 1,
        type,
        message: type === 2 ? "controlled native scope reply" : "",
      });
      return;
    }
    if ((opcode >= 107 && opcode <= 114) || opcode >= 119) return this.queryReply(opcode, token);
    if (opcode === 115) return this.mapReply(token);
    if (opcode === 117) return this.compilationReply(token);
    if (opcode === 118) {
      this.reply("queue-work-result", token, { status: 1, message: "" });
      return;
    }
    if (opcode === 18)
      this.reply("device-lost", 0, {
        device: handle(3),
        reason: this.asyncFault === "loss-reason" ? 1 : 2,
        message: "controlled destroy message",
      });
  }
  private queryReply(opcode: number, token: number): void {
    let value: Record<string, unknown>;
    if (opcode === 107 || opcode === 114)
      value = {
        returned: 1,
        [opcode === 107 ? "info" : "adapter_info"]: {
          next_in_chain: this.asyncFault === "output-chain" ? [1] : [],
          vendor: "controlled",
          architecture: "protocol-only",
          device: "fixture",
          description: "not native acceptance",
          backend_type: 2,
          adapter_type: 4,
          vendor_ID: 0,
          device_ID: 0,
          subgroup_min_size: 0,
          subgroup_max_size: 0,
        },
      };
    else if (opcode === 110 || opcode === 113) {
      const limits = Object.fromEntries(
        gpuStream.structs.limits.fields.map((field) => [
          field.name,
          field.name === "next_in_chain" ? [] : field.type === "uint64" ? 65536n : 1024,
        ]),
      );
      value = { returned: 1, limits };
    } else if (opcode === 109 || opcode === 112 || opcode === 120) value = { returned: true };
    else value = { features: { features: [1] } };
    // A bad chain is injected as bytes so the encoder cannot reject it before C sees it.
    if (this.asyncFault === "output-chain" && (opcode === 107 || opcode === 114)) {
      const output = opcode === 107 ? value.info : value.adapter_info;
      if (typeof output === "object" && output !== null) Reflect.set(output, "next_in_chain", []);
    }
    let bytes = encodeGpuStruct(gpuStream, `query_${opcode}`, value);
    if (this.asyncFault === "output-chain" && opcode === 107)
      new DataView(bytes.buffer).setUint32(4, 1, true);
    if (this.asyncFault === "query-truncated") bytes = bytes.subarray(0, bytes.length - 1);
    if (this.asyncFault === "void-scalar" && opcode === 108)
      bytes = Buffer.concat([new Uint8Array(4), bytes]);
    this.reply("query-result", token, {
      opcode: this.asyncFault === "query-opcode" ? opcode + 1 : opcode,
      payload: this.publish(bytes),
      length: bytes.length,
    });
  }
  private mapReply(token: number): void {
    const previous = writeMap(),
      partial = writeMap();
    partial.fill(71, 24, 32);
    const initial = this.omittedWrites ? new Uint8Array(64) : creation();
    const bytes = [
      initial,
      new Uint8Array(64),
      previous,
      partial.slice(8, 32),
      new Uint8Array(0),
      creation(),
      partial,
    ][this.maps++];
    if (!bytes) throw new Error("Unexpected C map");
    this.reply("map-result", token, {
      status: this.asyncFault === "map-status" ? 3 : 1,
      message: "",
      payload: this.publish(bytes),
      length: this.asyncFault === "map-length" ? bytes.length + 1 : bytes.length,
    });
  }
  private compilationReply(token: number): void {
    const bytes = encodeGpuStruct(gpuStream, "compilation_info", {
      next_in_chain: [],
      messages: [
        {
          next_in_chain: [],
          message: "controlled syntax error",
          type: 1,
          line_num: 1n,
          line_pos: this.asyncFault === "compilation-location" ? 63n : 66n,
          offset: 65n,
          length: 1n,
        },
        {
          next_in_chain: [],
          message: "controlled no-location note",
          type: 3,
          line_num: 0n,
          line_pos: 0n,
          offset: 0n,
          length: 0n,
        },
      ],
    });
    if (this.asyncFault === "compilation-chain") new DataView(bytes.buffer).setUint32(8, 1, true);
    this.reply("compilation-result", token, {
      status: 1,
      message: "",
      payload: this.publish(bytes),
      length: bytes.length,
    });
  }
  override append(ptr: number, length: number): number {
    try {
      return super.append(ptr, length);
    } catch (error) {
      this.protocolErrors.push(String(error));
      this.terminal = -64;
      return 0;
    }
  }
  override completions(ptr: number, capacity: number, timeout: bigint, written: number): number {
    this.timeouts.push(timeout);
    if (this.timeouts.length > 128) throw new Error("C fixture failed to make progress");
    if (!this.replies.length && this.terminal) return this.terminal;
    const bytes = Buffer.concat(this.replies.splice(0));
    if (bytes.length > capacity) throw new Error("Short C completion buffer");
    if (bytes.length && this.asyncFault === "token") bytes.writeUInt32LE(99, 8);
    this.put(ptr, bytes);
    this.word(written, bytes.length);
    return 0;
  }
  private payload(handlePtr: number, ptr: number, capacity: number): number {
    const status = this.copyPayload(handlePtr >>> 0, ptr >>> 0, capacity >>> 0);
    this.payloadCalls.push({ capacity: capacity >>> 0, status });
    return status;
  }
  private copyPayload(handlePtr: number, ptr: number, capacity: number): number {
    const size = this.memory.buffer.byteLength;
    if (handlePtr > size || size - handlePtr < 8 || ptr > size || capacity > size - ptr) return -28;
    const id = this.view.getUint32(handlePtr, true),
      generation = this.view.getUint32(handlePtr + 4, true);
    const bytes = this.payloads.get(id);
    if (
      !bytes ||
      generation !== 1 ||
      (this.consumed.has(id) && this.asyncFault !== "payload-reusable")
    )
      return -8;
    if (capacity < bytes.length) {
      if (this.asyncFault === "short-consumes") this.consumed.add(id);
      return -42;
    }
    this.put(ptr, bytes);
    this.consumed.add(id);
    return 0;
  }
  override imports(): WebAssembly.Imports {
    const imports = super.imports();
    imports.runtime_gpu = {
      ...imports.runtime_gpu,
      payload: (_connection: number, handle: number, ptr: number, capacity: number) =>
        this.payload(handle, ptr, capacity),
    };
    return imports;
  }
}
