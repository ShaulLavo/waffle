import type { NotificationConnection } from "../../browser/notification-relay.js";

globalThis.onmessage = ({ data }: MessageEvent<NotificationConnection>) => {
  // Bridges drop connections with a separate control message; this relay ignores them.
  if (!("port" in data)) return;
  data.port.start();
};
