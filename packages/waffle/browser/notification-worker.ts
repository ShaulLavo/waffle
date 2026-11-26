import {
  createNotificationWaiters,
  notificationBlockingWait,
  type NotificationBlockingRequest,
} from "./notification-blocking-wait.js";
import type {
  NotificationRelayControl,
  NotificationRelayNotice,
  NotificationRelayReply,
  NotificationRelayRequest,
  NotificationWord,
} from "./notification-relay.js";

/** A guest sends at most filesystem, network and process words. */
const MAX_WORDS = 3;

interface Park {
  readonly id: number;
  readonly values: readonly number[];
}

/**
 * One guest's relay state. The relay waits on source words only while the guest is parked:
 * a park names the word values the guest last observed, the first difference (or wake on a
 * word) publishes once, and the relay stops until the guest parks again. Source traffic while
 * the guest runs costs the relay nothing.
 *
 * The guest stores the park's id in `state[2]` before its last readiness check and clears it
 * when its blocking call returns. A publication consumes that id with a compare-exchange, so
 * a park the guest retired (a timeout or another wake) never publishes.
 */
class RelayConnection {
  private words: readonly NotificationWord[] | undefined;
  private parked: Park | undefined;
  /** The value each outstanding blocking wait was registered with, by word slot. */
  private readonly outstanding: (number | undefined)[] = [];
  /** Pending waits stay reachable from the realm; iOS Safari 26.5 lost unreferenced waits. */
  readonly pendingWaits: (Promise<string> | undefined)[] = [];
  private readonly waiters = createNotificationWaiters(import.meta.url);
  private closed = false;
  private failed = false;

  constructor(
    private readonly id: number,
    private readonly port: MessagePort,
    private readonly state: Int32Array,
  ) {
    // The relay is shared by every guest on the page: one guest's malformed message fails only
    // its own connection, never the relay Worker.
    port.onmessage = ({ data }: MessageEvent<NotificationRelayRequest>) => {
      try {
        this.receive(data);
      } catch (error) {
        this.fail(error);
      }
    };
    port.start();
  }

  private receive(data: NotificationRelayRequest): void {
    if (this.closed || this.failed) return;
    if (!data || typeof data !== "object") throw new TypeError("malformed notification request");
    if (data.type === "dispose") return this.dispose(true);
    if (Atomics.load(this.state, 1)) return;
    if (data.type === "park") return this.park(data);
    if (data.type !== "arm" || this.words) throw new TypeError("unexpected notification request");
    try {
      this.arm(data.words);
    } catch (error) {
      this.reply({ type: "error", message: String(error) });
    }
  }

  private arm(words: readonly NotificationWord[]): void {
    if (words.length > MAX_WORDS) throw new RangeError("too many notification words");
    for (const word of words) Atomics.load(word.cells, word.index);
    this.words = words;
    this.reply({ type: "armed" });
  }

  private park({ id, values }: { readonly id: unknown; readonly values: unknown }): void {
    const words = this.words;
    if (!words) throw new TypeError("notification park before arm");
    if (typeof id !== "number" || (id | 0) !== id || id <= 0 || !validValues(values, words.length))
      throw new TypeError("malformed notification park");
    this.parked = { id, values };
    if (this.moved(this.parked)) return this.publish();
    for (let slot = 0; slot < words.length; slot++) this.watch(slot);
  }

  private moved(parked: Park): boolean {
    const words = this.words!;
    for (let slot = 0; slot < words.length; slot++)
      if (Atomics.load(words[slot]!.cells, words[slot]!.index) !== parked.values[slot]) return true;
    return false;
  }

  /** Registers one blocking wait for the parked value unless one is outstanding. A stale
   * outstanding wait returns soon, because its word already differs, and `settle` rechecks. */
  private watch(slot: number): void {
    const parked = this.parked;
    if (!parked || this.outstanding[slot] !== undefined) return;
    const word = this.words![slot]!;
    const seen = parked.values[slot]!;
    const waiting = this.waiters.wait(word.cells, word.index, seen);
    if (!waiting.async) return this.publish();
    this.outstanding[slot] = seen;
    this.pendingWaits[slot] = waiting.value;
    waiting.value.then(
      () => this.settle(slot, seen),
      (error: unknown) => this.fail(error),
    );
  }

  private settle(slot: number, seen: number): void {
    // Disposal cleared these roots; a late reply must not recreate the slots.
    if (this.closed) return;
    this.outstanding[slot] = undefined;
    this.pendingWaits[slot] = undefined;
    const parked = this.parked;
    if (!parked) return;
    const word = this.words![slot]!;
    // A wake on the parked value publishes even without a change, as a notify asks.
    if (
      seen === parked.values[slot] ||
      Atomics.load(word.cells, word.index) !== parked.values[slot]
    )
      return this.publish();
    this.watch(slot);
  }

  private publish(): void {
    const parked = this.parked!;
    this.parked = undefined;
    if (Atomics.load(this.state, 1)) return;
    // Every wait attempt has a fresh id that the guest never reactivates. A failed claim means
    // this id is dead: the guest retired it and is running, or a newer park's message carries
    // the current one. Either way that guest is not asleep on this park.
    if (Atomics.compareExchange(this.state, 2, parked.id, 0) !== parked.id) return;
    Atomics.add(this.state, 0, 1);
    Atomics.notify(this.state, 0);
  }

  private reply(value: NotificationRelayReply): void {
    this.port.postMessage(value);
  }

  /** Reports the failure to the guest and the page; the page fences and drops the connection. */
  private fail(error: unknown): void {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.parked = undefined;
    this.reply({ type: "error", message: String(error) });
    notice(this.id, "failed");
  }

  /** Stops waiting and publishing for this guest. Disposal by the guest also tells the page. */
  dispose(fromGuest = true): void {
    if (this.closed) return;
    this.closed = true;
    this.parked = undefined;
    this.waiters.dispose();
    this.outstanding.length = 0;
    this.pendingWaits.length = 0;
    this.port.close();
    connections.delete(this.id);
    if (fromGuest) notice(this.id, "disposed");
  }
}

/** Checks every expected index; `every()` would skip the holes of a sparse array. */
function validValues(values: unknown, length: number): values is readonly number[] {
  if (!Array.isArray(values) || values.length !== length) return false;
  for (let index = 0; index < length; index++) {
    const value: unknown = values[index];
    if (typeof value !== "number" || (value | 0) !== value) return false;
  }
  return true;
}

function notice(id: number, type: NotificationRelayNotice["type"]): void {
  globalThis.postMessage({ id, type } satisfies NotificationRelayNotice);
}

// One relay serves every guest bridge on the page. Connections stay reachable until disposed,
// together with their pending waits.
const connections = new Map<number, RelayConnection>();

globalThis.onmessage = ({
  data,
}: MessageEvent<NotificationRelayControl | NotificationBlockingRequest>) => {
  if ("type" in data) return notificationBlockingWait(data);
  if ("drop" in data) {
    connections.get(data.drop)?.dispose(false);
    return notice(data.drop, "dropped");
  }
  connections.set(data.id, new RelayConnection(data.id, data.port, data.state));
};
