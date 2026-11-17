import { allocateSharedControl } from "../memory/control.js";
import type {
  GroupBacking,
  GroupMemorySource,
  Headroom,
  ReservationSizing,
} from "../memory/reservations.js";
import { ProcessErrno, ProcessError } from "../proc/errors.js";
import { RangeAllocator } from "./ranges.js";
import {
  GroupErrno,
  GroupOp,
  MAX_GROUP_PAGES,
  MEMBER_CELL_WORDS,
  PAGE_BYTES,
  REPLY_WORDS,
  WAIT_ADDR,
  WAIT_CLOSED,
  WAIT_EPOCH,
  WAIT_WIDTH,
  WATCH_HEADER_WORDS,
  WATCH_SLOT_WORDS,
  controlBytes,
  type GroupRequestMessage,
  type MemoryGroupMemberRequest,
} from "./protocol.js";

/** Runtime policy for memory groups. Every limit is configurable; see docs/memory-groups.md. */
export interface MemoryGroupPolicy {
  /** W1: admitted members per group, including the leader and pending reservations. */
  readonly members: number;
  /** W2: parallelism reported to every member of a group. */
  readonly parallelism: number;
  /** W3: committed group backing for the whole page, summed across groups. */
  readonly budgetBytes: number;
  /** Address-space maximum of one group, in 64 KiB pages. Not a charge. */
  readonly maximumPages: number;
  /** Cumulative granted member pages per group, including unused worker leases; excludes regions. */
  readonly memberPages: number;
  /** Bounded metadata per group. */
  readonly regions: number;
  readonly pins: number;
  /** Publications per group, not the references they hold. */
  readonly publications: number;
  readonly watches: number;
  /** Bounded number of live groups per page. */
  readonly groups: number;
  /** Private stack carved for each PIE member image, in bytes. */
  readonly stackBytes: number;
}
export type MemoryGroupPolicyOptions = Partial<MemoryGroupPolicy>;

const defaultMemoryGroupPolicy: Omit<MemoryGroupPolicy, "memberPages"> = Object.freeze({
  members: 16,
  parallelism: 1,
  budgetBytes: 2 * 1024 ** 3,
  maximumPages: MAX_GROUP_PAGES,
  regions: 4096,
  pins: 4096,
  publications: 4096,
  watches: 1024,
  groups: 64,
  stackBytes: 1024 * 1024,
});

function memoryGroupPolicy(options: MemoryGroupPolicyOptions = {}): MemoryGroupPolicy {
  const configured = { ...defaultMemoryGroupPolicy, ...options };
  const policy = {
    ...configured,
    memberPages: options.memberPages === undefined ? configured.maximumPages : options.memberPages,
  };
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError(`memory group ${name} must be a positive integer`);
  }
  if (policy.maximumPages > MAX_GROUP_PAGES)
    throw new RangeError("memory group maximumPages exceeds the wasm32 address space");
  if (policy.memberPages > policy.maximumPages)
    throw new RangeError("memory group memberPages exceeds maximumPages");
  if (policy.stackBytes % 16)
    throw new RangeError("memory group stackBytes must be 16-byte aligned");
  return Object.freeze(policy);
}

/** W3: one page-wide budget of committed backing. Aliases never charge twice. */
export class GroupBackingBudget {
  committed = 0;
  peak = 0;
  /** The most recent request that did not fit, for reporting. */
  rejected: { readonly bytes: number; readonly committed: number } | undefined;
  constructor(readonly limit: number) {}
  charge(bytes: number): boolean {
    if (this.committed + bytes > this.limit) {
      this.rejected = { bytes, committed: this.committed };
      return false;
    }
    this.committed += bytes;
    this.peak = Math.max(this.peak, this.committed);
    return true;
  }
  release(bytes: number): void {
    if (bytes > this.committed) throw new Error("group backing released twice");
    this.committed -= bytes;
  }
  /** Backing that already exists is charged truthfully, even past the limit. */
  force(bytes: number): void {
    this.committed += bytes;
    this.peak = Math.max(this.peak, this.committed);
  }
}

/**
 * Page-visible identity of a group. Trusted embedder code only; never sent to guests.
 * It exposes the shared bytes, never the Memory object: only the owner grows the group.
 */
export interface MemoryGroupHandle {
  readonly id: string;
  /** The current shared buffer of the group memory. */
  buffer(): SharedArrayBuffer;
}
export interface MemoryGroupSnapshot {
  readonly id: string;
  /** Reserved or launched members; retained members are counted separately. */
  readonly members: number;
  readonly reserved: number;
  /** Members whose physical stop failed: their capacity and memory remain charged. */
  readonly retained: number;
  readonly pids: readonly number[];
  readonly regions: number;
  readonly pins: number;
  readonly published: number;
  readonly holds: number;
  readonly watches: number;
  /** Owner-granted logical backing, the W3 charge. Fixed reservation bytes are reported by the page ledger. */
  readonly committedBytes: number;
  /** Granted member pages, including reserved worker leases and retained members; excludes regions. */
  readonly memberPages: number;
  /** Growth that bypassed the owner was found and charged; the group admits nothing more. */
  readonly bypassed: boolean;
  /** Committed pages on the free list, reusable by later members and regions. */
  readonly freeBytes: number;
  /** Released incarnations whose thread exit is not proven yet (see `exitLock`). */
  readonly exiting: number;
  /** Of those, the ones whose lock request the browser rejected: never proven, never freed. */
  readonly exitFailures: number;
  /**
   * Bytes withheld until exits are proven. A live group counts the member chunks of `exiting`
   * incarnations (regions they held stay allocated and are counted in `regions`). An ended
   * group counts its whole backing, which waits for the last proof before it is retired.
   * On WebKit a terminated worker that never makes a host call is never proven to exit.
   */
  readonly quarantinedBytes: number;
  /**
   * The group ended but still waits for an exit proof; it admits nothing. It stays in the
   * snapshot until its backing is retired.
   */
  readonly ended: boolean;
}

/**
 * Web Locks prove that a terminated agent's thread exited. Bun has none. The owner and its
 * member workers must share one LockManager (same origin); a member worker from another origin
 * would let the owner's request succeed at once.
 */
function exitLocks(): LockManager | undefined {
  return (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
}

type Phase = "reserved" | "launched" | "released" | "retained";
interface Chunk {
  readonly page: number;
  readonly pages: number;
}
interface Member {
  phase: Phase;
  readonly index: number;
  readonly pid: number;
  readonly chunks: Chunk[];
  /** handle -> holds by this member. */
  readonly holds: Map<number, number>;
  port?: MessagePort;
  reply?: Int32Array;
  stopRequested: boolean;
  waitsClosed: boolean;
  /** Held by the launched agent until its thread exits; see MemoryGroupMemberRequest. */
  exitLock?: string;
  /** The agent sent a request, so it took its exit lock first (browser/worker.ts). */
  started?: boolean;
}
/** A released incarnation whose agent may still be running guest code on what it held. */
interface Exit {
  readonly chunks: Chunk[];
  readonly regions: Region[];
  readonly started: boolean;
}
interface Arena {
  readonly page: number;
  /** 16-byte units inside the arena page. */
  readonly units: RangeAllocator;
  used: number;
}
interface Region {
  readonly handle: number;
  readonly addr: number;
  readonly len: number;
  readonly arena?: Arena;
  readonly units: number;
  readonly chunk?: Chunk;
  readonly holders: Map<Member, number>;
  pins: number;
  /** Publications that reference this region. */
  published: number;
  /** Former holders whose thread exit is not proven yet. */
  exiting: number;
}
/** A pin belongs to one member incarnation or to this containing group. */
interface Pin {
  readonly id: number;
  readonly region: Region;
  owner: { readonly kind: "member"; readonly member: Member } | { readonly kind: "group" };
}
/** A group-owned reference set. It outlives its publisher and only that incarnation withdraws it. */
interface Publication {
  readonly kind: number;
  readonly primary: Region;
  readonly companion?: Region;
  readonly meta: number;
  readonly publisher: Member;
}

/** Issues u32 identities that never wrap or repeat. Callers refuse on `exhausted` before charging. */
class IdentityCounter {
  private next = 1;
  get exhausted(): boolean {
    return this.next > 0xffffffff;
  }
  take(): number {
    if (this.exhausted) throw new Error("memory group identity exhausted");
    return this.next++;
  }
}

/** Owner-side lifecycle of one admitted member incarnation. Each transition happens once. */
export interface MemberLease {
  readonly group: MemoryGroupHandle;
  readonly pid: number;
  readonly index: number;
  /** Builds this incarnation's request field once, when its agent is constructed. */
  launch(): { request: MemoryGroupMemberRequest; transfer: Transferable[] };
  /** No agent ever existed: return the reservation. */
  abort(): void;
  /** The matching agent physically stopped: reclaim its memory, holds, pins and capacity. */
  stopped(): void;
  /** Physical stop failed: keep capacity, memory, holds and pins charged as debt. */
  failed(): void;
  /** Native termination was attempted, including throw/rejection. This is not a stop receipt. */
  stopRequested(): void;
  /**
   * Stop-time only: if its agent has a futex wait published, closes the wait record without a
   * wake and reports whether the wait is still published. True means it is parked or about to
   * park, and any way out of the wait now throws instead of returning to guest code (see
   * parkedAndClosed). A record with no published wait is left open.
   */
  closeParked(): boolean;
  /** True once this incarnation's memory and capacity were returned. */
  settled(): boolean;
  /** Close this exact sole launched incarnation to new joins until physical stop. */
  closeAdmission(): { rollback(): void };
}

const SMALL_REGION = 32 * 1024;
const UNIT = 16;

export class MemoryGroupOwner {
  readonly handle: MemoryGroupHandle;
  private readonly watchTable: Int32Array;
  private readonly members: (Member | undefined)[];
  private readonly free = new RangeAllocator();
  private readonly regions = new Map<number, Region>();
  private readonly pins = new Map<number, Pin>();
  private readonly arenas: Arena[] = [];
  private readonly published = new Map<number, Publication>();
  private readonly handles = new IdentityCounter();
  private readonly pinIds = new IdentityCounter();
  private ended = false;
  private admission: "open" | "sealed" | { readonly member: Member } = "open";
  /** Only private incarnation records survive reusable slot release. No guest memory aliases. */
  private readonly retiredWaits: Int32Array[] = [];
  /** Unproven exits. They outlive group end: the backing is retired once they drain. */
  private readonly exits = new Set<Exit>();
  private quarantinedPages = 0;
  private exitFailures = 0;
  /** Bytes charged to the page budget for this group's backing. */
  private charged = PAGE_BYTES;
  private memberPages = 0;
  private bypassed = false;
  private readonly memory: WebAssembly.Memory;
  readonly control: SharedArrayBuffer;

  constructor(
    readonly id: string,
    readonly directory: string,
    private readonly policy: MemoryGroupPolicy,
    private readonly budget: GroupBackingBudget,
    /** Page-wide, so a token from another group is absent from this group's directory. */
    private readonly tokens: IdentityCounter,
    private readonly onEnd: (group: MemoryGroupOwner) => void,
    /** The backing was retired, at group end or after the last exit proof that outlived it. */
    private readonly onRetired: (group: MemoryGroupOwner) => void,
    private readonly source?: GroupMemorySource,
    private readonly backing?: GroupBacking,
    private readonly terminalAdmission?: () => boolean,
  ) {
    if (!budget.charge(PAGE_BYTES))
      throw new ProcessError(GroupErrno.NOMEM, "memory group budget is exhausted");
    let memory: WebAssembly.Memory;
    let control: SharedArrayBuffer;
    try {
      // Page 0 stays reserved, so address 0 is never a member or region address.
      memory =
        backing?.memory ??
        new WebAssembly.Memory({ initial: 1, maximum: policy.maximumPages, shared: true });
      control =
        source?.control(controlBytes(policy.watches)) ??
        allocateSharedControl(controlBytes(policy.watches));
    } catch (error) {
      budget.release(PAGE_BYTES);
      throw error;
    }
    this.memory = memory;
    const buffer = (): SharedArrayBuffer => {
      if (this.ended) throw new ProcessError(ProcessErrno.SRCH, "memory group has ended");
      if (backing) backing.exposed = true;
      const current = memory.buffer;
      if (!(current instanceof SharedArrayBuffer))
        throw new TypeError("group memory is not shared");
      return current;
    };
    this.handle = Object.freeze({ id, buffer });
    this.control = control;
    this.watchTable = new Int32Array(this.control);
    this.members = Array.from({ length: policy.members }, () => undefined);
  }

  /**
   * Waffle loaders never admit an image that grows the memory itself, but a trusted executor
   * could. Charge what actually exists and stop admitting into a group that was grown around
   * its owner, rather than letting accounting and release diverge.
   */
  private reconcile(): void {
    if (this.backing?.kind === "fixed") return;
    const excess = this.memory.buffer.byteLength - this.charged;
    if (excess <= 0) return;
    this.budget.force(excess);
    this.charged += excess;
    this.bypassed = true;
  }

  /** W1: reserve a member slot before any Worker exists. */
  reserve(pid: number): MemberLease {
    if (this.ended) throw new ProcessError(ProcessErrno.SRCH, "memory group has ended");
    if (this.admission !== "open")
      throw new ProcessError(ProcessErrno.NOTSUP, "memory group admission is closed");
    this.reconcile();
    if (this.bypassed)
      throw new ProcessError(ProcessErrno.INVAL, "memory group grew outside its owner");
    const index = this.members.indexOf(undefined);
    if (index < 0) throw new ProcessError(ProcessErrno.AGAIN, "memory group member limit reached");
    const member: Member = {
      phase: "reserved",
      index,
      pid,
      chunks: [],
      holds: new Map(),
      stopRequested: false,
      waitsClosed: false,
    };
    this.members[index] = member;
    return this.lease(member);
  }

  /** The live member running as `pid`, if any. */
  memberOf(pid: number): boolean {
    return this.members.some((member) => member?.pid === pid && this.receives(member));
  }

  /** Ended, but its backing still waits for an exit proof before it is retired. */
  draining(): boolean {
    return this.ended && this.exits.size > 0;
  }

  snapshot(): MemoryGroupSnapshot {
    // An ended group's budget charge is already returned; never charge it again.
    if (!this.ended) this.reconcile();
    const live = this.members.filter((member): member is Member => !!member);
    let holds = 0;
    for (const region of this.regions.values())
      for (const count of region.holders.values()) holds += count;
    let watches = 0;
    for (let slot = 0; slot < this.policy.watches; slot++)
      if (Atomics.load(this.watchTable, WATCH_HEADER_WORDS + slot * WATCH_SLOT_WORDS)) watches++;
    return Object.freeze({
      id: this.id,
      members: live.filter((member) => member.phase !== "retained").length,
      reserved: live.filter((member) => member.phase === "reserved").length,
      retained: live.filter((member) => member.phase === "retained").length,
      pids: Object.freeze(live.map((member) => member.pid)),
      regions: this.regions.size,
      pins: this.pins.size,
      published: this.published.size,
      holds,
      watches,
      committedBytes: this.charged,
      memberPages: this.memberPages,
      bypassed: this.bypassed,
      freeBytes: this.free.available * PAGE_BYTES,
      exiting: this.exits.size,
      exitFailures: this.exitFailures,
      quarantinedBytes: this.ended
        ? this.memory.buffer.byteLength
        : this.quarantinedPages * PAGE_BYTES,
      ended: this.ended,
    });
  }

  /** Members whose physical stop has not been proven. */
  unsettled(): number {
    return this.members.filter((member) => member !== undefined).length;
  }

  private lease(member: Member): MemberLease {
    return Object.freeze({
      group: this.handle,
      pid: member.pid,
      index: member.index,
      launch: () => this.launch(member),
      abort: () => {
        if (member.phase === "reserved" && !member.port) this.release(member);
      },
      stopped: () => {
        if (member.phase !== "released") this.release(member);
      },
      failed: () => {
        if (member.phase !== "released") {
          member.phase = "retained";
          if (this.backing) this.source?.failed(this.backing);
          this.settleStopping();
        }
      },
      stopRequested: () => {
        if (this.members[member.index] !== member || !member.reply) return;
        member.stopRequested = true;
        this.settleStopping();
      },
      closeParked: () => {
        if (this.members[member.index] !== member || !member.reply) return false;
        // Not parked: leave the record open; the stop waits for the guest's exit report.
        if (!this.parkedAndClosed(member.reply)) return false;
        // Same order as release(): CLOSED first, then only an odd epoch read after it counts,
        // so a timed or sibling wake before terminate() throws instead of resuming guest code.
        Atomics.store(member.reply, WAIT_CLOSED, 1);
        return this.parkedAndClosed(member.reply);
      },
      settled: () => member.phase === "released",
      closeAdmission: () => this.closeAdmission(member),
    });
  }

  private closeAdmission(member: Member): { rollback(): void } {
    this.reconcile();
    if (
      this.ended ||
      this.bypassed ||
      this.admission !== "open" ||
      !this.receives(member) ||
      this.members.some((entry) => entry !== undefined && entry !== member)
    )
      throw new ProcessError(ProcessErrno.NOTSUP, "exec requires the sole launched group member");
    const closing = { member };
    this.admission = closing;
    return {
      rollback: () => {
        if (this.admission === closing && this.receives(member)) this.admission = "open";
      },
    };
  }

  private launch(member: Member): { request: MemoryGroupMemberRequest; transfer: Transferable[] } {
    if (member.phase !== "reserved" || member.port)
      throw new Error("memory group member was already launched");
    const reply =
      this.source?.control(MEMBER_CELL_WORDS * 4) ?? allocateSharedControl(MEMBER_CELL_WORDS * 4);
    const channel = new MessageChannel();
    member.port = channel.port1;
    member.reply = new Int32Array(reply);
    member.phase = "launched";
    if (exitLocks()) member.exitLock = `waffle-group-exit-${crypto.randomUUID()}`;
    channel.port1.onmessage = ({ data }: MessageEvent<GroupRequestMessage>) =>
      this.answer(member, data);
    const request: MemoryGroupMemberRequest = {
      memory: this.memory,
      control: this.control,
      reply,
      port: channel.port2,
      index: member.index,
      watches: this.policy.watches,
      parallelism: this.policy.parallelism,
      stackBytes: this.policy.stackBytes,
      exitLock: member.exitLock,
    };
    return { request, transfer: [channel.port2] };
  }

  /** Only the current launched incarnation is answered; a stopped or indebted agent waits. */
  private receives(member: Member): boolean {
    return this.members[member.index] === member && member.phase === "launched";
  }

  private answer(member: Member, data: GroupRequestMessage): void {
    if (!this.receives(member) || !member.reply) return;
    member.started = true;
    if (
      typeof data !== "object" ||
      data === null ||
      !Number.isSafeInteger(data.seq) ||
      !Number.isSafeInteger(data.op) ||
      !Array.isArray(data.args) ||
      data.args.length !== 4 ||
      !data.args.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff)
    )
      return;
    const result = this.dispatch(member, data.op, data.args);
    if (!this.receives(member) || !member.reply) return;
    const reply = member.reply;
    for (let index = 1; index < REPLY_WORDS; index++) reply[index] = result[index - 1] ?? 0;
    Atomics.store(reply, 0, data.seq | 0);
    Atomics.notify(reply, 0);
  }

  /** Returns [status, r0..r6]. Exposed for owner-side tests through `request`. */
  private dispatch(member: Member, op: number, [a, b, c, d]: readonly number[]): number[] {
    switch (op) {
      case GroupOp.GROW:
        return [this.grow(member, a!)];
      case GroupOp.CREATE:
        return this.create(member, a!, b!);
      case GroupOp.ATTACH:
        return this.attach(member, a!);
      case GroupOp.DETACH:
        return [this.detach(member, a!)];
      case GroupOp.PIN:
        return this.pin(member, a!);
      case GroupOp.ROUTE:
        return [this.route(member, a!, b!)];
      case GroupOp.ROUTE_GROUP:
        return [this.routeGroup(member, a!)];
      case GroupOp.ACCEPT:
        return this.accept(member, a!);
      case GroupOp.UNPIN:
        return [this.unpin(member, a!)];
      case GroupOp.PUBLISH:
        return this.publish(member, a!, b!, c!, d!);
      case GroupOp.OPEN:
        return this.open(member, a!, b!);
      case GroupOp.WITHDRAW:
        return [this.withdraw(member, a!)];
      default:
        return [-GroupErrno.INVAL];
    }
  }

  /** In-process entry for the owner's own tests and for page-side shims; same rules as RPC. */
  request(lease: MemberLease, op: number, a = 0, b = 0, c = 0, d = 0): number[] {
    const member = this.members[lease.index];
    if (!member || member.pid !== lease.pid || !this.receives(member)) return [-GroupErrno.SRCH];
    return this.dispatch(member, op, [a, b, c, d]);
  }

  private takePages(pages: number): number | undefined {
    const reused = this.free.take(pages);
    if (reused !== undefined) {
      // Recycled chunks are dirty; fresh growth is already zero.
      new Uint8Array(this.memory.buffer, reused * PAGE_BYTES, pages * PAGE_BYTES).fill(0);
      return reused;
    }
    this.reconcile();
    if (this.bypassed) return undefined;
    const current = this.charged / PAGE_BYTES;
    if (current + pages > this.policy.maximumPages) return undefined;
    if (!this.budget.charge(pages * PAGE_BYTES)) return undefined;
    if (this.backing?.kind === "fixed") {
      if (current + pages > this.backing.pages) {
        this.budget.release(pages * PAGE_BYTES);
        return undefined;
      }
      this.charged += pages * PAGE_BYTES;
      new Uint8Array(this.memory.buffer, current * PAGE_BYTES, pages * PAGE_BYTES).fill(0);
      return current;
    }
    try {
      const page = this.memory.grow(pages);
      this.charged += pages * PAGE_BYTES;
      return page;
    } catch {
      this.budget.release(pages * PAGE_BYTES);
      return undefined;
    }
  }

  private grow(member: Member, pages: number): number {
    if (pages < 1 || pages > this.policy.maximumPages) return -GroupErrno.INVAL;
    if (pages > this.policy.memberPages - this.memberPages) return -GroupErrno.NOMEM;
    const page = this.takePages(pages);
    if (page === undefined) return -GroupErrno.NOMEM;
    member.chunks.push({ page, pages });
    this.memberPages += pages;
    return page;
  }

  private create(member: Member, len: number, align: number): number[] {
    if (len < 1 || len > 0x7fffffff || align < 1 || align > PAGE_BYTES || align & (align - 1))
      return [-GroupErrno.INVAL];
    if (this.regions.size >= this.policy.regions || this.handles.exhausted)
      return [-GroupErrno.AGAIN];
    const placed =
      len <= SMALL_REGION && align <= SMALL_REGION
        ? this.placeSmall(len, align)
        : this.placeLarge(len);
    if (!placed) return [-GroupErrno.NOMEM];
    const handle = this.handles.take();
    const region: Region = {
      ...placed,
      handle,
      len,
      holders: new Map([[member, 1]]),
      pins: 0,
      published: 0,
      exiting: 0,
    };
    // Large placements are already zeroed by takePages, including recycled and fixed backing.
    if (region.arena) new Uint8Array(this.memory.buffer, region.addr, len).fill(0);
    this.regions.set(handle, region);
    member.holds.set(handle, 1);
    return [0, handle, region.addr];
  }

  private placeSmall(len: number, align: number) {
    const units = Math.ceil(len / UNIT),
      alignment = Math.max(1, align / UNIT);
    for (const arena of this.arenas) {
      const start = arena.units.take(units, alignment);
      if (start === undefined) continue;
      arena.used += units;
      return { arena, units, addr: arena.page * PAGE_BYTES + start * UNIT };
    }
    const page = this.takePages(1);
    if (page === undefined) return undefined;
    const arena: Arena = { page, units: new RangeAllocator(), used: units };
    arena.units.give(0, PAGE_BYTES / UNIT);
    arena.units.take(units);
    this.arenas.push(arena);
    return { arena, units, addr: page * PAGE_BYTES };
  }

  private placeLarge(len: number) {
    const pages = Math.ceil(len / PAGE_BYTES);
    const page = this.takePages(pages);
    if (page === undefined) return undefined;
    return { chunk: { page, pages }, units: 0, addr: page * PAGE_BYTES };
  }

  private attach(member: Member, handle: number): number[] {
    const region = this.regions.get(handle);
    if (!region) return [-GroupErrno.BADF];
    this.addHold(member, region);
    return [0, region.addr, region.len];
  }

  private addHold(member: Member, region: Region): void {
    region.holders.set(member, (region.holders.get(member) ?? 0) + 1);
    member.holds.set(region.handle, (member.holds.get(region.handle) ?? 0) + 1);
  }

  private held(member: Member, handle: number): Region | undefined {
    return member.holds.get(handle) ? this.regions.get(handle) : undefined;
  }

  private detach(member: Member, handle: number): number {
    const region = this.regions.get(handle);
    const count = member.holds.get(handle);
    if (!region || !count) return -GroupErrno.BADF;
    if (count === 1) {
      member.holds.delete(handle);
      region.holders.delete(member);
    } else {
      member.holds.set(handle, count - 1);
      region.holders.set(member, count - 1);
    }
    this.maybeFree(region);
    return 0;
  }

  private pin(member: Member, handle: number): number[] {
    const region = this.regions.get(handle);
    if (!region || !member.holds.get(handle)) return [-GroupErrno.BADF];
    if (this.pins.size >= this.policy.pins || this.pinIds.exhausted) return [-GroupErrno.AGAIN];
    const id = this.pinIds.take();
    this.pins.set(id, { id, region, owner: { kind: "member", member } });
    region.pins++;
    return [0, id];
  }

  /** The owner hands its delivery to the member that will read it. */
  private route(member: Member, id: number, pid: number): number {
    const pin = this.pins.get(id);
    if (!pin || pin.owner.kind !== "member" || pin.owner.member !== member) return -GroupErrno.BADF;
    const target = this.members.find(
      (candidate) =>
        candidate?.pid === pid &&
        (candidate.phase === "launched" || candidate.phase === "reserved"),
    );
    if (!target) return -GroupErrno.SRCH;
    pin.owner = { kind: "member", member: target };
    return 0;
  }

  private routeGroup(member: Member, id: number): number {
    const pin = this.pins.get(id);
    if (!pin || pin.owner.kind !== "member" || pin.owner.member !== member) return -GroupErrno.BADF;
    pin.owner = { kind: "group" };
    return 0;
  }

  private accept(member: Member, id: number): number[] {
    const pin = this.pins.get(id);
    if (!pin || pin.owner.kind !== "member" || pin.owner.member !== member)
      return [-GroupErrno.BADF];
    const region = pin.region;
    this.pins.delete(id);
    region.pins--;
    this.addHold(member, region);
    return [0, region.handle, region.addr, region.len];
  }

  private unpin(member: Member, id: number): number {
    const pin = this.pins.get(id);
    if (!pin || (pin.owner.kind === "member" && pin.owner.member !== member))
      return -GroupErrno.BADF;
    this.dropPin(pin);
    return 0;
  }

  private dropPin(pin: Pin): void {
    this.pins.delete(pin.id);
    pin.region.pins--;
    this.maybeFree(pin.region);
  }

  /** One owner step: a complete publication, or no change. */
  private publish(
    member: Member,
    kind: number,
    primaryHandle: number,
    companionHandle: number,
    meta: number,
  ): number[] {
    if (kind === 0 || companionHandle === primaryHandle) return [-GroupErrno.INVAL];
    const primary = this.held(member, primaryHandle);
    const companion = companionHandle === 0 ? undefined : this.held(member, companionHandle);
    if (!primary || (companionHandle !== 0 && !companion)) return [-GroupErrno.BADF];
    if (this.published.size >= this.policy.publications || this.tokens.exhausted)
      return [-GroupErrno.AGAIN];
    const token = this.tokens.take();
    primary.published++;
    if (companion) companion.published++;
    this.published.set(token, { kind, primary, companion, meta, publisher: member });
    return [0, token];
  }

  /** One owner step: a hold on every region and the owner's own extents, or nothing. */
  private open(member: Member, token: number, kind: number): number[] {
    const entry = this.published.get(token);
    if (!entry || entry.kind !== kind) return [-GroupErrno.BADF];
    const { primary, companion, meta } = entry;
    this.addHold(member, primary);
    if (companion) this.addHold(member, companion);
    return [
      0,
      primary.handle,
      primary.addr,
      primary.len,
      companion?.handle ?? 0,
      companion?.addr ?? 0,
      companion?.len ?? 0,
      meta,
    ];
  }

  private withdraw(member: Member, token: number): number {
    const entry = this.published.get(token);
    if (!entry || entry.publisher !== member) return -GroupErrno.BADF;
    this.published.delete(token);
    this.unpublish(entry.primary);
    if (entry.companion) this.unpublish(entry.companion);
    return 0;
  }

  private unpublish(region: Region): void {
    region.published--;
    this.maybeFree(region);
  }

  private maybeFree(region: Region): void {
    if (region.holders.size || region.pins || region.published || region.exiting) return;
    this.regions.delete(region.handle);
    if (region.chunk) {
      this.free.give(region.chunk.page, region.chunk.pages);
      return;
    }
    const arena = region.arena!;
    arena.units.give((region.addr - arena.page * PAGE_BYTES) / UNIT, region.units);
    arena.used -= region.units;
    if (arena.used) return;
    this.arenas.splice(this.arenas.indexOf(arena), 1);
    this.free.give(arena.page, 1);
  }

  private clearWatches(index: number): void {
    const owner = index + 1;
    for (let slot = 0; slot < this.policy.watches; slot++) {
      const at = WATCH_HEADER_WORDS + slot * WATCH_SLOT_WORDS;
      if (Atomics.load(this.watchTable, at) >> 1 !== owner) continue;
      Atomics.store(this.watchTable, at + 1, 0);
      Atomics.store(this.watchTable, at, 0);
    }
  }

  /** Synchronous admission decision and irreversible seal precede every teardown notify. */
  settleStopping(): void {
    if (this.ended) return;
    for (let index = 0; index < this.members.length; index++) {
      const member = this.members[index];
      if (member && member.phase !== "released" && (!member.reply || !member.stopRequested)) return;
    }
    if (this.admission !== "sealed" && this.terminalAdmission && !this.terminalAdmission()) return;
    this.admission = "sealed";
    for (let index = 0; index < this.members.length; index++)
      this.closeMemberWait(this.members[index]);
    for (let index = 0; index < this.retiredWaits.length; index++)
      this.closeWait(this.retiredWaits[index]!);
    this.retiredWaits.length = 0;
    if (this.members.every((member) => member === undefined)) this.end();
  }

  private closeMemberWait(member: Member | undefined): void {
    if (!member || member.waitsClosed || !member.reply) return;
    member.waitsClosed = true;
    this.closeWait(member.reply);
  }

  private closeWait(cells: Int32Array): void {
    Atomics.store(cells, WAIT_CLOSED, 1);
    for (;;) {
      const epoch = Atomics.load(cells, WAIT_EPOCH);
      if ((epoch & 1) === 0) return;
      const addr = Atomics.load(cells, WAIT_ADDR) >>> 0;
      const width = Atomics.load(cells, WAIT_WIDTH);
      if (Atomics.load(cells, WAIT_EPOCH) !== epoch) continue;
      const buffer = this.memory.buffer;
      if ((width === 4 || width === 8) && addr % width === 0 && addr + width <= buffer.byteLength)
        Atomics.notify(new Int32Array(buffer), addr / 4, Infinity);
      return;
    }
  }

  /** Physical stop or a launch that never constructed an agent. Runs once per incarnation. */
  private release(member: Member): void {
    if (this.members[member.index] !== member) return;
    member.stopRequested = true;
    member.phase = "released";
    // terminate() returning does not stop the thread: it can still be parked in futex_wait on
    // a cell in the pages released below. Close its record first, without a wake, so a notify
    // from the member that reuses those pages makes it throw instead of resuming guest code
    // on a stack it would then share.
    if (member.reply) Atomics.store(member.reply, WAIT_CLOSED, 1);
    this.settleStopping();
    if (member.reply && !member.waitsClosed) this.retiredWaits.push(member.reply);
    // terminate() returning does not stop guest code either: Chromium runs a busy guest for
    // about 2 s more and WebKit may never stop one that makes no host call. Whatever this
    // incarnation could address stays off the free list until its exit lock proves the thread
    // exited (plans/group-futex-retirement.md, gap 1). A member parked in futex_wait needs no
    // proof: see parkedAndClosed.
    const exit: Exit | undefined =
      member.exitLock && !this.parkedAndClosed(member.reply!)
        ? { chunks: [], regions: [], started: !!member.started }
        : undefined;
    // Pins whose delivery this member owned have no remaining consumer.
    for (const pin of Array.from(this.pins.values())) {
      if (pin.owner.kind === "member" && pin.owner.member === member) this.dropPin(pin);
    }
    for (const handle of member.holds.keys()) {
      const region = this.regions.get(handle)!;
      region.holders.delete(member);
      if (exit) {
        region.exiting++;
        exit.regions.push(region);
      }
      this.maybeFree(region);
    }
    member.holds.clear();
    for (const chunk of member.chunks) {
      this.memberPages -= chunk.pages;
      if (exit) exit.chunks.push(chunk);
      else this.free.give(chunk.page, chunk.pages);
    }
    member.chunks.length = 0;
    if (exit) this.awaitExit(member.exitLock!, exit);
    this.clearWatches(member.index);
    member.port?.close();
    member.port = undefined;
    member.reply = undefined;
    this.members[member.index] = undefined;
    this.settleStopping();
  }

  /**
   * True when the incarnation can never run guest code again, without waiting for its thread.
   * The caller already stored WAIT_CLOSED. The member publishes an odd WAIT_EPOCH before it
   * reads WAIT_CLOSED and parks, and stores the even epoch before it reads WAIT_CLOSED again
   * on the way out (group/member.ts, `wait`). All four accesses are sequentially consistent,
   * so an odd epoch read after the CLOSED store means the member's read on the way out still
   * lies ahead: it is parked or about to park, and any return throws the stop instead of
   * resuming guest code. Guest code that catches that throw (Wasm `catch_all`) is the residual
   * recorded in the plan. An even epoch proves nothing. iOS Safari keeps a terminated
   * parked thread (and its Web Lock) alive, so this path keeps sleepers' pages reusable there.
   */
  private parkedAndClosed(cells: Int32Array): boolean {
    return (Atomics.load(cells, WAIT_EPOCH) & 1) === 1;
  }

  /**
   * The agent took this lock before guest code and holds it until its thread exits, so the
   * grant is the proof. The request outlives group end: the backing waits for it.
   */
  private awaitExit(name: string, exit: Exit): void {
    this.exits.add(exit);
    for (const chunk of exit.chunks) this.quarantinedPages += chunk.pages;
    let granted = false;
    exitLocks()!
      .request(name, () => {
        granted = true;
        return this.exited(exit);
      })
      .catch(() => {
        // The lock manager refused: no proof will come, so the pages and the backing stay
        // withheld for the page's life. The snapshot counts it in `exitFailures`. A throw
        // from a granted callback is not a refusal: that exit was already proven.
        if (!granted) this.exitFailures++;
      });
  }

  /**
   * An agent that sent a request held the lock and has exited, so the lock is released at once.
   * One that never did may not have taken it yet: the owner keeps the lock for the page's life,
   * and that agent refuses to start (rare: a launch stopped before its worker ran).
   */
  private exited(exit: Exit): Promise<never> | undefined {
    if (!this.exits.delete(exit)) return undefined;
    for (const chunk of exit.chunks) this.quarantinedPages -= chunk.pages;
    if (!this.ended) this.reuse(exit);
    else if (!this.exits.size) this.retire();
    return exit.started ? undefined : new Promise<never>(() => {});
  }

  private reuse(exit: Exit): void {
    for (const chunk of exit.chunks) this.free.give(chunk.page, chunk.pages);
    for (const region of exit.regions) {
      region.exiting--;
      this.maybeFree(region);
    }
  }

  /** Pooled backing goes to another group, so it waits until every exit is proven. */
  private retire(): void {
    if (this.backing) this.source?.retire(this.backing);
    this.onRetired(this);
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    this.reconcile();
    this.published.clear();
    this.regions.clear();
    this.pins.clear();
    this.arenas.length = 0;
    this.budget.release(this.charged);
    if (!this.exits.size) this.retire();
    this.onEnd(this);
  }
}

/** The page's groups, their shared W3 budget and policy. */
export class MemoryGroups {
  readonly policy: MemoryGroupPolicy;
  readonly budget: GroupBackingBudget;
  private readonly tokens = new IdentityCounter();
  private readonly groups = new Map<string, MemoryGroupOwner>();
  /** Ended groups whose backing still waits for an exit proof; reported, never joinable. */
  private readonly draining = new Set<MemoryGroupOwner>();
  private readonly owners = new WeakMap<MemoryGroupHandle, MemoryGroupOwner>();
  private nextId = 1;
  private readonly explicitMaximum: number | undefined;
  constructor(
    options?: MemoryGroupPolicyOptions,
    private readonly memories?: GroupMemorySource,
    private readonly sizing?: ReservationSizing,
  ) {
    this.explicitMaximum = options?.maximumPages;
    this.policy = memoryGroupPolicy(options);
    this.budget = new GroupBackingBudget(this.policy.budgetBytes);
  }
  /** Reserve before constructing a Worker. Throws ProcessError(EAGAIN/ENOMEM/ESRCH/EINVAL). */
  admit(
    pid: number,
    directory: string,
    join: "new" | MemoryGroupHandle,
    headroom: Headroom | null = null,
    terminalAdmission?: () => boolean,
  ): MemberLease {
    if (join !== "new") return this.join(pid, directory, join);
    if (this.groups.size >= this.policy.groups)
      throw new ProcessError(ProcessErrno.AGAIN, "memory group limit reached");
    const id = `g${this.nextId++}`;
    const shape = this.sizing?.groupShape(this.explicitMaximum);
    const backing = shape ? this.memories?.create(shape, headroom) : undefined;
    let group: MemoryGroupOwner;
    try {
      group = new MemoryGroupOwner(
        id,
        directory,
        this.policy,
        this.budget,
        this.tokens,
        (ended) => {
          this.groups.delete(ended.id);
          if (ended.draining()) this.draining.add(ended);
        },
        (retired) => this.draining.delete(retired),
        this.memories,
        backing,
        terminalAdmission,
      );
    } catch (error) {
      if (backing) this.memories?.retire(backing);
      throw error;
    }
    this.groups.set(id, group);
    this.owners.set(group.handle, group);
    return group.reserve(pid);
  }
  private join(pid: number, directory: string, join: MemoryGroupHandle): MemberLease {
    const group = this.owners.get(join);
    if (!group || !this.groups.has(group.id))
      throw new ProcessError(ProcessErrno.SRCH, "memory group has ended");
    if (group.directory !== directory)
      throw new ProcessError(
        ProcessErrno.INVAL,
        "memory group members share one process directory",
      );
    return group.reserve(pid);
  }
  groupOf(pid: number): MemoryGroupHandle | undefined {
    for (const group of this.groups.values()) if (group.memberOf(pid)) return group.handle;
    return undefined;
  }
  owner(handle: MemoryGroupHandle): MemoryGroupOwner | undefined {
    return this.owners.get(handle);
  }
  /**
   * Live groups, then ended groups still holding their backing for an unproven exit. Those
   * report `committedBytes` and `freeBytes` as 0 here: their budget charge was returned and
   * nothing can be admitted into them, so sums across this list match `budget.committed`.
   */
  snapshot(): readonly MemoryGroupSnapshot[] {
    return Array.from(this.groups.values(), (group) => group.snapshot()).concat(
      Array.from(this.draining, (group) =>
        Object.freeze({ ...group.snapshot(), committedBytes: 0, freeBytes: 0 }),
      ),
    );
  }
  unsettled(): number {
    let count = 0;
    for (const group of this.groups.values()) count += group.unsettled();
    return count;
  }
  /** Retry deferred terminal decisions after exact admission/preparation settlement. */
  settleStopping(): void {
    for (const group of this.groups.values()) group.settleStopping();
  }
}
