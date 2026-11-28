// A guest whose park send is held until the page disposes the bridge, so disposal lands
// between the wait's first checks and its post-park recheck. The patch is installed before
// the scope module loads, because that module captures MessagePort.prototype.postMessage.
import type { FilesystemClient } from "../../fs/client.js";
import type { NotificationConnection } from "../../browser/notification-relay.js";

interface RevokeWindowRequest {
  readonly filesystem: ConstructorParameters<typeof FilesystemClient>[0];
  readonly notifications: NotificationConnection;
}

const original = MessagePort.prototype.postMessage;
let held: Int32Array | undefined;
MessagePort.prototype.postMessage = function (this: MessagePort, ...args: never[]) {
  Reflect.apply(original, this, args);
  const message = args[0] as { type?: unknown } | undefined;
  if (!held || message?.type !== "park") return;
  const sequence = Atomics.load(held, 0);
  // Acknowledge the observed sequence before the page can dispose the bridge.
  globalThis.postMessage({ parked: true });
  Atomics.wait(held, 0, sequence, 5000);
};

globalThis.onmessage = async ({ data }: MessageEvent<RevokeWindowRequest>) => {
  const { NotificationWaitScope } = await import("../../browser/notification-wait.js");
  const { FilesystemClient } = await import("../../fs/client.js");
  const fs = new FilesystemClient(data.filesystem);
  const scope = new NotificationWaitScope(data.notifications, fs);
  const set = await scope.arm();
  held = data.notifications.state;
  const observed = set.sample();
  globalThis.postMessage({ result: set.wait(observed, Infinity) });
};
