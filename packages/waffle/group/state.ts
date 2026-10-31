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
  PAGE_BYTES,
  REPLY_WORDS,
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
  /** Bounded metadata per group. */
  readonly regions: number;
  readonly pins: number;
  readonly watches: number;
  /** Bounded number of live groups per page. */
  readonly groups: number;
  /** Private stack carved for each PIE member image, in bytes. */
  readonly stackBytes: number;
}
export type MemoryGroupPolicyOptions = Partial<MemoryGroupPolicy>;

const defaultMemoryGroupPolicy: MemoryGroupPolicy = Object.freeze({
  members: 16,
  parallelism: 1,
  budgetBytes: 2 * 1024 ** 3,
  maximumPages: MAX_GROUP_PAGES,
  regions: 4096,
  pins: 4096,
  watches: 1024,
  groups: 64,
  stackBytes: 1024 * 1024,
});

function memoryGroupPolicy(options: MemoryGroupPolicyOptions = {}): MemoryGroupPolicy {
  const policy = { ...defaultMemoryGroupPolicy, ...options };
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError(`memory group ${name} must be a positive integer`);
  }
  if (policy.maximumPages > MAX_GROUP_PAGES)
    throw new RangeError("memory group maximumPages exceeds the wasm32 address space");
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
  readonly holds: number;
  readonly watches: number;
  /** Actual backing of the group memory, the W3 charge. */
  readonly committedBytes: number;
  /** Growth that bypassed the owner was found and charged; the group admits nothing more. */
  readonly bypassed: boolean;
  /** Committed pages on the free list, reusable by later members and regions. */
  readonly freeBytes: number;
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
}
/** A transit pin. Its owner is the member that must accept or discard the delivery. */
interface Pin {
  readonly id: number;
  readonly region: Region;
  owner: Member;
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
  /** True once this incarnation's memory and capacity were returned. */
  settled(): boolean;
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
  private nextHandle = 1;
  private nextPin = 1;
  private ended = false;
  /** Bytes charged to the page budget for this group's backing. */
  private charged = PAGE_BYTES;
  private bypassed = false;
  private readonly memory: WebAssembly.Memory;
  readonly control: SharedArrayBuffer;

  constructor(
    readonly id: string,
    readonly directory: string,
    private readonly policy: MemoryGroupPolicy,
    private readonly budget: GroupBackingBudget,
    private readonly onEnd: (group: MemoryGroupOwner) => void,
    private readonly source?: GroupMemorySource,
    private readonly backing?: GroupBacking,
  ) {
    if (!budget.charge(PAGE_BYTES))
      throw new ProcessError(GroupErrno.NOMEM, "memory group budget is exhausted");
    let memory: WebAssembly.Memory;
    try {
      // Page 0 stays reserved, so address 0 is never a member or region address.
      memory =
        backing?.memory ??
        new WebAssembly.Memory({ initial: 1, maximum: policy.maximumPages, shared: true });
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
    this.control =
      source?.control(controlBytes(policy.watches)) ??
      allocateSharedControl(controlBytes(policy.watches));
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
    this.reconcile();
    if (this.bypassed)
      throw new ProcessError(ProcessErrno.INVAL, "memory group grew outside its owner");
    const index = this.members.indexOf(undefined);
    if (index < 0) throw new ProcessError(ProcessErrno.AGAIN, "memory group member limit reached");
    const member: Member = { phase: "reserved", index, pid, chunks: [], holds: new Map() };
    this.members[index] = member;
    return this.lease(member);
  }

  /** The live member running as `pid`, if any. */
  memberOf(pid: number): boolean {
    return this.members.some((member) => member?.pid === pid && this.receives(member));
  }

  snapshot(): MemoryGroupSnapshot {
    this.reconcile();
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
      holds,
      watches,
      committedBytes: this.charged,
      bypassed: this.bypassed,
      freeBytes: this.free.available * PAGE_BYTES,
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
        }
      },
      settled: () => member.phase === "released",
    });
  }

  private launch(member: Member): { request: MemoryGroupMemberRequest; transfer: Transferable[] } {
    if (member.phase !== "reserved" || member.port)
      throw new Error("memory group member was already launched");
    const reply = this.source?.control(REPLY_WORDS * 4) ?? allocateSharedControl(REPLY_WORDS * 4);
    const channel = new MessageChannel();
    member.port = channel.port1;
    member.reply = new Int32Array(reply);
    member.phase = "launched";
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
    };
    return { request, transfer: [channel.port2] };
  }

  /** Only the current launched incarnation is answered; a stopped or indebted agent waits. */
  private receives(member: Member): boolean {
    return this.members[member.index] === member && member.phase === "launched";
  }

  private answer(member: Member, data: GroupRequestMessage): void {
    if (!this.receives(member) || !member.reply) return;
    if (
      typeof data !== "object" ||
      data === null ||
      !Number.isSafeInteger(data.seq) ||
      !Number.isSafeInteger(data.op) ||
      !Array.isArray(data.args) ||
      data.args.length !== 3 ||
      !data.args.every((value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff)
    )
      return;
    const result = this.dispatch(member, data.op, data.args);
    const reply = member.reply;
    for (let index = 0; index < 4; index++) reply[1 + index] = result[index] ?? 0;
    Atomics.store(reply, 0, data.seq | 0);
    Atomics.notify(reply, 0);
  }

  /** Returns [status, r0, r1, r2]. Exposed for owner-side tests through `request`. */
  private dispatch(member: Member, op: number, [a, b]: readonly number[]): number[] {
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
      case GroupOp.ACCEPT:
        return this.accept(member, a!);
      case GroupOp.UNPIN:
        return [this.unpin(member, a!)];
      default:
        return [-GroupErrno.INVAL];
    }
  }

  /** In-process entry for the owner's own tests and for page-side shims; same rules as RPC. */
  request(lease: MemberLease, op: number, a = 0, b = 0, c = 0): number[] {
    const member = this.members[lease.index];
    if (!member || member.pid !== lease.pid || !this.receives(member)) return [-GroupErrno.SRCH];
    return this.dispatch(member, op, [a, b, c]);
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
    const page = this.takePages(pages);
    if (page === undefined) return -GroupErrno.NOMEM;
    member.chunks.push({ page, pages });
    return page;
  }

  private create(member: Member, len: number, align: number): number[] {
    if (len < 1 || len > 0x7fffffff || align < 1 || align > PAGE_BYTES || align & (align - 1))
      return [-GroupErrno.INVAL];
    if (this.regions.size >= this.policy.regions) return [-GroupErrno.AGAIN];
    const placed =
      len <= SMALL_REGION && align <= SMALL_REGION
        ? this.placeSmall(len, align)
        : this.placeLarge(len);
    if (!placed) return [-GroupErrno.NOMEM];
    const handle = this.nextHandle++;
    if (this.nextHandle > 0xffffffff) this.nextHandle = 1;
    const region: Region = { ...placed, handle, len, holders: new Map([[member, 1]]), pins: 0 };
    new Uint8Array(this.memory.buffer, region.addr, len).fill(0);
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
    region.holders.set(member, (region.holders.get(member) ?? 0) + 1);
    member.holds.set(handle, (member.holds.get(handle) ?? 0) + 1);
    return [0, region.addr, region.len];
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
    if (this.pins.size >= this.policy.pins) return [-GroupErrno.AGAIN];
    const id = this.nextPin++;
    if (this.nextPin > 0xffffffff) this.nextPin = 1;
    this.pins.set(id, { id, region, owner: member });
    region.pins++;
    return [0, id];
  }

  /** The owner hands its delivery to the member that will read it. */
  private route(member: Member, id: number, pid: number): number {
    const pin = this.pins.get(id);
    if (!pin || pin.owner !== member) return -GroupErrno.BADF;
    const target = this.members.find(
      (candidate) =>
        candidate?.pid === pid &&
        (candidate.phase === "launched" || candidate.phase === "reserved"),
    );
    if (!target) return -GroupErrno.SRCH;
    pin.owner = target;
    return 0;
  }

  private accept(member: Member, id: number): number[] {
    const pin = this.pins.get(id);
    if (!pin || pin.owner !== member) return [-GroupErrno.BADF];
    const region = pin.region;
    this.pins.delete(id);
    region.pins--;
    region.holders.set(member, (region.holders.get(member) ?? 0) + 1);
    member.holds.set(region.handle, (member.holds.get(region.handle) ?? 0) + 1);
    return [0, region.handle, region.addr, region.len];
  }

  private unpin(member: Member, id: number): number {
    const pin = this.pins.get(id);
    if (!pin || pin.owner !== member) return -GroupErrno.BADF;
    this.dropPin(pin);
    return 0;
  }

  private dropPin(pin: Pin): void {
    this.pins.delete(pin.id);
    pin.region.pins--;
    this.maybeFree(pin.region);
  }

  private maybeFree(region: Region): void {
    if (region.holders.size || region.pins) return;
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

  /** Physical stop or a launch that never constructed an agent. Runs once per incarnation. */
  private release(member: Member): void {
    if (this.members[member.index] !== member) return;
    member.phase = "released";
    // Pins whose delivery this member owned have no remaining consumer.
    for (const pin of Array.from(this.pins.values())) if (pin.owner === member) this.dropPin(pin);
    for (const handle of member.holds.keys()) {
      const region = this.regions.get(handle)!;
      region.holders.delete(member);
      this.maybeFree(region);
    }
    member.holds.clear();
    for (const chunk of member.chunks) this.free.give(chunk.page, chunk.pages);
    member.chunks.length = 0;
    this.clearWatches(member.index);
    member.port?.close();
    this.members[member.index] = undefined;
    if (this.members.every((other) => other === undefined)) this.end();
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    this.reconcile();
    this.budget.release(this.charged);
    if (this.backing) this.source?.retire(this.backing);
    this.onEnd(this);
  }
}

/** The page's groups, their shared W3 budget and policy. */
export class MemoryGroups {
  readonly policy: MemoryGroupPolicy;
  readonly budget: GroupBackingBudget;
  private readonly groups = new Map<string, MemoryGroupOwner>();
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
  ): MemberLease {
    if (join === "new") {
      if (this.groups.size >= this.policy.groups)
        throw new ProcessError(ProcessErrno.AGAIN, "memory group limit reached");
      const id = `g${this.nextId++}`;
      const shape = this.sizing?.groupShape(this.explicitMaximum);
      const backing = shape ? this.memories?.create(shape, headroom) : undefined;
      const group = new MemoryGroupOwner(
        id,
        directory,
        this.policy,
        this.budget,
        (ended) => {
          this.groups.delete(ended.id);
        },
        this.memories,
        backing,
      );
      this.groups.set(id, group);
      this.owners.set(group.handle, group);
      return group.reserve(pid);
    }
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
  snapshot(): readonly MemoryGroupSnapshot[] {
    return Array.from(this.groups.values(), (group) => group.snapshot());
  }
  unsettled(): number {
    let count = 0;
    for (const group of this.groups.values()) count += group.unsettled();
    return count;
  }
}
