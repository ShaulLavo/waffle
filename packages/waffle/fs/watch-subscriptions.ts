import { FilesystemError } from "../core/filesystem.js";
import { RootWatchAccount } from "./watch-account.js";
import { WatchArena, type WatchGrowth } from "./watch-arena.js";
import { WatchIdIndex, watchId, setWatchId } from "./watch-id-index.js";
import { WatchIndex } from "./watch-index.js";
import { WatchNames, type WatchNameReservation } from "./watch-names.js";
import { WATCH_CAPACITY } from "./watch-ring.js";
import type { WatchBatch, WatchEvent } from "./watch.js";

const WIDTH = 48;
const EVENT = 32;
const HEAD = 20;
const TAIL = 24;
const COUNT = 28;
const OVERFLOW = 2;
const NULL_NAME = 0xffffffff;
export interface HeldWatchBatch {
  readonly batch: WatchBatch;
  release(): void;
  rollback(): void;
}

export class WatchSubscriptions {
  private readonly records: WatchArena;
  private readonly ids: WatchIdIndex;
  private readonly owners: WatchIdIndex;
  private readonly events: WatchArena;
  private readonly names: WatchNames;
  private tail = 0;
  private free = 0;
  private eventTail = 0;
  private freeEvent = 0;
  private serial = 0;
  private count = 0;
  private queued = 0;
  constructor(
    private readonly account: RootWatchAccount,
    private readonly index: WatchIndex,
  ) {
    this.records = new WatchArena(account);
    this.ids = new WatchIdIndex(account);
    this.owners = new WatchIdIndex(account);
    this.events = new WatchArena(account, "events");
    this.names = new WatchNames(account, 12288, "events");
  }
  get size(): number {
    return this.count;
  }
  resources() {
    return {
      subscriptions: this.count,
      queuedEvents: this.queued,
      subscriptionCapacityBytes: this.records.capacity,
      subscriptionBuckets: this.ids.resources().buckets,
      ownerBuckets: this.owners.resources().buckets,
      eventCapacityBytes: this.events.capacity,
      ...this.names.resources(),
    };
  }
  private slot(id: number): number {
    return typeof id === "number" && Number.isSafeInteger(id) && id > 0
      ? this.ids.get(BigInt(id))
      : 0;
  }
  private at(owner: number, id: number): number {
    const slot = this.slot(id);
    if (!slot || this.records.view.getUint32((slot - 1) * WIDTH + 8, true) !== owner)
      throw new FilesystemError(8);
    return (slot - 1) * WIDTH;
  }
  open(owner: number, root: bigint, recursive: boolean): number {
    if (this.serial === Number.MAX_SAFE_INTEGER)
      throw new FilesystemError(6, "watch identifiers exhausted");
    const slot = this.free || this.tail + 1;
    const record = this.records.stage(slot * WIDTH);
    let lookup: WatchGrowth | undefined;
    let owners: WatchGrowth | undefined;
    try {
      lookup = this.ids.stage();
      if (!this.owners.get(BigInt(owner))) owners = this.owners.stage();
      this.index.pin(root);
      record.commit();
      lookup.commit();
      owners?.commit();
    } catch (error) {
      record.cancel();
      lookup?.cancel();
      owners?.cancel();
      throw error;
    }
    const at = (slot - 1) * WIDTH;
    const view = this.records.view;
    if (this.free) this.free = view.getUint32(at + 8, true);
    else this.tail++;
    this.records.bytes.fill(0, at, at + WIDTH);
    const id = ++this.serial;
    view.setFloat64(at, id, true);
    view.setUint32(at + 8, owner, true);
    view.setUint32(at + 12, this.index.slot(root), true);
    view.setUint32(at + 16, Number(recursive), true);
    this.attach(slot, root, owner);
    this.ids.add(BigInt(id), slot);
    this.count++;
    return id;
  }
  private attach(slot: number, root: bigint, owner: number): void {
    const at = (slot - 1) * WIDTH;
    const ownerHead = this.owners.get(BigInt(owner));
    const rootHead = this.index.watchHead(root);
    this.records.view.setUint32(at + 32, ownerHead, true);
    this.records.view.setUint32(at + 40, rootHead, true);
    if (ownerHead) {
      this.records.view.setUint32((ownerHead - 1) * WIDTH + 36, slot, true);
      this.owners.set(BigInt(owner), slot);
    } else this.owners.add(BigInt(owner), slot);
    if (rootHead) this.records.view.setUint32((rootHead - 1) * WIDTH + 44, slot, true);
    this.index.setWatchHead(root, slot);
  }
  root(owner: number, id: number): bigint {
    const at = this.at(owner, id);
    return this.index.id(this.records.view.getUint32(at + 12, true));
  }
  recursive(owner: number, id: number): boolean {
    const at = this.at(owner, id);
    return !!(this.records.view.getUint32(at + 16, true) & 1);
  }
  forRoot(root: bigint, visit: (owner: number, id: number) => void): void {
    for (
      let slot = this.index.watchHead(root);
      slot;
      slot = this.records.view.getUint32((slot - 1) * WIDTH + 40, true)
    ) {
      const at = (slot - 1) * WIDTH;
      visit(this.records.view.getUint32(at + 8, true), this.records.view.getFloat64(at, true));
    }
  }
  forEach(visit: (owner: number, id: number) => void): void {
    for (let slot = 1; slot <= this.tail; slot++) {
      const at = (slot - 1) * WIDTH;
      const id = this.records.view.getFloat64(at, true);
      if (id) visit(this.records.view.getUint32(at + 8, true), id);
    }
  }
  overflowed(owner: number, id: number): boolean {
    const at = this.at(owner, id);
    return !!(this.records.view.getUint32(at + 16, true) & OVERFLOW);
  }
  enqueue(owner: number, id: number, event: WatchEvent): void {
    const at = this.at(owner, id);
    if (this.records.view.getUint32(at + 16, true) & OVERFLOW) return;
    if (this.contains(at, event)) return;
    if (this.records.view.getUint32(at + COUNT, true) >= WATCH_CAPACITY)
      return this.overflow(owner, id);
    try {
      this.append(at, event);
    } catch (error) {
      if (!(error instanceof FilesystemError) || (error.errno !== 6 && error.errno !== 48))
        throw error;
      this.overflow(owner, id);
    }
  }
  private contains(at: number, event: WatchEvent): boolean {
    const type = event.type === "change" ? 1 : 2;
    const low = event.id & ((1n << 64n) - 1n);
    const high = event.id >> 64n;
    for (
      let slot = this.records.view.getUint32(at + HEAD, true);
      slot;
      slot = this.events.view.getUint32((slot - 1) * EVENT + 24, true)
    ) {
      const at = (slot - 1) * EVENT;
      const view = this.events.view;
      if (
        view.getUint32(at + 16, true) !== type ||
        view.getBigUint64(at, true) !== low ||
        view.getBigUint64(at + 8, true) !== high
      )
        continue;
      const length = view.getUint32(at + 20, true);
      if (
        length === NULL_NAME
          ? event.name === null
          : this.names.read(view.getUint32(at + 28, true), length) === event.name
      )
        return true;
    }
    return false;
  }

  private append(at: number, event: WatchEvent): void {
    const slot = this.freeEvent || this.eventTail + 1;
    const growth = this.events.stage(slot * EVENT);
    let name: WatchNameReservation | undefined;
    try {
      if (event.name !== null) name = this.names.stage(event.name);
      growth.commit();
      const offset = name?.commit() ?? 0;
      this.insertEvent(at, slot, event, offset, name?.length ?? NULL_NAME);
    } catch (error) {
      growth.cancel();
      name?.cancel();
      throw error;
    }
  }
  private insertEvent(
    watch: number,
    slot: number,
    event: WatchEvent,
    name: number,
    length: number,
  ): void {
    const at = (slot - 1) * EVENT;
    const view = this.events.view;
    if (this.freeEvent) this.freeEvent = view.getUint32(at + 24, true);
    else this.eventTail++;
    setWatchId(view, at, event.id);
    view.setUint32(at + 16, event.type === "change" ? 1 : 2, true);
    view.setUint32(at + 20, length, true);
    view.setUint32(at + 24, 0, true);
    view.setUint32(at + 28, name, true);
    const previous = this.records.view.getUint32(watch + TAIL, true);
    if (previous) view.setUint32((previous - 1) * EVENT + 24, slot, true);
    else this.records.view.setUint32(watch + HEAD, slot, true);
    this.records.view.setUint32(watch + TAIL, slot, true);
    this.records.view.setUint32(
      watch + COUNT,
      this.records.view.getUint32(watch + COUNT, true) + 1,
      true,
    );
    this.queued++;
  }
  private event(slot: number): WatchEvent {
    const at = (slot - 1) * EVENT;
    const view = this.events.view;
    const length = view.getUint32(at + 20, true);
    return {
      type: view.getUint32(at + 16, true) === 1 ? "change" : "rename",
      id: watchId(view, at),
      name: length === NULL_NAME ? null : this.names.read(view.getUint32(at + 28, true), length),
    };
  }
  batch(owner: number, id: number): HeldWatchBatch {
    const at = this.at(owner, id);
    if (this.records.view.getUint32(at + 16, true) & OVERFLOW)
      return { batch: { kind: "overflow", events: [] }, release() {}, rollback() {} };
    const first = this.records.view.getUint32(at + HEAD, true);
    if (!first) return { batch: { kind: "events", events: [] }, release() {}, rollback() {} };
    let units = 128;
    for (let slot = first; slot; slot = this.events.view.getUint32((slot - 1) * EVENT + 24, true)) {
      const length = this.events.view.getUint32((slot - 1) * EVENT + 20, true);
      units += 64 + (length === NULL_NAME ? 0 : length * 2);
    }
    let control: { release(): void };
    try {
      control = this.account.reserveControl(units);
    } catch (error) {
      if (!(error instanceof FilesystemError) || error.errno !== 6) throw error;
      this.overflow(owner, id);
      return { batch: { kind: "overflow", events: [] }, release() {}, rollback() {} };
    }
    const events: WatchEvent[] = [];
    try {
      for (let slot = first; slot; slot = this.events.view.getUint32((slot - 1) * EVENT + 24, true))
        events.push(this.event(slot));
    } catch (error) {
      control.release();
      throw error;
    }
    const last = this.records.view.getUint32(at + TAIL, true);
    const count = this.records.view.getUint32(at + COUNT, true);
    this.records.view.setUint32(at + HEAD, 0, true);
    this.records.view.setUint32(at + TAIL, 0, true);
    this.records.view.setUint32(at + COUNT, 0, true);
    let held = true;
    const settle = (rollback: boolean) => {
      if (!held) return;
      held = false;
      control.release();
      if (rollback && this.restore(owner, id, first, last, count)) return;
      this.releaseEvents(first);
      if (!this.count && !this.queued) this.resetEvents();
    };
    return {
      batch: { kind: "events", events },
      release: () => settle(false),
      rollback: () => settle(true),
    };
  }
  private restore(owner: number, id: number, first: number, last: number, count: number): boolean {
    if (!this.slot(id)) return false;
    const at = this.at(owner, id);
    const current = this.records.view.getUint32(at + COUNT, true);
    if (this.records.view.getUint32(at + 16, true) & OVERFLOW) return false;
    if (current + count > WATCH_CAPACITY) {
      this.overflow(owner, id);
      return false;
    }
    this.events.view.setUint32(
      (last - 1) * EVENT + 24,
      this.records.view.getUint32(at + HEAD, true),
      true,
    );
    this.records.view.setUint32(at + HEAD, first, true);
    if (!current) this.records.view.setUint32(at + TAIL, last, true);
    this.records.view.setUint32(at + COUNT, current + count, true);
    return true;
  }

  private releaseEvents(first: number): void {
    for (let slot = first; slot;) {
      const at = (slot - 1) * EVENT;
      const view = this.events.view;
      const next = view.getUint32(at + 24, true);
      const length = view.getUint32(at + 20, true);
      if (length !== NULL_NAME) this.names.release(view.getUint32(at + 28, true), length);
      view.setUint32(at + 24, this.freeEvent, true);
      this.freeEvent = slot;
      this.queued--;
      slot = next;
    }
  }
  overflow(owner: number, id: number): void {
    const at = this.at(owner, id);
    this.releaseEvents(this.records.view.getUint32(at + HEAD, true));
    this.records.view.setUint32(at + HEAD, 0, true);
    this.records.view.setUint32(at + TAIL, 0, true);
    this.records.view.setUint32(at + COUNT, 0, true);
    this.records.view.setUint32(
      at + 16,
      this.records.view.getUint32(at + 16, true) | OVERFLOW,
      true,
    );
  }
  close(owner: number, id: number): boolean {
    if (!this.slot(id)) return false;
    const at = this.at(owner, id);
    const slot = at / WIDTH + 1;
    const root = this.root(owner, id);
    this.overflow(owner, id);
    this.detach(slot, root, owner);
    this.ids.delete(BigInt(id));
    this.records.bytes.fill(0, at, at + WIDTH);
    this.records.view.setUint32(at + 8, this.free, true);
    this.free = slot;
    this.index.unpin(root);
    this.count--;
    if (!this.count) {
      this.records.close();
      this.ids.close();
      this.owners.close();
      this.tail = this.free = 0;
      if (!this.queued) this.resetEvents();
    }
    return true;
  }
  private detach(slot: number, root: bigint, owner: number): void {
    const at = (slot - 1) * WIDTH;
    const ownerNext = this.records.view.getUint32(at + 32, true);
    const ownerPrevious = this.records.view.getUint32(at + 36, true);
    const rootNext = this.records.view.getUint32(at + 40, true);
    const rootPrevious = this.records.view.getUint32(at + 44, true);
    if (ownerPrevious)
      this.records.view.setUint32((ownerPrevious - 1) * WIDTH + 32, ownerNext, true);
    else if (ownerNext) this.owners.set(BigInt(owner), ownerNext);
    else this.owners.delete(BigInt(owner));
    if (ownerNext) this.records.view.setUint32((ownerNext - 1) * WIDTH + 36, ownerPrevious, true);
    if (rootPrevious) this.records.view.setUint32((rootPrevious - 1) * WIDTH + 40, rootNext, true);
    else this.index.setWatchHead(root, rootNext);
    if (rootNext) this.records.view.setUint32((rootNext - 1) * WIDTH + 44, rootPrevious, true);
  }
  closeOwner(owner: number): number {
    let removed = 0;
    for (;;) {
      const slot = this.owners.get(BigInt(owner));
      if (!slot) return removed;
      this.close(owner, this.records.view.getFloat64((slot - 1) * WIDTH, true));
      removed++;
    }
  }
  private resetEvents(): void {
    this.events.close();
    this.names.close();
    this.eventTail = this.freeEvent = 0;
  }
  dispose(): void {
    if (this.queued) throw new Error("watch batches still retained");
    this.records.close();
    this.ids.close();
    this.owners.close();
    this.events.close();
    this.names.close();
  }
}
