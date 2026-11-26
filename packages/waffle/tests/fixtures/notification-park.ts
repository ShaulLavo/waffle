import type { NotificationRelayRequest } from "../../browser/notification-relay.js";

/** Bytes of a bridge connection's state: sequence, fence and the active park id. */
export const NOTIFICATION_STATE_BYTES = 12;

/** Parks the way a guest's wait set does: a fresh id, stored in state[2] before it is sent.
 * `retire` clears it, as the guest does when its blocking call returns. */
export function notificationParker(
  state: Int32Array,
  send: (request: NotificationRelayRequest) => void,
  values: () => number[],
) {
  let next = 0;
  return {
    park(): number {
      const id = ++next;
      Atomics.store(state, 2, id);
      send({ type: "park", id, values: values() });
      return id;
    },
    retire(): void {
      Atomics.store(state, 2, 0);
    },
  };
}
