import { control as existingControl } from "../persistent-lifecycle-r2-page";
import { record, residentDescriptor } from "../../fs/publication-attachment";

type AppendStatus =
  | { kind: "idle" | "pending" }
  | { kind: "fulfilled"; value: unknown }
  | { kind: "rejected"; failure: string };
let append: AppendStatus = { kind: "idle" };
let captured: Record<string, unknown> | undefined;
let wire: BroadcastChannel | undefined;
const replies: unknown[] = [];

function startAppend(): null {
  if (append.kind === "pending") throw new Error("append already pending");
  append = { kind: "pending" };
  captured = undefined;
  const original = BroadcastChannel.prototype.postMessage;
  BroadcastChannel.prototype.postMessage = function (value: unknown) {
    const data = record(value);
    if (data.kind === "request" && data.operation === "settle") captured = structuredClone(data);
    Reflect.apply(original, this, [value]);
  };
  void existingControl("acknowledgedTail").then(
    (value) => {
      append = { kind: "fulfilled", value };
      BroadcastChannel.prototype.postMessage = original;
    },
    (error: unknown) => {
      append = { kind: "rejected", failure: String(error) };
      BroadcastChannel.prototype.postMessage = original;
    },
  );
  return null;
}

/** @browserEntry Native replay fixture, with the production page implementation unchanged. */
export async function control(operation: string, body?: unknown): Promise<unknown> {
  if (operation === "r42-append") return startAppend();
  if (operation === "r42-probe") return { append, captured, replies: replies.slice() };
  if (operation === "r42-replay") {
    if (!wire || !captured) throw new Error("actual settlement request absent");
    wire.postMessage(captured);
    return structuredClone(captured);
  }
  if (operation === "r42-acknowledge") {
    if (!wire || !captured || append.kind !== "fulfilled")
      throw new Error("completed settlement request absent");
    const acknowledgement = { kind: "ack", client: captured.client, id: captured.id };
    wire.postMessage(acknowledgement);
    return acknowledgement;
  }
  if (operation === "attach") {
    const descriptor = residentDescriptor(body);
    wire = new BroadcastChannel(`waffle:resident:${descriptor.workspace}`);
    wire.onmessage = ({ data }: MessageEvent<unknown>) => {
      const message = record(data);
      if (message.kind === "reply") replies.push(message);
    };
  }
  if (operation === "stopPeer") {
    const stopped = await existingControl(operation, body);
    wire?.close();
    wire = undefined;
    return stopped;
  }
  return existingControl(operation, body);
}
