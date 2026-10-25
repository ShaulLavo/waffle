import {
  OpenDescription,
  type Descriptor,
  type DescriptorTable,
  type Resource,
} from "../core/descriptors.js";
import { memoryViews } from "../core/memory-views.js";
import type { WorkerProcessClient } from "./worker-client.js";

const READ = 1n << 1n;
const WRITE = 1n << 6n;
const POLL = 1n << 27n;

export interface NodeWasiImports {
  wasi_snapshot_preview1: Record<string, (...args: number[]) => number>;
  [namespace: string]: WebAssembly.ModuleImports;
}

export type NodeWasiGuard = (fn: (...args: number[]) => number) => (...args: number[]) => number;

type NativeResource = Extract<Resource, { handle: number }> & { nodeWasiFd: number };

function isNativeResource(resource: Resource): resource is NativeResource {
  return "nodeWasiFd" in resource && Number.isInteger(resource.nodeWasiFd);
}

export function nodeWasiDescriptor(entry: Descriptor | undefined): number | undefined {
  if (!entry || !isNativeResource(entry.resource)) return undefined;
  return entry.resource.nodeWasiFd;
}

function translateDescriptorArguments(
  args: number[],
  indices: readonly number[],
  descriptors: DescriptorTable,
): number | undefined {
  for (const index of indices) {
    const fd = nodeWasiDescriptor(descriptors.get(args[index]! >>> 0));
    if (fd === undefined) return 8;
    args[index] = fd;
  }
}

/** One guest namespace owns both process capabilities and private Node WASI handles. Native
 * numbers never escape path_open or enter fd_renumber: even a reused native handle cannot alias
 * a pipe, and closing/replacing a guest binding releases only its own open description. */
export function installNodeWasiDescriptors(
  imports: NodeWasiImports,
  memory: () => WebAssembly.Memory,
  descriptors: DescriptorTable,
  preopenCount: number,
  client: WorkerProcessClient,
  isSignalPending: () => boolean,
  guard: NodeWasiGuard,
): void {
  const wasi = imports.wasi_snapshot_preview1;
  const original = { ...wasi };
  const views = () => memoryViews(memory());
  const native = (fd: number, directory: boolean): NativeResource =>
    directory
      ? { kind: "directory", handle: fd, nodeWasiFd: fd }
      : { kind: "file", handle: fd, nodeWasiFd: fd, offset: 0, append: false };
  const description = (fd: number, directory: boolean) =>
    new OpenDescription(native(fd, directory), () => {
      original.fd_close!(fd);
    });
  const all = (1n << 30n) - 1n;
  for (let index = 0; index < preopenCount; index++) {
    const fd = 3 + index;
    const opened = description(fd, true);
    let guest = fd;
    while (descriptors.get(guest)) guest++;
    descriptors.inherit(guest, {
      description: opened,
      resource: opened.resource,
      rightsBase: all,
      rightsInheriting: all,
    });
  }
  for (const [name, call] of Object.entries(original)) {
    const indices =
      name === "path_link"
        ? [0, 4]
        : name === "path_rename"
          ? [0, 3]
          : name === "path_symlink"
            ? [2]
            : name.startsWith("fd_") || name.startsWith("path_") || name.startsWith("sock_")
              ? [0]
              : [];
    if (!indices.length) continue;
    wasi[name] = guard((...args) => {
      const error = translateDescriptorArguments(args, indices, descriptors);
      if (error !== undefined) return error;
      return call(...args);
    });
  }
  if (original.path_open)
    wasi.path_open = guard((...args) => {
      const directory = nodeWasiDescriptor(descriptors.get(args[0]! >>> 0));
      if (directory === undefined) return 8;
      args[0] = directory;
      const result = original.path_open!(...args);
      if (result !== 0) return result;
      const ptr = args[8]!;
      const fd = views().view().getUint32(ptr, true);
      const opened = description(fd, (args[4]! & 2) !== 0);
      try {
        const guest = descriptors.add(opened, {
          rightsBase: BigInt(args[5]!),
          rightsInheriting: BigInt(args[6]!),
        });
        views().view().setUint32(ptr, guest, true);
        return 0;
      } catch (error) {
        if (!opened.references) original.fd_close!(fd);
        throw error;
      }
    });
  for (const operation of ["read", "write"] as const) {
    const name = `fd_${operation}`;
    const call = wasi[name]!;
    wasi[name] = guard((fd, ptr, count, result) => {
      const entry = descriptors.get(fd! >>> 0);
      if (!entry) return 8;
      if (nodeWasiDescriptor(entry) !== undefined) return call(fd!, ptr!, count!, result!);
      if ((entry.rightsBase & (operation === "read" ? READ : WRITE)) === 0n) return 76;
      const resource = entry.resource;
      if (resource.kind !== "pipe" && resource.kind !== "terminal") return 8;
      const view = views().view();
      const chunks = Array.from({ length: count! }, (_, index) =>
        views().range(
          view.getUint32(ptr! + index * 8, true),
          view.getUint32(ptr! + index * 8 + 4, true),
        ),
      );
      const bytes = resource[operation](chunks);
      if (bytes < 0) return -bytes;
      views().view().setUint32(result!, bytes, true);
      return 0;
    });
  }
  function getDescriptorMetadata(
    name: "fd_fdstat_get" | "fd_filestat_get",
    call: NodeWasiImports["wasi_snapshot_preview1"][string] | undefined,
    fd: number,
    ptr: number,
  ): number {
    const entry = descriptors.get(fd! >>> 0);
    if (!entry) return 8;
    if (nodeWasiDescriptor(entry) !== undefined) return call?.(fd!, ptr!) ?? 8;
    const resource = entry.resource;
    const nativeFd = "nativeFd" in resource ? resource.nativeFd : undefined;
    if (typeof nativeFd === "number") {
      const error = original[name]?.(nativeFd, ptr!) ?? 8;
      if (error !== 0 || name === "fd_filestat_get") return error;
    } else {
      views()
        .range(ptr!, name === "fd_fdstat_get" ? 24 : 64)
        .fill(0);
      views()
        .view()
        .setUint8(ptr! + (name === "fd_fdstat_get" ? 0 : 16), resource.kind === "pipe" ? 6 : 2);
    }
    const view = views().view();
    if (name === "fd_fdstat_get") {
      view.setBigUint64(ptr! + 8, entry.rightsBase, true);
      view.setBigUint64(ptr! + 16, entry.rightsInheriting, true);
    } else view.setBigUint64(ptr! + 24, 1n, true);
    return 0;
  }
  for (const name of ["fd_fdstat_get", "fd_filestat_get"] as const) {
    const call = wasi[name];
    wasi[name] = guard((fd, ptr) => getDescriptorMetadata(name, call, fd!, ptr!));
  }
  const setRights = wasi.fd_fdstat_set_rights;
  wasi.fd_fdstat_set_rights = guard((fd, base, inheriting) => {
    const entry = descriptors.get(fd! >>> 0);
    if (!entry) return 8;
    const rightsBase = BigInt(base!);
    const rightsInheriting = BigInt(inheriting!);
    if (
      (entry.rightsBase & rightsBase) !== rightsBase ||
      (entry.rightsInheriting & rightsInheriting) !== rightsInheriting
    )
      return 76;
    const result =
      nodeWasiDescriptor(entry) === undefined ? 0 : (setRights?.(fd!, base!, inheriting!) ?? 8);
    if (result === 0) {
      entry.rightsBase = rightsBase;
      entry.rightsInheriting = rightsInheriting;
    }
    return result;
  });
  const setFlags = wasi.fd_fdstat_set_flags;
  wasi.fd_fdstat_set_flags = guard((fd, flags) => {
    const entry = descriptors.get(fd! >>> 0);
    if (!entry) return 8;
    return nodeWasiDescriptor(entry) === undefined
      ? flags === 0
        ? 0
        : 58
      : (setFlags?.(fd!, flags!) ?? 8);
  });
  for (const name of ["fd_seek", "fd_tell", "fd_pread", "fd_pwrite"] as const) {
    const call = wasi[name];
    wasi[name] = guard((fd, ...args) => {
      const entry = descriptors.get(fd! >>> 0);
      if (!entry) return 8;
      return nodeWasiDescriptor(entry) === undefined ? 70 : (call?.(fd!, ...args) ?? 8);
    });
  }
  wasi.fd_close = guard((fd) => (descriptors.close(fd! >>> 0) ? 0 : 8));
  wasi.fd_renumber = guard((from, to) => (descriptors.renumber(from! >>> 0, to! >>> 0) ? 0 : 8));
  installPoll(wasi, original.poll_oneoff, memory, descriptors, client, isSignalPending, guard);
}

const monotonicNow = performance.now.bind(performance);
const realtimeNow = Date.now.bind(Date);

function installPoll(
  wasi: NodeWasiImports["wasi_snapshot_preview1"],
  nativePoll: ((...args: number[]) => number) | undefined,
  memory: () => WebAssembly.Memory,
  descriptors: DescriptorTable,
  client: WorkerProcessClient,
  isSignalPending: () => boolean,
  guard: NodeWasiGuard,
): void {
  type Subscription = { ptr: number; type: number; fd: number; userdata: bigint; deadline: number };
  type Views = ReturnType<typeof memoryViews>;
  type PollEvent = {
    error: number;
    ready: boolean;
    nbytes: bigint;
    hangup: boolean;
    remaining: number;
    nativeError: number;
  };
  type PollState = { emitted: number; timeout: number };
  function pollNative(
    items: Subscription[],
    views: Views,
    input: number,
    output: number,
    count: number,
    result: number,
  ): number {
    for (const item of items) {
      if (item.type === 0) continue;
      views.view().setUint32(item.ptr + 16, nodeWasiDescriptor(descriptors.get(item.fd))!, true);
    }
    try {
      return nativePoll!(input, output, count, result);
    } finally {
      for (const item of items) {
        if (item.type === 0) continue;
        views.view().setUint32(item.ptr + 16, item.fd, true);
      }
    }
  }
  function pollSubscription(
    item: Subscription,
    views: Views,
    at: number,
    result: number,
  ): PollEvent {
    const event = {
      error: 0,
      ready: true,
      nbytes: 0n,
      hangup: false,
      remaining: Infinity,
      nativeError: 0,
    };
    if (item.type === 0) {
      if (item.fd > 3) return { ...event, error: 28 };
      const remaining = item.deadline - monotonicNow();
      return { ...event, ready: remaining <= 0, remaining };
    }
    const entry = descriptors.get(item.fd);
    if (!entry) return { ...event, error: 8 };
    if ((entry.rightsBase & POLL) === 0n) return { ...event, error: 76 };
    const nativeFd = nodeWasiDescriptor(entry);
    if (nativeFd !== undefined) {
      views.view().setUint32(item.ptr + 16, nativeFd, true);
      try {
        event.nativeError = nativePoll?.(item.ptr, at, 1, result) ?? 52;
      } finally {
        views.view().setUint32(item.ptr + 16, item.fd, true);
      }
      if (event.nativeError) return event;
      event.ready = views.view().getUint32(result, true) !== 0;
      if (!event.ready) return event;
      const view = views.view();
      event.error = view.getUint16(at + 8, true);
      event.nbytes = view.getBigUint64(at + 16, true);
      event.hangup = (view.getUint16(at + 24, true) & 1) !== 0;
      return event;
    }
    if (entry.resource.kind !== "pipe" && entry.resource.kind !== "terminal")
      return { ...event, error: 8 };
    const state = entry.resource.readiness();
    return {
      ...event,
      ready: item.type === 1 ? state.readable || state.hangup : state.writable || state.hangup,
      hangup: state.hangup,
      nbytes: item.type === 1 ? BigInt(state.nbytes ?? 0) : 0n,
    };
  }
  function emitPollEvent(item: Subscription, event: PollEvent, views: Views, ptr: number): void {
    views.range(ptr, 32).fill(0);
    const view = views.view();
    view.setBigUint64(ptr, item.userdata, true);
    view.setUint16(ptr + 8, event.error, true);
    view.setUint8(ptr + 10, item.type);
    view.setBigUint64(ptr + 16, BigInt(event.nbytes), true);
    view.setUint16(ptr + 24, event.hangup ? 1 : 0, true);
  }
  function emitPollSubscription(
    item: Subscription,
    views: Views,
    output: number,
    result: number,
    state: PollState,
  ): number {
    const event = pollSubscription(item, views, output + state.emitted * 32, result);
    if (event.nativeError) return event.nativeError;
    state.timeout = Math.min(state.timeout, event.remaining);
    if (!event.ready) return 0;
    emitPollEvent(item, event, views, output + state.emitted++ * 32);
    return 0;
  }
  wasi.poll_oneoff = guard((input, output, count, result) => {
    if (!count) return 28;
    if (isSignalPending()) return 27;
    const views = memoryViews(memory());
    views.range(input!, count! * 48);
    views.range(output!, count! * 32);
    views.range(result!, 4);
    const initial = views.view();
    const subscriptions = Array.from({ length: count! }, (_, index) => {
      const ptr = input! + index * 48;
      const type = initial.getUint8(ptr + 8);
      const fd = initial.getUint32(ptr + 16, true);
      const delay = Number(initial.getBigUint64(ptr + 24, true)) / 1e6;
      const absolute = (initial.getUint16(ptr + 40, true) & 1) !== 0;
      const clock = initial.getUint32(ptr + 16, true);
      return {
        ptr,
        type,
        fd,
        userdata: initial.getBigUint64(ptr, true),
        deadline: absolute
          ? monotonicNow() + delay - (clock === 0 ? realtimeNow() : monotonicNow())
          : monotonicNow() + delay,
      };
    });
    if (subscriptions.some((item) => item.type > 2)) return 28;
    if (
      nativePoll &&
      subscriptions.some((item) => item.type !== 0) &&
      subscriptions.every(
        (item) => item.type === 0 || nodeWasiDescriptor(descriptors.get(item.fd)) !== undefined,
      )
    )
      return pollNative(subscriptions, views, input!, output!, count!, result!);
    for (;;) {
      const expected = Atomics.load(client.wake, 0);
      guard(() => 0)();
      if (isSignalPending()) return 27;
      const state = { emitted: 0, timeout: Infinity };
      for (const item of subscriptions) {
        const nativeError = emitPollSubscription(item, views, output!, result!, state);
        if (nativeError) return nativeError;
      }
      if (state.emitted) {
        views.view().setUint32(result!, state.emitted, true);
        return 0;
      }
      Atomics.wait(client.wake, 0, expected, Math.max(0, Math.min(state.timeout, 10)));
    }
  });
}
