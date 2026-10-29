import {
  atomicsAdd,
  atomicsCompareExchange,
  atomicsLoad,
  atomicsNotify,
  atomicsStore,
  atomicsWait,
  BigInt64ArrayConstructor,
  Int32ArrayConstructor,
  reflectApply,
} from "../proc/intrinsics.js";
import { dylinkMemoryInfo } from "../link/metadata.js";
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
const NativeUint8Array = Uint8Array;
const NativeDataView = DataView;

const LEASE_MIN = 16,
  LEASE_MAX = 256;

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
  /** env bindings for a PIE image: imported memory, own table, bases and stack. */
  bindings(module: WebAssembly.Module): { env: WebAssembly.ModuleImports };
  /** Poll kind 7 readiness, or undefined for an unknown watch. */
  watchReady(id: number): boolean | undefined;
  dispose(): void;
}

interface Watch {
  readonly slot: number;
  readonly addr: number;
  readonly expected: number;
  readonly generation: number;
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

  const words = () => new Int32ArrayConstructor(memory.buffer);
  const view = () => new NativeDataView(memory.buffer);
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
  const inBounds = (addr: number, size: number) =>
    addr % size === 0 && addr + size <= memory.buffer.byteLength;
  const write = (out: number, values: readonly number[]): boolean => {
    if (!inBounds(out, 4) || out + values.length * 4 > memory.buffer.byteLength) return false;
    const data = view();
    for (let index = 0; index < values.length; index++)
      data.setUint32(out + index * 4, values[index]! >>> 0, true);
    return true;
  };
  const result = (values: number[], out: number, count: number): number => {
    if (values[0]! < 0) return values[0]!;
    return write(out, values.slice(1, 1 + count)) ? 0 : -GroupErrno.INVAL;
  };
  const chunk = (pages: number): number => call(GroupOp.GROW, pages)[0]!;
  const timeout = (ns: bigint): number => (ns < 0n ? Infinity : Number(ns) / 1e6);
  const status = (value: string): number => (value === "ok" ? 0 : value === "not-equal" ? 1 : 2);

  /** Sync waiters first, then watchers in registration order. */
  const wakeWatchers = (addr: number, budget: number): number => {
    const hits: { at: number; seq: number }[] = [];
    for (let slot = 0; slot < request.watches; slot++) {
      const at = WATCH_HEADER_WORDS + slot * WATCH_SLOT_WORDS;
      if ((atomicsLoad(table, at) & 1) === 0 || atomicsLoad(table, at + 1) !== addr) continue;
      hits.push({ at, seq: atomicsLoad(table, at + 2) });
    }
    hits.sort((left, right) => left.seq - right.seq);
    const woken = hits.slice(0, budget);
    for (const hit of woken) atomicsAdd(table, hit.at + 3, 1);
    if (woken.length) hooks.wake?.();
    return woken.length;
  };

  const imports = {
    group_grow(pages: number): number {
      pages >>>= 0;
      if (pages === 0) return -GroupErrno.INVAL;
      if (pages > lease.pages) {
        const wanted = Math.max(pages, leaseSize);
        let page = chunk(wanted);
        let granted = wanted;
        if (page < 0 && wanted > pages) {
          page = chunk(pages);
          granted = pages;
        }
        if (page < 0) return page;
        lease = { page, pages: granted };
        leaseSize = Math.min(LEASE_MAX, leaseSize * 2);
      }
      const page = lease.page;
      lease = { page: page + pages, pages: lease.pages - pages };
      return page;
    },
    shm_create(len: number, align: number, out: number): number {
      return result(call(GroupOp.CREATE, len, align), out, 2);
    },
    shm_attach(handle: number, out: number): number {
      return result(call(GroupOp.ATTACH, handle), out, 1);
    },
    shm_detach(handle: number): number {
      return call(GroupOp.DETACH, handle)[0]!;
    },
    shm_pin(handle: number, out: number): number {
      return result(call(GroupOp.PIN, handle), out, 1);
    },
    shm_route(pin: number, pid: number): number {
      return call(GroupOp.ROUTE, pin, pid)[0]!;
    },
    shm_accept(pin: number, out: number): number {
      return result(call(GroupOp.ACCEPT, pin), out, 3);
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
      const cells = new BigInt64ArrayConstructor(memory.buffer);
      return status(
        atomicsWait(cells as never, addr / 8, BigInt.asIntN(64, expected) as never, timeout(ns)),
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
      if (!inBounds(addr, 4) || !inBounds(out >>> 0, 4)) return -GroupErrno.INVAL;
      const claim = (request.index + 1) << 1;
      for (let slot = 0; slot < request.watches; slot++) {
        const at = WATCH_HEADER_WORDS + slot * WATCH_SLOT_WORDS;
        if (atomicsCompareExchange(table, at, 0, claim) !== 0) continue;
        atomicsStore(table, at + 1, addr);
        atomicsStore(table, at + 2, atomicsAdd(table, 0, 1));
        const generation = atomicsLoad(table, at + 3);
        atomicsStore(table, at, claim | 1);
        const id = slot + 1;
        watches.set(id, { slot, addr, expected: expected | 0, generation });
        write(out >>> 0, [id]);
        return 0;
      }
      return -GroupErrno.AGAIN;
    },
    futex_unwatch(id: number): number {
      hooks.checkActive();
      const watch = watches.get(id >>> 0);
      if (!watch) return -GroupErrno.BADF;
      watches.delete(id >>> 0);
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
    bindings: (module) => ({ env: image(module) }),
    watchReady,
    dispose() {
      if (disposed) return;
      disposed = true;
      reflectApply(closePort, port, []);
    },
  };

  function image(module: WebAssembly.Module): WebAssembly.ModuleImports {
    const sections = reflectApply(customSections, WebAssembly.Module, [module, "dylink.0"]);
    if (sections.length !== 1)
      throw new TypeError("memory group image requires one dylink.0 section");
    const info = dylinkMemoryInfo(new NativeUint8Array(sections[0]!), "member");
    if (info.memoryAlignment > 16) throw new TypeError("member data alignment exceeds a page");
    const dataPages = Math.max(1, Math.ceil(info.memorySize / PAGE_BYTES));
    const stackPages = Math.ceil(request.stackBytes / PAGE_BYTES);
    const data = chunk(dataPages);
    if (data < 0) throw new RangeError("memory group could not carve member data");
    const stack = chunk(stackPages);
    if (stack < 0) throw new RangeError("memory group could not carve member stack");
    // Slot 0 stays null so a zero function pointer never calls into the image.
    const alignment = 2 ** info.tableAlignment;
    const tableBase = Math.ceil(1 / alignment) * alignment;
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
    const wanted = new Set(
      reflectApply(moduleImports, WebAssembly.Module, [module])
        .filter((entry) => entry.module === "env")
        .map((entry) => entry.name),
    );
    for (const name of Object.keys(env)) if (!wanted.has(name)) delete env[name];
    return env;
  }

  function watchReady(id: number): boolean | undefined {
    const watch = watches.get(id);
    if (!watch) return undefined;
    const at = WATCH_HEADER_WORDS + watch.slot * WATCH_SLOT_WORDS;
    if (atomicsLoad(table, at + 3) !== watch.generation) return true;
    return atomicsLoad(words(), watch.addr / 4) !== watch.expected;
  }
}
