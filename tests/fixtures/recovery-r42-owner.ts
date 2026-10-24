import "./persistent-lifecycle-r2-owner";
import { record, text } from "../../fs/publication-attachment";

const originalMessage = self.onmessage;
const originalPost = BroadcastChannel.prototype.postMessage;
let armed = false;
let held: { message: unknown; send: () => void } | undefined;
const replies: unknown[] = [];

BroadcastChannel.prototype.postMessage = function (value: unknown) {
  const data = record(value);
  const result = data.value;
  if (data.kind !== "reply" || !result || typeof result !== "object")
    return Reflect.apply(originalPost, this, [value]);
  const settlement = record(result);
  if (settlement.kind !== "committed" || !(settlement.bytes instanceof Uint8Array))
    return Reflect.apply(originalPost, this, [value]);
  replies.push(structuredClone(value));
  if (!armed) return Reflect.apply(originalPost, this, [value]);
  armed = false;
  held = {
    message: structuredClone(value),
    send: () => Reflect.apply(originalPost, this, [value]),
  };
};

function execute(operation: string): unknown {
  if (operation === "r42-arm") {
    if (armed || held) throw new Error("settlement reply already owned");
    armed = true;
    return null;
  }
  if (operation === "r42-probe") return { held: held?.message ?? null, replies: replies.slice() };
  if (operation !== "r42-release" || !held) throw new Error("held settlement reply absent");
  held.send();
  held = undefined;
  return { released: true };
}

self.onmessage = function (event: MessageEvent<unknown>) {
  const data = record(event.data),
    operation = text(data.operation);
  if (!operation.startsWith("r42-")) return originalMessage?.call(self, event);
  try {
    self.postMessage({ id: text(data.id), value: execute(operation) });
  } catch (error) {
    self.postMessage({ id: text(data.id), failure: String(error) });
  }
};
