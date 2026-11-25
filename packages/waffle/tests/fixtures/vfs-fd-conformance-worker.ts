import { DescriptorTable } from "../../core/descriptors.js";
import { withFileOffset } from "../../core/open-file.js";
import { Wasi } from "../../core/wasi.js";
import { drainDiagnostic } from "../../browser/diagnostic.js";
import { FilesystemClient, type FilesystemConnection } from "../../fs/index.js";
import { PAGE } from "../../fs/protocol.js";
import { ProcessABI } from "../../proc/abi.js";
import { controlWait } from "../../proc/control.js";
import { ExecutableRegistry } from "../../proc/registry.js";
import { ProcessSupervisor } from "../../proc/supervisor.js";
import { guestFunction, guestModule } from "./publication-wasm.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ALL_RIGHTS = (1n << 29n) - 1n;
const RIGHT_READ = 1n << 1n;
const RIGHT_WRITE = 1n << 6n;
const RIGHT_POLL = 1n << 27n;
const OFLAG_CREAT = 1;
const OFLAG_EXCL = 4;
const OFLAG_TRUNC = 8;
const FDFLAG_APPEND = 1;
const FDFLAG_NONBLOCK = 4;

interface WorkerRequest {
  readonly scenario: "wasi-fd" | "proc-redirection" | "poll-wake" | "diagnostic";
  readonly connection: FilesystemConnection;
  readonly seedText?: string;
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected)
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

function createGuestHost(fs: FilesystemClient) {
  const memory = new WebAssembly.Memory({ initial: 8 });
  const wasi = new Wasi({
    args: [],
    env: {},
    fs,
    preopens: { "/": "/" },
    namespaces: { env: { memory } },
    stdout() {},
    stderr() {},
    sleep() {},
  });
  const wasiModule = guestModule("wasi_snapshot_preview1", [
    {
      name: "path_open",
      parameters: ["i32", "i32", "i32", "i32", "i32", "i64", "i64", "i32", "i32"],
    },
    { name: "fd_read", parameters: ["i32", "i32", "i32", "i32"] },
    { name: "fd_write", parameters: ["i32", "i32", "i32", "i32"] },
    { name: "fd_pread", parameters: ["i32", "i32", "i32", "i64", "i32"] },
    { name: "fd_pwrite", parameters: ["i32", "i32", "i32", "i64", "i32"] },
    { name: "fd_seek", parameters: ["i32", "i64", "i32", "i32"] },
    { name: "fd_tell", parameters: ["i32", "i32"] },
    { name: "fd_filestat_get", parameters: ["i32", "i32"] },
    { name: "fd_filestat_set_size", parameters: ["i32", "i64"] },
    { name: "fd_filestat_set_times", parameters: ["i32", "i64", "i64", "i32"] },
    { name: "fd_allocate", parameters: ["i32", "i64", "i64"] },
    { name: "fd_sync", parameters: ["i32"] },
    { name: "fd_datasync", parameters: ["i32"] },
    { name: "fd_readdir", parameters: ["i32", "i32", "i32", "i64", "i32"] },
    { name: "fd_close", parameters: ["i32"] },
    { name: "path_unlink_file", parameters: ["i32", "i32", "i32"] },
    { name: "path_rename", parameters: ["i32", "i32", "i32", "i32", "i32", "i32"] },
    { name: "path_link", parameters: ["i32", "i32", "i32", "i32", "i32", "i32", "i32"] },
    { name: "path_symlink", parameters: ["i32", "i32", "i32", "i32", "i32"] },
    { name: "path_readlink", parameters: ["i32", "i32", "i32", "i32", "i32", "i32"] },
  ]);
  const instance = new WebAssembly.Instance(wasiModule, wasi.imports(wasiModule));
  wasi.start(instance);
  const call = (name: string, ...args: (number | bigint)[]) =>
    guestFunction(instance, name)(...args);
  const view = () => new DataView(memory.buffer);
  const bytes = () => new Uint8Array(memory.buffer);
  const putStr = (text: string, ptr: number) => {
    const encoded = encoder.encode(text);
    bytes().set(encoded, ptr);
    return encoded.length;
  };
  const open = (path: string, oflags = 0, rights = ALL_RIGHTS, fdflags = 0, dir = 3): number => {
    const len = putStr(path, 2048);
    assertEqual(
      call("path_open", dir, 1, 2048, len, oflags, rights, rights, fdflags, 128),
      0,
      `path_open(${path})`,
    );
    return view().getUint32(128, true);
  };
  return { memory, wasi, call, view, bytes, putStr, open };
}

function runWasiFdConformance(fs: FilesystemClient) {
  const g = createGuestHost(fs);
  try {
    // 1. O_CREAT | O_EXCL, fd_write, fd_seek, fd_tell, fd_read, fd_pread, fd_pwrite
    const fd = g.open("alpha.txt", OFLAG_CREAT | OFLAG_EXCL, ALL_RIGHTS, 0);
    // Second O_CREAT | O_EXCL must return EEXIST (20)
    const lenA = g.putStr("alpha.txt", 2048);
    assertEqual(
      g.call(
        "path_open",
        3,
        1,
        2048,
        lenA,
        OFLAG_CREAT | OFLAG_EXCL,
        ALL_RIGHTS,
        ALL_RIGHTS,
        0,
        128,
      ),
      20,
      "O_CREAT|O_EXCL existing",
    );

    const payload = encoder.encode("hello world!");
    g.bytes().set(payload, 4096);
    g.view().setUint32(256, 4096, true);
    g.view().setUint32(260, payload.length, true);
    assertEqual(g.call("fd_write", fd, 256, 1, 264), 0, "fd_write");
    assertEqual(g.view().getUint32(264, true), payload.length, "fd_write count");

    assertEqual(g.call("fd_tell", fd, 272), 0, "fd_tell");
    assertEqual(g.view().getBigUint64(272, true), BigInt(payload.length), "fd_tell value");

    // fd_pwrite does not move offset; fd_pread reads without moving offset
    const patch = encoder.encode("WASM");
    g.bytes().set(patch, 4200);
    g.view().setUint32(256, 4200, true);
    g.view().setUint32(260, patch.length, true);
    assertEqual(g.call("fd_pwrite", fd, 256, 1, 6n, 264), 0, "fd_pwrite");
    assertEqual(g.view().getUint32(264, true), 4, "fd_pwrite count");
    assertEqual(g.call("fd_tell", fd, 272), 0, "fd_tell after pwrite");
    assertEqual(g.view().getBigUint64(272, true), BigInt(payload.length), "offset unchanged");

    g.view().setUint32(256, 4400, true);
    g.view().setUint32(260, 12, true);
    assertEqual(g.call("fd_pread", fd, 256, 1, 0n, 264), 0, "fd_pread");
    assertEqual(g.view().getUint32(264, true), 12, "fd_pread count");
    assertEqual(decoder.decode(g.bytes().slice(4400, 4412)), "hello WASMd!", "fd_pread bytes");

    // fd_seek SET / CUR / END + fd_read
    assertEqual(g.call("fd_seek", fd, -6n, 2, 272), 0, "fd_seek END");
    assertEqual(g.view().getBigUint64(272, true), 6n, "fd_seek END offset");
    g.view().setUint32(256, 4500, true);
    g.view().setUint32(260, 6, true);
    assertEqual(g.call("fd_read", fd, 256, 1, 264), 0, "fd_read");
    assertEqual(decoder.decode(g.bytes().slice(4500, 4506)), "WASMd!", "fd_read tail");

    // fd_allocate + fd_filestat_get + fd_filestat_set_size + fd_filestat_set_times + fd_sync/datasync
    assertEqual(g.call("fd_allocate", fd, 10n, 10n), 0, "fd_allocate");
    assertEqual(g.call("fd_filestat_get", fd, 512), 0, "fd_filestat_get after allocate");
    assertEqual(g.view().getBigUint64(512 + 32, true), 20n, "allocated size");

    assertEqual(g.call("fd_filestat_set_size", fd, 5n), 0, "fd_filestat_set_size truncate");
    assertEqual(g.call("fd_filestat_get", fd, 512), 0, "fd_filestat_get after truncate");
    assertEqual(g.view().getBigUint64(512 + 32, true), 5n, "truncated size");

    const atime = 1_700_000_000_123_456_789n;
    const mtime = 1_700_000_001_987_654_321n;
    assertEqual(
      g.call("fd_filestat_set_times", fd, atime, mtime, 1 | 4),
      0,
      "fd_filestat_set_times",
    );
    assertEqual(g.call("fd_filestat_get", fd, 512), 0, "fd_filestat_get after set_times");
    assertEqual(g.view().getBigUint64(512 + 40, true), atime, "atime preserved");
    assertEqual(g.view().getBigUint64(512 + 48, true), mtime, "mtime preserved");
    assertEqual(g.call("fd_sync", fd), 0, "fd_sync");
    assertEqual(g.call("fd_datasync", fd), 0, "fd_datasync");

    // 2. O_APPEND + O_TRUNC
    const appFd = g.open("alpha.txt", 0, ALL_RIGHTS, FDFLAG_APPEND);
    const tail = encoder.encode("-app");
    g.bytes().set(tail, 4096);
    g.view().setUint32(256, 4096, true);
    g.view().setUint32(260, tail.length, true);
    assertEqual(g.call("fd_write", appFd, 256, 1, 264), 0, "append write");
    assertEqual(g.call("fd_close", appFd), 0, "close appFd");

    g.view().setUint32(256, 4600, true);
    g.view().setUint32(260, 16, true);
    assertEqual(g.call("fd_pread", fd, 256, 1, 0n, 264), 0, "pread after append");
    assertEqual(g.view().getUint32(264, true), 9, "pread count after append");
    assertEqual(decoder.decode(g.bytes().slice(4600, 4609)), "hello-app", "appended content");

    // 3. Hard link, symlink, readlink, rename, unlink-while-open
    const fromLen = g.putStr("alpha.txt", 2048);
    const linkLen = g.putStr("hard.txt", 2200);
    assertEqual(g.call("path_link", 3, 0, 2048, fromLen, 3, 2200, linkLen), 0, "path_link");
    const symTargetLen = g.putStr("hard.txt", 2300);
    const symPathLen = g.putStr("sym.txt", 2400);
    assertEqual(g.call("path_symlink", 2300, symTargetLen, 3, 2400, symPathLen), 0, "path_symlink");
    assertEqual(g.call("path_readlink", 3, 2400, symPathLen, 4700, 64, 264), 0, "path_readlink");
    assertEqual(
      decoder.decode(g.bytes().slice(4700, 4700 + g.view().getUint32(264, true))),
      "hard.txt",
      "readlink target",
    );
    const renamedLen = g.putStr("renamed.txt", 2500);
    assertEqual(g.call("path_rename", 3, 2200, linkLen, 3, 2500, renamedLen), 0, "path_rename");

    // Unlink alpha.txt while fd is open; fd stays readable/writable!
    assertEqual(g.call("path_unlink_file", 3, 2048, fromLen), 0, "unlink alpha");
    assertEqual(g.call("path_unlink_file", 3, 2500, renamedLen), 0, "unlink renamed");
    const ghost = encoder.encode("!");
    g.bytes().set(ghost, 4096);
    g.view().setUint32(256, 4096, true);
    g.view().setUint32(260, 1, true);
    assertEqual(g.call("fd_pwrite", fd, 256, 1, 9n, 264), 0, "pwrite unlinked open fd");
    g.view().setUint32(256, 4600, true);
    g.view().setUint32(260, 16, true);
    assertEqual(g.call("fd_pread", fd, 256, 1, 0n, 264), 0, "pread unlinked open fd");
    assertEqual(decoder.decode(g.bytes().slice(4600, 4610)), "hello-app!", "unlinked content");
    assertEqual(g.call("fd_close", fd), 0, "close unlinked fd");

    // 4. Multi-page (> PAGE = 64 KiB) write + read round-trip through WASI
    const largeSize = PAGE * 2 + 1234;
    const bigFd = g.open("large.bin", OFLAG_CREAT | OFLAG_TRUNC, ALL_RIGHTS, 0);
    const expectedBig = new Uint8Array(largeSize);
    for (let i = 0; i < largeSize; i++) expectedBig[i] = (i * 31 + 7) & 0xff;
    let writtenTotal = 0;
    while (writtenTotal < largeSize) {
      const chunkLen = Math.min(32768, largeSize - writtenTotal);
      g.bytes().set(expectedBig.subarray(writtenTotal, writtenTotal + chunkLen), 8192);
      g.view().setUint32(256, 8192, true);
      g.view().setUint32(260, chunkLen, true);
      assertEqual(g.call("fd_write", bigFd, 256, 1, 264), 0, "large fd_write");
      const n = g.view().getUint32(264, true);
      if (n <= 0) throw new Error("zero large fd_write");
      writtenTotal += n;
    }
    assertEqual(g.call("fd_seek", bigFd, 0n, 0, 272), 0, "large seek 0");
    const actualBig = new Uint8Array(largeSize);
    let readTotal = 0;
    while (readTotal < largeSize) {
      const chunkLen = Math.min(PAGE + 4096, largeSize - readTotal);
      g.view().setUint32(256, 8192, true);
      g.view().setUint32(260, chunkLen, true);
      assertEqual(g.call("fd_read", bigFd, 256, 1, 264), 0, "large fd_read");
      const n = g.view().getUint32(264, true);
      if (n <= 0) throw new Error(`premature EOF at ${readTotal}`);
      actualBig.set(g.bytes().subarray(8192, 8192 + n), readTotal);
      readTotal += n;
    }
    for (let i = 0; i < largeSize; i++) {
      if (actualBig[i] !== expectedBig[i])
        throw new Error(`large mismatch at ${i}: ${actualBig[i]} !== ${expectedBig[i]}`);
    }
    assertEqual(g.call("fd_close", bigFd), 0, "close bigFd");

    // 5. fd_readdir lists surviving entries
    assertEqual(g.call("fd_readdir", 3, 8192, 4096, 0n, 264), 0, "fd_readdir");
    const used = g.view().getUint32(264, true);
    const names: string[] = [];
    let pos = 8192;
    while (pos + 24 <= 8192 + used) {
      const nameLen = g.view().getUint32(pos + 16, true);
      if (pos + 24 + nameLen > 8192 + used) break;
      names.push(decoder.decode(g.bytes().slice(pos + 24, pos + 24 + nameLen)));
      pos += 24 + nameLen;
    }
    if (!names.includes("large.bin") || !names.includes("sym.txt"))
      throw new Error(`readdir missing entries: ${names.join(",")}`);

    return { ok: true, largeSize, entries: names.toSorted() };
  } finally {
    g.wasi.descriptors.dispose();
  }
}

function runProcRedirectionConformance(fs: FilesystemClient, seedText?: string) {
  const g = createGuestHost(fs);
  const supervisor = new ProcessSupervisor({
    registry: new ExecutableRegistry(),
    launch() {
      throw new Error("unexpected launch");
    },
  });
  const pid = supervisor.createRoot({ descriptors: g.wasi.descriptors });
  // Use a separate wake word from fs.signal (just like real browser/worker.ts runtimeProcess.wake!)
  const processWake = new Int32Array(new SharedArrayBuffer(4));
  let waitsOnFsSignal = 0;
  let waitsOnProcessWake = 0;
  const abi = new ProcessABI({
    processIdentity: supervisor.get(pid)!.processIdentity,
    memory: g.memory,
    descriptors: g.wasi.descriptors,
    fs,
    pid,
    service: supervisor,
    signals: supervisor.get(pid)!,
    wake: processWake,
    wait(milliseconds, word, expected) {
      if (word instanceof Int32Array && word.buffer === fs.signal.buffer) waitsOnFsSignal++;
      else if (word instanceof Int32Array && word.buffer === processWake.buffer)
        waitsOnProcessWake++;
      controlWait(word, 0, expected, milliseconds);
    },
  });
  try {
    const view = () => new DataView(g.memory.buffer);
    const pollOne = (kind: number, fd: number, userdata = 1n) => {
      view().setUint32(512, kind, true);
      view().setUint32(516, fd, true);
      view().setBigUint64(520, userdata, true);
      const ready = abi.imports.poll!(512, 1, 5000, 640);
      assertEqual(ready, 1, `poll(kind=${kind}, fd=${fd})`);
      assertEqual(view().getBigUint64(640, true), userdata, "poll userdata");
    };
    const writeAll = (fd: number, data: Uint8Array) => {
      let off = 0;
      while (off < data.length) {
        const chunkLen = Math.min(PAGE, data.length - off);
        g.bytes().set(data.subarray(off, off + chunkLen), 16384);
        const res = abi.imports.write!(fd, 16384, chunkLen);
        if (res === -6) {
          pollOne(1, fd, 10n);
          continue;
        }
        if (res <= 0) throw new Error(`runtime_proc.write failed: ${res}`);
        off += res;
      }
    };
    const readAll = (fd: number, stepSize = 16384): Uint8Array => {
      const parts: Uint8Array[] = [];
      for (;;) {
        const res = abi.imports.read!(fd, 16384, stepSize);
        if (res === -6) {
          pollOne(0, fd, 20n);
          continue;
        }
        if (res < 0) throw new Error(`runtime_proc.read failed: ${res}`);
        if (res === 0) break;
        parts.push(g.bytes().slice(16384, 16384 + res));
      }
      const total = parts.reduce((sum, part) => sum + part.length, 0);
      const out = new Uint8Array(total);
      let at = 0;
      for (const part of parts) {
        out.set(part, at);
        at += part.length;
      }
      return out;
    };

    // 1. `echo first > out.txt`
    const fd1 = g.open("out.txt", OFLAG_CREAT | OFLAG_TRUNC, RIGHT_WRITE | RIGHT_POLL, 0);
    writeAll(fd1, encoder.encode("first\n"));
    g.call("fd_close", fd1);

    // 2. `echo second >> out.txt`
    const fd2 = g.open("out.txt", OFLAG_CREAT, RIGHT_WRITE | RIGHT_POLL, FDFLAG_APPEND);
    writeAll(fd2, encoder.encode("second\n"));
    g.call("fd_close", fd2);

    // 3. `cat out.txt`
    const fd3 = g.open("out.txt", 0, RIGHT_READ | RIGHT_POLL, 0);
    const outText = decoder.decode(readAll(fd3));
    assertEqual(outText, "first\nsecond\n", "echo > and >> then cat");
    g.call("fd_close", fd3);

    // 4. `2>&1 > dup.txt` shared offset across dup'd FDs
    const dupA = g.open("dup.txt", OFLAG_CREAT | OFLAG_TRUNC, RIGHT_WRITE | RIGHT_POLL, 0);
    const dupB = abi.imports.dup!(dupA);
    if (dupB < 0) throw new Error(`dup failed: ${dupB}`);
    writeAll(dupA, encoder.encode("stdout-1\n"));
    writeAll(dupB, encoder.encode("stderr-2\n"));
    writeAll(dupA, encoder.encode("stdout-3\n"));
    g.call("fd_close", dupA);
    g.call("fd_close", dupB);
    const dupRead = g.open("dup.txt", 0, RIGHT_READ | RIGHT_POLL, 0);
    assertEqual(
      decoder.decode(readAll(dupRead)),
      "stdout-1\nstderr-2\nstdout-3\n",
      "dup shared offset 2>&1",
    );
    g.call("fd_close", dupRead);

    // 5. `cat big.bin > big-copy.bin` (> 140 KiB multi-chunk streaming across PAGE boundaries)
    const bigSize = PAGE * 2 + 9999;
    const bigInput = new Uint8Array(bigSize);
    for (let i = 0; i < bigSize; i++) bigInput[i] = (i * 17 + 3) & 0xff;
    const bigSrc = g.open("big.bin", OFLAG_CREAT | OFLAG_TRUNC, RIGHT_WRITE | RIGHT_POLL, 0);
    writeAll(bigSrc, bigInput);
    g.call("fd_close", bigSrc);

    const srcFd = g.open("big.bin", 0, RIGHT_READ | RIGHT_POLL, 0);
    const dstFd = g.open("big-copy.bin", OFLAG_CREAT | OFLAG_TRUNC, RIGHT_WRITE | RIGHT_POLL, 0);
    const streamed = readAll(srcFd, 24576);
    writeAll(dstFd, streamed);
    g.call("fd_close", srcFd);
    g.call("fd_close", dstFd);

    const verifyFd = g.open("big-copy.bin", 0, RIGHT_READ | RIGHT_POLL, 0);
    const copied = readAll(verifyFd, PAGE);
    g.call("fd_close", verifyFd);
    assertEqual(copied.length, bigSize, "big-copy length");
    for (let i = 0; i < bigSize; i++) {
      if (copied[i] !== bigInput[i])
        throw new Error(`big-copy byte mismatch at ${i}: ${copied[i]} !== ${bigInput[i]}`);
    }

    // 6. Unlinked-while-open regular file via runtime_proc + fd_reopen
    const unlinkedFd = g.open("ephemeral.txt", OFLAG_CREAT | OFLAG_TRUNC, ALL_RIGHTS, 0);
    writeAll(unlinkedFd, encoder.encode("ghost-data"));
    const ephLen = g.putStr("ephemeral.txt", 2048);
    assertEqual(g.call("path_unlink_file", 3, 2048, ephLen), 0, "unlink ephemeral");
    assertEqual(
      abi.imports.fd_reopen!(unlinkedFd, 0, 0, Number(RIGHT_READ | RIGHT_POLL), 128),
      0,
      "fd_reopen unlinked",
    );
    const reopenedFd = view().getUint32(128, true);
    g.call("fd_close", unlinkedFd);
    assertEqual(decoder.decode(readAll(reopenedFd)), "ghost-data", "read reopened unlinked");
    g.call("fd_close", reopenedFd);

    // 7. Zero-length I/O and error propagation (EISDIR, EACCES) without advancing offsets
    assertEqual(abi.imports.read!(3, 16384, 8), -31, "read directory -> -EISDIR");
    const roFd = g.open("readonly.txt", OFLAG_CREAT | OFLAG_TRUNC, ALL_RIGHTS, 0);
    writeAll(roFd, encoder.encode("fixed"));
    const roRes = g.wasi.descriptors.get(roFd)!.resource;
    if (roRes.kind !== "file") throw new Error("expected file");
    assertEqual(fs.setMode(roRes.handle, 0o400), 0, "chmod 0400");
    assertEqual(g.call("fd_seek", roFd, 2n, 0, 272), 0, "seek 2");
    let writeErr = abi.imports.write!(roFd, 16384, 3);
    if (writeErr === -6) {
      pollOne(1, roFd, 30n);
      writeErr = abi.imports.write!(roFd, 16384, 3);
    }
    assertEqual(writeErr, -2, "write to 0400 file -> -EACCES");
    assertEqual(abi.imports.write!(roFd, 16384, 0), 0, "zero-length write");
    assertEqual(abi.imports.read!(roFd, 16384, 0), 0, "zero-length read");
    assertEqual(roRes.offset, 2, "offset untouched after EACCES and zero-length IO");
    g.call("fd_close", roFd);

    // 8. If seedText was written by counterpart tab, verify live cross-tab read
    let crossTabRead: string | undefined;
    if (seedText !== undefined) {
      const crossFd = g.open("cross-tab.txt", 0, RIGHT_READ | RIGHT_POLL, 0);
      crossTabRead = decoder.decode(readAll(crossFd));
      g.call("fd_close", crossFd);
    }

    return {
      ok: true,
      outText,
      bigSize: copied.length,
      waitsOnFsSignal,
      waitsOnProcessWake,
      crossTabRead,
    };
  } finally {
    supervisor.dispose();
    g.wasi.descriptors.dispose();
  }
}

function runPollWakeCheck(fs: FilesystemClient) {
  const g = createGuestHost(fs);
  const supervisor = new ProcessSupervisor({
    registry: new ExecutableRegistry(),
    launch() {
      throw new Error("unexpected launch");
    },
  });
  const pid = supervisor.createRoot({ descriptors: g.wasi.descriptors });
  const processWake = new Int32Array(new SharedArrayBuffer(4));
  const waitWords: string[] = [];
  const abi = new ProcessABI({
    processIdentity: supervisor.get(pid)!.processIdentity,
    memory: g.memory,
    descriptors: g.wasi.descriptors,
    fs,
    pid,
    service: supervisor,
    signals: supervisor.get(pid)!,
    wake: processWake,
    wait(milliseconds, word, expected) {
      waitWords.push(
        word instanceof Int32Array && word.buffer === fs.signal.buffer
          ? "fs.signal"
          : word instanceof Int32Array && word.buffer === processWake.buffer
            ? "process.wake"
            : "other",
      );
      controlWait(word, 0, expected, milliseconds);
    },
  });
  try {
    const fd = g.open("wake.txt", OFLAG_CREAT | OFLAG_TRUNC, ALL_RIGHTS, 0);
    g.bytes().set(encoder.encode("wake-check"), 16384);
    const view = new DataView(g.memory.buffer);
    let writeResult = abi.imports.write!(fd, 16384, 10);
    while (writeResult === -6) {
      view.setUint32(512, 1, true);
      view.setUint32(516, fd, true);
      view.setBigUint64(520, 42n, true);
      assertEqual(abi.imports.poll!(512, 1, 5000, 640), 1, "poll write");
      writeResult = abi.imports.write!(fd, 16384, 10);
    }
    assertEqual(writeResult, 10, "write count");
    assertEqual(g.call("fd_seek", fd, 0n, 0, 272), 0, "seek 0");
    let readResult = abi.imports.read!(fd, 16384, 10);
    while (readResult === -6) {
      view.setUint32(512, 0, true);
      view.setUint32(516, fd, true);
      view.setBigUint64(520, 43n, true);
      assertEqual(abi.imports.poll!(512, 1, 5000, 640), 1, "poll read");
      readResult = abi.imports.read!(fd, 16384, 10);
    }
    assertEqual(readResult, 10, "read count");
    assertEqual(decoder.decode(g.bytes().slice(16384, 16394)), "wake-check", "read text");
    g.call("fd_close", fd);
    return {
      ok: true,
      waitWords,
      directDisabled: fs.shared.isDirectDisabled(),
    };
  } finally {
    supervisor.dispose();
    g.wasi.descriptors.dispose();
  }
}

async function runDiagnosticCheck(fs: FilesystemClient) {
  const root = fs.preopen("/");
  const created = fs.create(
    { parent: root, node: undefined, name: "stderr.log", trailingSlash: false, terminalDot: false },
    "file",
    false,
  );
  if (typeof created !== "number") throw new Error(`create failed: ${created.error}`);
  fs.retain(created);
  const descriptors = new DescriptorTable();
  try {
    const fd = descriptors.open(
      {
        kind: "file",
        handle: created,
        offset: 0,
        append: true,
        fdflags: FDFLAG_APPEND | FDFLAG_NONBLOCK,
      },
      ALL_RIGHTS,
      0n,
    );
    const resource = descriptors.get(fd)!.resource;
    if (resource.kind !== "file") throw new Error("expected file");
    await drainDiagnostic(encoder.encode("fatal: redirected diagnostic\n"), (chunk) =>
      withFileOffset(
        resource,
        () => {
          const result = fs.tryAppend(resource.handle, [chunk]);
          if (typeof result === "number") return result;
          resource.offset = result.offset;
          return result.written;
        },
        true,
      ),
    );
    const readBuf = new Uint8Array(64);
    const count = fs.read(created, [readBuf], 0);
    return { ok: true, text: decoder.decode(readBuf.subarray(0, count)) };
  } finally {
    descriptors.dispose();
    fs.release(created);
  }
}

self.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  const fs = new FilesystemClient(data.connection);
  try {
    const result =
      data.scenario === "wasi-fd"
        ? runWasiFdConformance(fs)
        : data.scenario === "proc-redirection"
          ? runProcRedirectionConformance(fs, data.seedText)
          : data.scenario === "poll-wake"
            ? runPollWakeCheck(fs)
            : await runDiagnosticCheck(fs);
    self.postMessage({ value: result });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  } finally {
    fs.dispose();
  }
};
