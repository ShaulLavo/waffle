import { serviceAccess } from "./service-access.js";
import { expect } from "bun:test";
import { gpuStream } from "../../../browser/gpu/generated/tables.ts";
import { encodeGpuCommand } from "../../../tooling/gpu-stream-layout.ts";
import { RecordRing } from "../../../browser/gpu/ring.ts";
import { GpuConnection } from "../../../browser/gpu/scheduler.ts";
import { ServiceCredit } from "../../../browser/gpu/protocol.ts";
import { LogicalAppend } from "../../../browser/gpu/transport.ts";
import type { ReplayTarget } from "../../../browser/gpu/replay.ts";

export function handle(id: number, generation = 1) {
  return { id, generation };
}
export const ROOT = handle(1);
export function command(name: string, value: unknown): Uint8Array {
  return encodeGpuCommand(gpuStream, name, value);
}
export function ring(capacity: number, header: 8 | 16 = 8): RecordRing {
  return new RecordRing(new SharedArrayBuffer(64 + capacity), header);
}
export function joinRecords(...records: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(records.reduce((sum, record) => sum + record.byteLength, 0));
  let at = 0;
  for (const record of records) {
    output.set(record, at);
    at += record.byteLength;
  }
  return output;
}
export function words(opcode: number, values: readonly number[], flags = 0): Uint8Array {
  const bytes = new Uint8Array(Math.ceil((8 + values.length * 4) / 8) * 8);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, opcode, true);
  view.setUint16(2, flags, true);
  view.setUint32(4, bytes.byteLength, true);
  values.forEach((value, index) => view.setUint32(8 + index * 4, value, true));
  return bytes;
}
export function encodeBlob(encoder: number, commands: Uint8Array): Uint8Array {
  const output = new Uint8Array(Math.ceil((20 + commands.byteLength) / 8) * 8);
  output.set(words(0x1001, [encoder, 1, commands.byteLength]));
  new DataView(output.buffer).setUint32(4, output.byteLength, true);
  output.set(commands, 20);
  return output;
}
export function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Uninitialized deferred");
  };
  let reject: (reason: unknown) => void = () => {
    throw new Error("Uninitialized deferred");
  };
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
export function rig(target: ReplayTarget, capacity = 256, replyCapacity = 4096) {
  const commands = ring(capacity);
  const replies = ring(replyCapacity, 16);
  const credit = new ServiceCredit();
  const connection = new GpuConnection(commands, replies, target, credit, {
    access: serviceAccess(),
  });
  return { commands, replies, credit, connection };
}
export function send(connection: GpuConnection, bytes: Uint8Array): void {
  const publication = new LogicalAppend(connection.commands, bytes);
  try {
    for (let turns = 0; turns < 100000; turns++) {
      const result = publication.advance();
      const slice = connection.slice();
      if (result === "terminal" || (result === "done" && slice.kind !== "yield")) return;
    }
    throw new Error("Transport failed to make progress");
  } finally {
    if (connection.state.kind === "terminal") publication.cancel();
  }
}
export function drain(replies: RecordRing): Uint8Array[] {
  const records: Uint8Array[] = [];
  const scratch = new Uint8Array(replies.capacity);
  for (;;) {
    const result = replies.readInto(scratch);
    if (result.kind === "empty" || result.kind === "terminal") return records;
    expect(result.kind).toBe("record");
    if (result.kind === "record") records.push(scratch.slice(0, result.bytes));
  }
}
export class RecordingTarget {
  readonly calls: { receiver: string; member: string; args: readonly unknown[] }[] = [];
  readonly root: object;
  readonly adapter: object;
  readonly device: object;
  readonly queue: object;
  readonly encoder: object;
  readonly pass: object;
  readonly texture: object;
  readonly pipeline = { tag: "pipeline" };
  readonly shader = { tag: "shader" };
  readonly buffer = { tag: "command-buffer" };
  readonly view = { tag: "texture-view" };
  readonly loss = deferred<unknown>();
  readonly listeners = new Set<unknown>();
  constructor() {
    this.pass = this.#object("pass", { setPipeline: () => {}, draw: () => {}, end: () => {} });
    this.encoder = this.#object("encoder", {
      beginRenderPass: () => this.pass,
      finish: () => this.buffer,
    });
    this.queue = this.#object("queue", { submit: () => {} });
    this.texture = this.#object("texture", { createView: () => this.view, destroy: () => {} });
    this.device = Object.assign(
      this.#object("device", {
        createShaderModule: () => this.shader,
        createRenderPipeline: () => this.pipeline,
        createCommandEncoder: () => this.encoder,
        destroy: () => {},
        pushErrorScope: () => {},
        popErrorScope: () => Promise.resolve(null),
        addEventListener: (_name, listener) => {
          if (typeof listener === "function") this.listeners.add(listener);
        },
        removeEventListener: (_name, listener) => {
          if (typeof listener === "function") this.listeners.delete(listener);
        },
      }),
      { queue: this.queue, lost: this.loss.promise },
    );
    this.adapter = this.#object("adapter", { requestDevice: () => Promise.resolve(this.device) });
    this.root = this.#object("gpu", { requestAdapter: () => Promise.resolve(this.adapter) });
  }
  #object(receiver: string, methods: Record<string, (...args: unknown[]) => unknown>): object {
    const object: Record<string, unknown> = {};
    for (const [member, action] of Object.entries(methods)) {
      object[member] = (...args: unknown[]) => {
        this.calls.push({ receiver, member, args });
        return action(...args);
      };
    }
    return object;
  }
}
export async function openDevice(connection: GpuConnection): Promise<void> {
  send(
    connection,
    command("instance.request_adapter", {
      result: handle(2),
      token: 1,
      receiver: ROOT,
      options: null,
    }),
  );
  await settle();
  send(
    connection,
    command("adapter.request_device", {
      result: handle(3),
      token: 2,
      receiver: handle(2),
      descriptor: null,
    }),
  );
  await settle();
}

export function workerRequest(worker: Worker, message: unknown): Promise<unknown> {
  const reply = deferred<unknown>();
  const receive = (event: MessageEvent<unknown>) => reply.resolve(event.data);
  const fail = (event: ErrorEvent) => reply.reject(new Error(event.message));
  const timer = setTimeout(() => reply.reject(new Error("GPU core worker did not respond")), 3000);
  const cleanup = () => {
    clearTimeout(timer);
    worker.removeEventListener("message", receive);
    worker.removeEventListener("error", fail);
  };
  worker.addEventListener("message", receive);
  worker.addEventListener("error", fail);
  try {
    worker.postMessage(message);
  } catch (error) {
    reply.reject(error);
  }
  return reply.promise.finally(cleanup);
}
