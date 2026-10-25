import type { NotificationConnection } from "../../browser/notification-relay.js";

globalThis.onmessage = ({ data }: MessageEvent<NotificationConnection>) => {
  data.port.onmessage = () =>
    data.port.postMessage({ type: "error", message: "relay arm rejected" });
  data.port.start();
};
