import {
  call,
  guestModule,
  i32,
  notify,
  store,
  wait32,
  wait32Result,
  wait64Result,
} from "./threads-guest-module.js";

export const spawnImport = { module: "wasi", name: "thread-spawn", params: [0x7f] };
const readImport = { name: "fd_read", params: [0x7f, 0x7f, 0x7f, 0x7f] };
const writeImport = { ...readImport, name: "fd_write" };
const exitImport = { name: "proc_exit", params: [0x7f], result: false };
const drop = [0x1a];
const local = (index: number) => [0x20, index];
const load = (address: number) => i32(address).concat([0x28, 2, 0]);
const loadFlag = (address: number) => i32(address).concat([0xfe, 0x10, 2, 0]);
function signal(address: number) {
  return i32(address).concat(i32(1), [0xfe, 0x17, 2, 0], notify(address));
}
function when(condition: number[], body: number[]) {
  return condition.concat([0x04, 0x40], body, [0x0b]);
}
function role(argument: number, body: number[]) {
  return when(local(1).concat(i32(argument), [0x46]), body.concat([0x0f]));
}
function requireEqual(value: number[], expected: number) {
  return when(value.concat(i32(expected), [0x47]), [0x00]);
}
function spawn(argument: number) {
  return i32(argument).concat(call(0));
}
function setupIo(iov: number, data: number, length: number) {
  return store(iov, i32(data)).concat(store(iov + 4, i32(length)));
}
function io(index: number, fd: number, iov: number, count: number) {
  return i32(fd).concat(i32(iov), i32(1), i32(count), call(index));
}
const waitHangCapNs = 60_000_000_000n;

export const fatalLayout = {
  main: 0,
  timer: 8,
  exit: 16,
  sentinels: 32,
  iov: 64,
  bytes: 72,
  count: 76,
} as const;

export function fatalThreadModule() {
  const p = fatalLayout;
  return guestModule({
    imports: [spawnImport, readImport, exitImport],
    initial: requireEqual(spawn(1), 2).concat(
      requireEqual(spawn(2), 3),
      requireEqual(spawn(3), 4),
      wait32(p.main),
      store(p.sentinels, i32(1)),
    ),
    secondary: role(
      1,
      setupIo(p.iov, p.bytes, 1).concat(
        io(1, 0, p.iov, p.count),
        drop,
        store(p.sentinels + 4, i32(1)),
      ),
    ).concat(
      role(2, wait64Result(p.timer, waitHangCapNs).concat(drop, store(p.sentinels + 8, i32(1)))),
      wait32(p.exit),
      i32(23),
      call(2),
      store(p.sentinels + 12, i32(1)),
    ),
  });
}

export const overlapLayout = {
  canaryGate: 0,
  finish: 4,
  waits: [8, 16],
  launchSecond: 24,
  results: [64, 72],
  canaryCount: 88,
} as const;

export function overlappingWaitModule() {
  const p = overlapLayout;
  return guestModule({
    imports: [spawnImport, writeImport],
    initial: requireEqual(spawn(1), 2).concat(
      wait32(p.launchSecond),
      requireEqual(spawn(2), 3),
      wait32(p.canaryGate),
      setupIo(96, 104, 1),
      store(104, i32(87)),
      requireEqual(io(1, 1, 96, p.canaryCount), 0),
      wait32(p.finish),
    ),
    secondary: role(
      1,
      store(p.results[0], wait32Result(p.waits[0], waitHangCapNs)).concat(
        store(p.results[0] + 4, wait32Result(p.waits[0], 1_000_000n)),
      ),
    ).concat(
      store(p.results[1], wait64Result(p.waits[1], waitHangCapNs)),
      store(p.results[1] + 4, wait64Result(p.waits[1], 1_000_000n)),
    ),
  });
}

export const admissionLayout = {
  holdStart: 0,
  startGate: 4,
  returnGate: 8,
  finish: 12,
  firstRefusal: 16,
  secondRefusal: 20,
  retry: 24,
  admitted: 28,
  pendingResult: 32,
  runningResult: 36,
  replacementResult: 40,
  returned: 44,
  replacementEntry: 48,
  canary: 52,
  canaryCount: 56,
} as const;

export function admissionThreadModule() {
  const p = admissionLayout;
  return guestModule({
    imports: [spawnImport, writeImport],
    start: when(loadFlag(p.holdStart), wait32(p.startGate)),
    initial: requireEqual(spawn(1), 2).concat(
      requireEqual(spawn(2), 3),
      signal(p.holdStart),
      store(p.admitted, spawn(3)),
      wait32(p.finish),
    ),
    secondary: role(
      1,
      wait32(p.firstRefusal).concat(
        store(p.pendingResult, spawn(5)),
        wait32(p.secondRefusal),
        store(p.runningResult, spawn(5)),
        wait32(p.retry),
        store(p.replacementResult, spawn(4)),
        wait32(p.finish),
      ),
    ).concat(
      role(2, wait32(p.returnGate).concat(signal(p.returned))),
      role(
        3,
        wait32(p.canary).concat(
          setupIo(96, 104, 1),
          store(104, i32(65)),
          requireEqual(io(1, 1, 96, p.canaryCount), 0),
          wait32(p.finish),
        ),
      ),
      role(4, store(p.replacementEntry, local(0)).concat(wait32(p.finish))),
      [0x00],
    ),
  });
}

export const maxThreadId = 0x1fffffff;
export const tidLayout = {
  gates: [0, 4, 8, 12],
  results: [16, 20, 24, 28],
  entries: [32, 36, 40, 44],
  finish: 48,
} as const;

export function threadIdModule() {
  const p = tidLayout;
  return guestModule({
    imports: [spawnImport],
    initial: p.gates
      .flatMap((gate, index) => wait32(gate).concat(store(p.results[index]!, spawn(index))))
      .concat(wait32(p.finish)),
    secondary: p.entries.flatMap((address, index) => role(index, store(address, local(0)))),
  });
}

const page = 65536;
export const growthLayout = {
  launch: 0,
  holdStart: 4,
  startWaiting: 8,
  startGate: 12,
  entryWaiting: 16,
  entryGate: 20,
  finished: 24,
  first: 2 * page + 64,
  second: 3 * page + 64,
} as const;
function grow(previous: number) {
  return requireEqual(i32(1).concat([0x40, 0]), previous);
}
function growthIo(address: number, pages: number, byte: number) {
  return requireEqual([0x3f, 0], pages).concat(
    requireEqual(load(address), byte),
    setupIo(address + 8, address, 1),
    requireEqual(io(1, 1, address + 8, address + 16), 0),
    requireEqual(load(address + 16), 1),
  );
}
export function receivingGrowthModule() {
  const p = growthLayout;
  return guestModule({
    imports: [spawnImport, writeImport],
    start: when(
      loadFlag(p.holdStart),
      signal(p.startWaiting).concat(wait32(p.startGate), growthIo(p.first, 3, 65)),
    ),
    initial: requireEqual(spawn(1), 2).concat(
      signal(p.holdStart),
      signal(p.launch),
      wait32(p.startWaiting),
      grow(2),
      store(p.first, i32(65)),
      signal(p.startGate),
      wait32(p.entryWaiting),
      grow(3),
      store(p.second, i32(66)),
      signal(p.entryGate),
      wait32(p.finished),
    ),
    secondary: role(1, wait32(p.launch).concat(requireEqual(spawn(2), 3))).concat(
      signal(p.entryWaiting),
      wait32(p.entryGate),
      growthIo(p.second, 4, 66),
    ),
  });
}
