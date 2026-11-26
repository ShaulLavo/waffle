import {
  createNotificationWaiters,
  notificationBlockingWait,
  type NotificationBlockingRequest,
} from "./notification-blocking-wait.js";
import type {
  NotificationConnection,
  NotificationRelayReply,
  NotificationRelayRequest,
  NotificationWord,
} from "./notification-relay.js";

/** A guest sends at most filesystem, network and process words. */
const MAX_WORDS = 3;

/**
 * One guest's relay state. The relay waits on source words only while the guest is parked:
 * a park names the word values the guest last observed, the first difference (or wake on a
 * word) publishes once, and the relay stops until the guest parks again. Source traffic while
 * the guest runs costs the relay nothing.
 */
class RelayConnection {
  private words: readonly NotificationWord[] | undefined;
  private parked: readonly number[] | undefined;
  /** The value each outstanding blocking wait was registered with, by word slot. */
  private readonly outstanding: (number | undefined)[] = [];
  /** Pending waits stay reachable from the realm; iOS Safari 26.5 lost unreferenced waits. */
  readonly pendingWaits: (Promise<string> | undefined)[] = [];
  private readonly waiters = createNotificationWaiters(import.meta.url);
  private closed = false;

  constructor(
    private readonly port: MessagePort,
    private readonly state: Int32Array,
  ) {
    port.onmessage = ({ data }: MessageEvent<NotificationRelayRequest>) => this.receive(data);
    port.start();
  }

  private receive(data: NotificationRelayRequest): void {
    if (this.closed) return;
    if (data.type === "dispose") return this.dispose();
    if (Atomics.load(this.state, 1)) return;
    if (data.type === "park") return this.park(data.values);
    if (this.words) return;
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

  private park(values: readonly number[]): void {
    const words = this.words;
    if (!words || !validValues(values, words.length)) return;
    this.parked = values;
    for (let slot = 0; slot < words.length; slot++)
      if (Atomics.load(words[slot]!.cells, words[slot]!.index) !== values[slot])
        return this.publish();
    for (let slot = 0; slot < words.length; slot++) this.watch(slot);
  }

  /** Registers one blocking wait for the parked value unless one is outstanding. A stale
   * outstanding wait returns soon, because its word already differs, and `settle` rechecks. */
  private watch(slot: number): void {
    const parked = this.parked;
    if (!parked || this.outstanding[slot] !== undefined) return;
    const word = this.words![slot]!;
    const seen = parked[slot]!;
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
    if (seen === parked[slot] || Atomics.load(word.cells, word.index) !== parked[slot])
      return this.publish();
    this.watch(slot);
  }

  private publish(): void {
    this.parked = undefined;
    if (Atomics.load(this.state, 1)) return;
    Atomics.add(this.state, 0, 1);
    Atomics.notify(this.state, 0);
  }

  private reply(value: NotificationRelayReply): void {
    this.port.postMessage(value);
  }

  private fail(error: unknown): void {
    if (this.closed) return;
    this.reply({ type: "error", message: String(error) });
    globalThis.postMessage("failed");
  }

  private dispose(): void {
    this.closed = true;
    this.parked = undefined;
    this.waiters.dispose();
    this.outstanding.length = 0;
    this.pendingWaits.length = 0;
    this.port.close();
    connections.delete(this);
    globalThis.postMessage("disposed");
  }
}

function validValues(values: unknown, length: number): values is readonly number[] {
  if (!Array.isArray(values) || values.length !== length) return false;
  return values.every((value) => typeof value === "number" && (value | 0) === value);
}

// Connections stay reachable until disposed, together with their pending waits.
const connections = new Set<RelayConnection>();

globalThis.onmessage = ({
  data,
}: MessageEvent<NotificationConnection | NotificationBlockingRequest>) => {
  if ("type" in data) notificationBlockingWait(data);
  else connections.add(new RelayConnection(data.port, data.state));
};
