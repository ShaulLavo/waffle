import {
  atomicsAdd,
  atomicsCompareExchange,
  atomicsLoad,
  atomicsNotify,
  atomicsStore,
  atomicsWait,
  BigInt64ArrayConstructor,
  Int32ArrayConstructor,
  dataViewSetUint32,
  mapDelete,
  mapGet,
  mapSet,
  DataViewConstructor,
  objectKeys,
  reflectApply,
  sharedArrayBufferByteLength,
  typedArrayLength,
  Uint8ArrayConstructor,
} from "../proc/intrinsics.js";
import {
  GroupErrno,
  GroupOp,
  PAGE_BYTES,
  WATCH_HEADER_WORDS,
  WATCH_SLOT_WORDS,
  type MemoryGroupMemberRequest,
} from "./protocol.js";

// Captured before any guest code runs in this worker.
const postPort = MessagePort.prototype.postMessage;
const closePort = MessagePort.prototype.close;
const customSections = WebAssembly.Module.customSections;
const moduleImports = WebAssembly.Module.imports;
const NativeTable = WebAssembly.Table;
const NativeGlobal = WebAssembly.Global;
const memoryBuffer = Object.getOwnPropertyDescriptor(WebAssembly.Memory.prototype, "buffer")!.get!;
const { ceil, max, min } = Math;
const toNumber = Number;
const asIntN = BigInt.asIntN;

// group_grow serves sbrk from a member-owned lease, so most calls need no owner round trip.
// Unused lease pages stay charged to the member until its physical stop.
const LEASE_MIN = 16,
  LEASE_MAX = 64;

/** Memory-info (subsection 1) of a `dylink.0` payload. The full validator lives in waffle/link. */
function memoryInfo(payload: Uint8Array) {
  let at = 0;
  const u32 = (): number => {
    let result = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const byte = payload[at++];
      if (byte === undefined) throw new TypeError("truncated dylink.0 section");
      result += (byte & 127) * 2 ** shift;
      if (byte < 128) return result;
    }
    throw new TypeError("invalid dylink.0 integer");
  };
  while (at < typedArrayLength(payload)) {
    const kind = u32(),
      size = u32(),
      end = at + size;
    if (kind === 1) {
      const info = {
        memorySize: u32(),
        memoryAlignment: u32(),
        tableSize: u32(),
        tableAlignment: u32(),
      };
      if (at !== end || info.memoryAlignment > 31 || info.tableAlignment > 31)
        throw new TypeError("invalid dylink.0 memory-info");
      return info;
    }
    at = end;
  }
  throw new TypeError("dylink.0 lacks memory-info");
}

export interface GroupMemberHooks {
  checkActive(): void;
  /** Wakes every poller of this member's process directory after a watch is hit. */
  wake?(): void;
}

export interface GroupMember {
  readonly memory: WebAssembly.Memory;
  /** The runtime_shm namespace. */
  readonly imports: Record<string, (...args: any[]) => number>;
  /** The runtime_shm namespace, keyed for Wasi namespaces. */
  readonly namespaces: WebAssembly.Imports;
  /** Bindings for a PIE image, including the member-owned carved stack bounds. */
  bindings(module: WebAssembly.Module): {
    env: WebAssembly.ModuleImports;
    "GOT.mem": WebAssembly.ModuleImports;
  };
  /** Poll kind 7 readiness, or undefined for an unknown watch. */
  watchReady(id: number): boolean | undefined;
  dispose(): void;
}

interface Watch {
  readonly slot: number;
  readonly addr: number;
  readonly expected: number;
  /** Registration sequence; the slot's pending word holds it until the first wake hit. */
  readonly tag: number;
}

/** Worker side of one member incarnation. Owner state stays on the page; see group/state.ts. */
export function createGroupMember(
  request: MemoryGroupMemberRequest,
  hooks: GroupMemberHooks,
): GroupMember {
  const { memory, port } = request;
  const reply = new Int32ArrayConstructor(request.reply);
  const table = new Int32ArrayConstructor(request.control);
  const watches = new Map<number, Watch>();
  let seq = 0;
  let lease = { page: 0, pages: 0 },
    leaseSize = LEASE_MIN;
  let disposed = false;

  const buffer = (): SharedArrayBuffer => reflectApply(memoryBuffer, memory, []);
  const bytes = () => sharedArrayBufferByteLength(buffer());
  const words = () => new Int32ArrayConstructor(buffer());
  const call = (op: number, a = 0, b = 0, c = 0): number[] => {
    hooks.checkActive();
    if (disposed) return [-GroupErrno.BADF];
    const sent = (seq = (seq % 0x7fffffff) + 1);
    reflectApply(postPort, port, [{ seq: sent, op, args: [a >>> 0, b >>> 0, c >>> 0] }]);
    for (;;) {
      const current = atomicsLoad(reply, 0);
      if (current === sent) break;
      atomicsWait(reply, 0, current, 50);
      hooks.checkActive();
    }
    return [
      atomicsLoad(reply, 1),
      atomicsLoad(reply, 2),
      atomicsLoad(reply, 3),
      atomicsLoad(reply, 4),
    ];
  };
  const inBounds = (addr: number, size: number) => addr % size === 0 && addr + size <= bytes();
  /** An aligned, in-bounds output span of `count` u32 words, checked before any mutation. */
  const span = (out: number, count: number): boolean =>
    (out >>> 0) % 4 === 0 && (out >>> 0) + count * 4 <= bytes();
  /** Writes values[from..from+count) as little-endian u32 at a span already checked. */
  const write = (out: number, values: readonly number[], from: number, count: number): void => {
    const data = new DataViewConstructor(buffer());
    for (let index = 0; index < count; index++)
      dataViewSetUint32(data, (out >>> 0) + index * 4, values[from + index]! >>> 0, true);
  };
  /** Validates the output span first, so a bad pointer leaves owner state untouched. */
  const answer = (out: number, count: number, op: number, a: number, b = 0): number => {
    if (!span(out, count)) return -GroupErrno.INVAL;
    const values = call(op, a, b);
    if (values[0]! < 0) return values[0]!;
    write(out, values, 1, count);
    return 0;
  };
  const chunk = (pages: number): number => call(GroupOp.GROW, pages)[0]!;
  const timeout = (ns: bigint): number => (ns < 0n ? Infinity : toNumber(ns) / 1e6);
  const status = (value: string): number => (value === "ok" ? 0 : value === "not-equal" ? 1 : 2);

  /** The oldest still-pending live watch on addr, or -1. A hit watch is never reselected. */
  const nextWatch = (addr: number): number => {
    let found = -1,
      lowest = Infinity;
    for (let slot = 0; slot < request.watches; slot++) {
      const at = WATCH_HEADER_WORDS + slot * WATCH_SLOT_WORDS;
      if ((atomicsLoad(table, at) & 1) === 0 || atomicsLoad(table, at + 1) !== addr) continue;
      const pending = atomicsLoad(table, at + 3);
      if (pending === 0 || pending >= lowest) continue;
      found = at;
      lowest = pending;
    }
    return found;
  };
  /** Sync waiters first, then watchers in registration order; each hit is claimed once. */
  const wakeWatchers = (addr: number, budget: number): number => {
    let woken = 0;
    while (woken < budget) {
      const at = nextWatch(addr);
      if (at < 0) break;
      const pending = atomicsLoad(table, at + 3);
      // A concurrent waker or a re-registration changed the slot: select again.
      if (pending !== 0 && atomicsCompareExchange(table, at + 3, pending, 0) === pending) woken++;
    }
    if (woken) hooks.wake?.();
    return woken;
  };

  const imports = {
    group_grow(pages: number): number {
      pages >>>= 0;
      if (pages === 0) return -GroupErrno.INVAL;
      if (pages > lease.pages) {
        const wanted = max(pages, leaseSize);
        let page = chunk(wanted);
        let granted = wanted;
        if (page < 0 && wanted > pages) {
          page = chunk(pages);
          granted = pages;
        }
        if (page < 0) return page;
        lease = { page, pages: granted };
        leaseSize = min(LEASE_MAX, leaseSize * 2);
      }
      const page = lease.page;
      lease = { page: page + pages, pages: lease.pages - pages };
      return page;
    },
    shm_create(len: number, align: number, out: number): number {
      return answer(out, 2, GroupOp.CREATE, len, align);
    },
    shm_attach(handle: number, out: number): number {
      return answer(out, 1, GroupOp.ATTACH, handle);
    },
    shm_detach(handle: number): number {
      return call(GroupOp.DETACH, handle)[0]!;
    },
    shm_pin(handle: number, out: number): number {
      return answer(out, 1, GroupOp.PIN, handle);
    },
    shm_route(pin: number, pid: number): number {
      return call(GroupOp.ROUTE, pin, pid)[0]!;
    },
    shm_accept(pin: number, out: number): number {
      return answer(out, 3, GroupOp.ACCEPT, pin);
    },
    shm_unpin(pin: number): number {
      return call(GroupOp.UNPIN, pin)[0]!;
    },
    futex_wait32(addr: number, expected: number, ns: bigint): number {
      hooks.checkActive();
      addr >>>= 0;
      if (!inBounds(addr, 4)) return -GroupErrno.INVAL;
      // A hard stop of this agent is the cancellation path: V8 drops the waiter with the agent.
      return status(atomicsWait(words(), addr / 4, expected | 0, timeout(ns)));
    },
    futex_wait64(addr: number, expected: bigint, ns: bigint): number {
      hooks.checkActive();
      addr >>>= 0;
      if (!inBounds(addr, 8)) return -GroupErrno.INVAL;
      const cells = new BigInt64ArrayConstructor(buffer());
      return status(
        atomicsWait(cells as never, addr / 8, asIntN(64, expected) as never, timeout(ns)),
      );
    },
    futex_wake(addr: number, count: number): number {
      hooks.checkActive();
      addr >>>= 0;
      count >>>= 0;
      if (!inBounds(addr, 4)) return -GroupErrno.INVAL;
      const woken = atomicsNotify(words(), addr / 4, count === 0xffffffff ? Infinity : count);
      const remaining = count === 0xffffffff ? Infinity : count - woken;
      return woken + (remaining > 0 ? wakeWatchers(addr, remaining) : 0);
    },
    futex_watch(addr: number, expected: number, out: number): number {
      hooks.checkActive();
      addr >>>= 0;
      if (!inBounds(addr, 4) || !span(out, 1)) return -GroupErrno.INVAL;
      const claim = (request.index + 1) << 1;
      for (let slot = 0; slot < request.watches; slot++) {
        const at = WATCH_HEADER_WORDS + slot * WATCH_SLOT_WORDS;
        if (atomicsCompareExchange(table, at, 0, claim) !== 0) continue;
        // Nonzero, unique per registration: wakers claim a hit by swapping it to zero.
        const tag = (atomicsAdd(table, 0, 1) + 1) & 0x7fffffff || 1;
        atomicsStore(table, at + 1, addr);
        atomicsStore(table, at + 2, tag);
        atomicsStore(table, at + 3, tag);
        atomicsStore(table, at, claim | 1);
        const id = slot + 1;
        mapSet(watches, id, { slot, addr, expected: expected | 0, tag });
        write(out, [id], 0, 1);
        return 0;
      }
      return -GroupErrno.AGAIN;
    },
    futex_unwatch(id: number): number {
      hooks.checkActive();
      const watch = mapGet(watches, id >>> 0);
      if (!watch) return -GroupErrno.BADF;
      mapDelete(watches, id >>> 0);
      const at = WATCH_HEADER_WORDS + watch.slot * WATCH_SLOT_WORDS;
      atomicsStore(table, at + 1, 0);
      atomicsStore(table, at, 0);
      return 0;
    },
    parallelism(): number {
      return request.parallelism;
    },
  };

  return {
    memory,
    imports,
    namespaces: { runtime_shm: imports },
    bindings: (module) => image(module),
    watchReady,
    dispose() {
      if (disposed) return;
      disposed = true;
      reflectApply(closePort, port, []);
    },
  };

  function image(module: WebAssembly.Module): {
    env: WebAssembly.ModuleImports;
    "GOT.mem": WebAssembly.ModuleImports;
  } {
    const sections = reflectApply(customSections, WebAssembly.Module, [module, "dylink.0"]);
    if (sections.length !== 1)
      throw new TypeError("memory group image requires one dylink.0 section");
    const info = memoryInfo(new Uint8ArrayConstructor(sections[0]!));
    if (info.memoryAlignment > 16) throw new TypeError("member data alignment exceeds a page");
    const dataPages = max(1, ceil(info.memorySize / PAGE_BYTES));
    const stackPages = ceil(request.stackBytes / PAGE_BYTES);
    const data = chunk(dataPages);
    if (data < 0) throw new RangeError("memory group could not carve member data");
    const stack = chunk(stackPages);
    if (stack < 0) throw new RangeError("memory group could not carve member stack");
    // Slot 0 stays null so a zero function pointer never calls into the image.
    const alignment = 2 ** info.tableAlignment;
    const tableBase = ceil(1 / alignment) * alignment;
    const env: WebAssembly.ModuleImports = {
      memory,
      __indirect_function_table: new NativeTable({
        element: "anyfunc",
        initial: tableBase + info.tableSize,
      }),
      __memory_base: new NativeGlobal({ value: "i32", mutable: false }, data * PAGE_BYTES),
      __table_base: new NativeGlobal({ value: "i32", mutable: false }, tableBase),
      __stack_pointer: new NativeGlobal(
        { value: "i32", mutable: true },
        (stack + stackPages) * PAGE_BYTES,
      ),
    };
    const got: WebAssembly.ModuleImports = Object.create(null);
    const wanted = new Set(
      reflectApply(moduleImports, WebAssembly.Module, [module])
        .filter((entry) => entry.module === "env" || entry.module === "GOT.mem")
        .map((entry) => `${entry.module}.${entry.name}`),
    );
    for (const name of objectKeys(env)) if (!wanted.has(`env.${name}`)) delete env[name];
    const stackLow = stack * PAGE_BYTES;
    const stackHigh = (stack + stackPages) * PAGE_BYTES;
    if (wanted.has("GOT.mem.__stack_low"))
      got.__stack_low = new NativeGlobal({ value: "i32", mutable: true }, stackLow);
    if (wanted.has("GOT.mem.__stack_high"))
      got.__stack_high = new NativeGlobal({ value: "i32", mutable: true }, stackHigh);
    return { env, "GOT.mem": got };
  }

  function watchReady(id: number): boolean | undefined {
    const watch = mapGet(watches, id);
    if (!watch) return undefined;
    const at = WATCH_HEADER_WORDS + watch.slot * WATCH_SLOT_WORDS;
    if (atomicsLoad(table, at + 3) !== watch.tag) return true;
    return atomicsLoad(words(), watch.addr / 4) !== watch.expected;
  }
}
