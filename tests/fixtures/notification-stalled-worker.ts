import type { NotificationConnection } from "../../browser/notification-relay.js";

globalThis.onmessage = ({ data }: MessageEvent<NotificationConnection>) => {
  data.port.start();
};
