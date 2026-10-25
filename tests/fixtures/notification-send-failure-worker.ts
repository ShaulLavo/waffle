import type { NotificationConnection } from "../../browser/notification-relay.js";
import type { FilesystemConnection } from "../../fs/protocol.js";
import { FilesystemClient } from "../../fs/client.js";

const post = MessagePort.prototype.postMessage;
const close = MessagePort.prototype.close;
let closes = 0;
MessagePort.prototype.postMessage = function (
  message: unknown,
  transfer: Transferable[] | StructuredSerializeOptions = [],
): void {
  if (message && typeof message === "object" && "type" in message && message.type === "dispose")
    throw new Error("dispose send failed");
  Reflect.apply(post, this, [message, transfer]);
};
MessagePort.prototype.close = function (): void {
  closes++;
  Reflect.apply(close, this, []);
};

globalThis.onmessage = ({
  data,
}: MessageEvent<{ filesystem: FilesystemConnection; notifications: NotificationConnection }>) => {
  void run(data).catch((error) =>
    globalThis.postMessage({ type: "send-failure", error: String(error) }),
  );
};

async function run(data: {
  filesystem: FilesystemConnection;
  notifications: NotificationConnection;
}): Promise<void> {
  const { NotificationWaitScope } = await import("../../browser/notification-wait.js");
  const fs = new FilesystemClient(data.filesystem);
  const scope = new NotificationWaitScope(data.notifications, fs);
  const arm = scope.arm().then(
    () => "armed",
    (error: unknown) => String(error),
  );
  try {
    let error: unknown;
    try {
      scope.dispose();
    } catch (failure) {
      error = failure;
    }
    await scope.closed;
    const rejection = await arm;
    globalThis.postMessage({
      type: "send-failure",
      failure: String(error),
      closes,
      rejection,
      fenced: Atomics.load(data.notifications.state, 1),
      sequence: Atomics.load(data.notifications.state, 0),
    });
  } finally {
    fs.dispose();
  }
}
