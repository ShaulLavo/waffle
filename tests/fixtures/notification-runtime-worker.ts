import { bootstrap, type RuntimeWorkerRequest } from "../../browser/worker.js";
import { NetHost } from "../../browser/net/host.js";
import { createRing } from "../../browser/net/ring.js";

export interface NotificationRuntimeRequest extends RuntimeWorkerRequest {
  mode: "park" | "arm" | "reject" | "relay";
  marker: Int32Array;
}

globalThis.onmessage = ({ data }: MessageEvent<NotificationRuntimeRequest>) => {
  void bootstrap(data, {
    namespaces() {
      const entered = () => {
        Atomics.add(data.marker, 0, 1);
        return 0;
      };
      return {
        identity_fixture: {
          uid: entered,
          euid: entered,
          parent_pid: entered,
          hostname_byte: entered,
        },
      };
    },
    async instantiated(context) {
      if (!context.notifications) throw new Error("notification connection missing");
      const network = data.mode === "reject" ? new NetHost(createRing(), () => {}) : undefined;
      network?.dispose();
      globalThis.postMessage({ type: "notification-arming" });
      const wait = await context.notifications.arm({ network }).catch((error: unknown) => {
        if (String(error).includes("relay arm rejected")) Atomics.store(data.marker, 3, 1);
        throw error;
      });
      globalThis.postMessage({ type: "notification-parked", state: data.notifications!.state });
      context.signal.addEventListener("abort", () => Atomics.add(data.marker, 2, 1), {
        once: true,
      });
      if (data.mode !== "park") return;
      while (wait.wait(wait.sample(), Infinity) !== "closed") {
        /* advisory source wakes */
      }
      globalThis.postMessage({ type: "notification-fenced" });
      // Force physical owner cleanup; no guest finally or callback may release the helper.
      Atomics.wait(data.marker, 3, 0);
    },
    beforeFinish() {
      Atomics.add(data.marker, 1, 1);
    },
    run() {
      Atomics.add(data.marker, 0, 1);
      return 0;
    },
  }).then(() => globalThis.postMessage({ type: "notification-bootstrap-settled" }));
};
