import { DescriptorTable } from "../../core/descriptors.js";
import {
  FilesystemClient,
  FilesystemError,
  MissingSegmentError,
  type FilesystemConnection,
} from "../../fs/index.js";
import { fileOnlyABI } from "./file-only-abi.js";

/** A real guest Worker for the lazy-backing tests. After it starts it never returns to its
 * event loop: a timer, a canary message and every segment announcement stay queued, as they do
 * for a guest blocked inside WebAssembly. `turns` counts any that ran anyway. */
export type GuestMode =
  | "blocked-reader"
  | "revoked-reader"
  | "abi-write"
  | "abi-append"
  | "owner-read"
  | "owner-read-shrink"
  | "owner-read-race"
  | "owner-read-later-error"
  | "owner-read-first-error";
export interface GuestStart {
  connection: FilesystemConnection;
  /** Word 0: the guest's progress. Word 1: the page's gate. */
  cells: SharedArrayBuffer;
  mode: GuestMode;
  path: string;
}
const PROGRESS = 0;
const GATE = 1;
const PAGE = 4096;
let turns = 0;

/** Tells the page where the guest is, then blocks until the page opens the gate. */
function park(cells: Int32Array, progress: number): void {
  Atomics.store(cells, PROGRESS, progress);
  Atomics.notify(cells, PROGRESS);
  Atomics.wait(cells, GATE, 0);
  Atomics.store(cells, GATE, 0);
}

function open(start: GuestStart) {
  const fs = new FilesystemClient(start.connection);
  const root = fs.preopen("/");
  const path = fs.resolve(root, start.path);
  if (typeof path === "number" || path.node === undefined) throw new Error("missing target file");
  fs.retain(path.node);
  return { fs, node: path.node };
}

function recordOperations(fs: FilesystemClient): string[] {
  const operations: string[] = [];
  const submit = fs.submit.bind(fs);
  fs.submit = (...args) => {
    operations.push(args[0]);
    return submit(...args);
  };
  return operations;
}

function blockedReader(start: GuestStart) {
  const cells = new Int32Array(start.cells);
  const { fs, node } = open(start);
  let missing = 0;
  const directRead = fs.shared.directRead.bind(fs.shared);
  fs.shared.directRead = (...args) => {
    try {
      return directRead(...args);
    } catch (error) {
      if (error instanceof MissingSegmentError) missing++;
      throw error;
    }
  };
  const operations = recordOperations(fs);
  const attachedBefore = fs.shared.segments.length;
  park(cells, 1);
  const turnsAfterWake = turns;
  if (start.mode === "revoked-reader") {
    const untouched = new Uint8Array(16).fill(9);
    const revokedRead = fs.read(node, [untouched], 0);
    return { revokedRead, untouched: untouched.every((byte) => byte === 9), turnsAfterWake, turns };
  }
  const first = new Uint8Array(PAGE);
  const firstCount = fs.read(node, [first], 0);
  const head = new Uint8Array(100_000);
  const rest = new Uint8Array(120_000);
  const largeCount = fs.read(node, [head, rest], 0);
  const written = fs.write(node, [new Uint8Array(PAGE).fill(0x5a)], PAGE * 2);
  const appended = fs.append(node, [new Uint8Array(3).fill(0x5b)]);
  const reread = new Uint8Array(4);
  const rereadCount = fs.read(node, [reread], PAGE * 2);
  return {
    firstCount,
    firstValue: first[PAGE - 1],
    largeCount,
    largeHead: head[99_999],
    largeRest: [rest[0], rest[119_999]],
    written,
    appended,
    reread: Array.from(reread.subarray(0, rereadCount)),
    missing,
    operations,
    attachedBefore,
    attachedAfter: fs.shared.segments.length,
    turnsAfterWake,
    turns,
  };
}

/** The runtime_proc ABI over a file whose pages are in a segment this guest lacks. */
function abiWrite(start: GuestStart) {
  const append = start.mode === "abi-append";
  const { fs, node } = open(start);
  fs.call = () => {
    throw new Error("runtime_proc made a blocking filesystem RPC");
  };
  const descriptors = new DescriptorTable();
  const memory = new WebAssembly.Memory({ initial: 4 });
  const fd = descriptors.open(
    { kind: "file", handle: node, offset: append ? 0 : PAGE, append },
    (1n << 29n) - 1n,
    0n,
  );
  const wake = new Int32Array(start.connection.signal);
  let waits = 0;
  const abi = fileOnlyABI({
    memory,
    descriptors,
    fs,
    wake,
    wait(milliseconds) {
      if (waits++ === 0) self.postMessage({ phase: "polling" });
      Atomics.wait(wake, 0, Atomics.load(wake, 0), milliseconds);
    },
  });
  const offset = () => {
    const resource = descriptors.get(fd)!.resource;
    return resource.kind === "file" ? resource.offset : -1;
  };
  try {
    new Uint8Array(memory.buffer, 4096, PAGE).fill(0x71);
    const first = abi.imports.write!(fd, 4096, PAGE);
    const firstOffset = offset();
    const view = new DataView(memory.buffer);
    view.setUint32(256, 1, true);
    view.setUint32(260, fd, true);
    view.setBigUint64(264, 77n, true);
    const ready = abi.imports.poll!(256, 1, 8000, 512);
    const second = abi.imports.write!(fd, 4096, PAGE);
    return {
      first,
      firstOffset,
      ready,
      second,
      offset: offset(),
      waits,
      attached: fs.shared.segments.length,
      turns,
    };
  } finally {
    descriptors.dispose();
  }
}

/** A blocking read larger than one transport page, with a chosen interference point. */
function ownerRead(start: GuestStart) {
  const cells = new Int32Array(start.cells);
  const { fs, node } = open(start);
  const call = fs.call.bind(fs);
  let reads = 0;
  fs.call = (operation, args, data) => {
    if (operation !== "read") return call(operation, args, data);
    reads++;
    if (start.mode === "owner-read-first-error" && reads === 1) throw new FilesystemError(29);
    if (start.mode === "owner-read-later-error" && reads === 2) throw new FilesystemError(29);
    const reply = call(operation, args, data);
    // The page changes the file here: after the owner's reply, before the revision is checked.
    if (start.mode === "owner-read-shrink" && reads === 2) park(cells, reads);
    if (start.mode === "owner-read-race" && reads === 1) park(cells, reads);
    return reply;
  };
  const first = new Uint8Array(100_000).fill(1);
  const second = new Uint8Array(120_000).fill(2);
  const count = fs.read(node, [first, second], 0);
  return {
    count,
    reads,
    first: [first[0], first[65_535], first[65_536], first[99_999]],
    second: [second[0], second[119_999]],
    attached: fs.shared.segments.length,
    turns,
  };
}

function run(start: GuestStart): unknown {
  if (start.mode === "blocked-reader" || start.mode === "revoked-reader")
    return blockedReader(start);
  if (start.mode === "abi-write" || start.mode === "abi-append") return abiWrite(start);
  return ownerRead(start);
}

self.onmessage = ({ data }: MessageEvent<GuestStart>) => {
  self.onmessage = () => {
    turns++;
  };
  setTimeout(() => turns++, 0);
  let result: unknown;
  try {
    result = { phase: "done", ...(run(data) as object) };
  } catch (error) {
    result = { phase: "error", error: String(error), stack: (error as Error)?.stack };
  }
  self.postMessage(result);
  // Hold the event loop shut until the page has read the result and allows teardown.
  Atomics.wait(new Int32Array(data.cells), GATE, 0);
  data.connection.port.onmessage = null;
  self.close();
};
