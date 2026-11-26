import type { NotificationConnection } from "../../browser/notification-relay.js";

globalThis.onmessage = ({ data }: MessageEvent<NotificationConnection>) => {
  // Bridges drop connections with a separate control message; this relay ignores them.
  if (!("port" in data)) return;
  data.port.onmessage = () =>
    data.port.postMessage({ type: "error", message: "relay arm rejected" });
  data.port.start();
};
