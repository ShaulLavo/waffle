import { describe, expect, test } from "bun:test";
import { Wasi } from "../core/wasi";
import { MACHINE_ID_FILE_SIZE, MACHINE_ID_INO } from "../core/devices";
import {
  RIGHTS_ALL,
  RIGHT_FD_FILESTAT_GET,
  RIGHT_FD_READ,
  RIGHT_FD_SEEK,
  RIGHT_FD_TELL,
  RIGHT_FD_WRITE,
} from "../core/rights";
import { MemFS } from "../fs/memory";
import { MemoryBackend } from "../fs/backend";
import { PersistentBackend } from "../fs/persistent";
import { FilesystemService } from "../fs/service";
import { FilesystemClient } from "../fs/client";
import { createFilesystemConnection } from "../fs/protocol";
import { SharedFilesystemState, machineIdFromWorkspace } from "../fs/shared";
import { createRuntimeTerminalCodec } from "../browser/runtime-terminals";
import type { WorkerDescriptorCodec } from "../proc/worker-client";
import { MetadataStore } from "./fixtures/metadata-enumeration-r173-store";
import { guestModule } from "./fixtures/publication-wasm";

const RIGHTS_RDONLY = RIGHT_FD_READ | RIGHT_FD_SEEK | RIGHT_FD_TELL | RIGHT_FD_FILESTAT_GET;

const probeWasmModule = guestModule("wasi_snapshot_preview1", [
  {
    name: "path_open",
    parameters: ["i32", "i32", "i32", "i32", "i32", "i64", "i64", "i32", "i32"],
  },
]);

interface WasiHarness {
  readonly wasi: Wasi;
  readonly memory: WebAssembly.Memory;
  readonly exports: Record<string, (...args: any[]) => number>;
  readonly fsImports: Record<string, (...args: any[]) => number>;
  readonly rootFd: number;
  writeStr(offset: number, text: string): number;
  readStr(offset: number, length: number): string;
  openPath(
    dirFd: number,
    path: string,
    opts?: {
      dirflags?: number;
      oflags?: number;
      rightsBase?: bigint;
      rightsInheriting?: bigint;
      fdflags?: number;
    },
  ): { errno: number; fd: number };
  readAll(fd: number): { errno: number; text: string };
}

function createHarness(
  fs: import("../core/filesystem").FileSystem,
  options?: { machineId?: string; preopens?: Record<string, string> },
): WasiHarness {
  const memory = new WebAssembly.Memory({ initial: 4 });
  const wasi = new Wasi({
    args: ["test"],
    env: {},
    fs,
    machineId: options?.machineId,
    preopens: options?.preopens ?? { "/": "/" },
    namespaces: { env: { memory } },
    stdout() {},
    stderr() {},
    sleep() {},
  });
  const imports = wasi.imports(probeWasmModule) as {
    wasi_snapshot_preview1: Record<string, (...args: any[]) => number>;
    runtime_fs: Record<string, (...args: any[]) => number>;
  };
  const instance = new WebAssembly.Instance(probeWasmModule, imports);
  wasi.start(instance);
  const exports = wasi.imports(
    guestModule("wasi_snapshot_preview1", [
      {
        name: "path_open",
        parameters: ["i32", "i32", "i32", "i32", "i32", "i64", "i64", "i32", "i32"],
      },
      { name: "path_filestat_get", parameters: ["i32", "i32", "i32", "i32", "i32"] },
      { name: "fd_read", parameters: ["i32", "i32", "i32", "i32"] },
      { name: "fd_pread", parameters: ["i32", "i32", "i32", "i64", "i32"] },
      { name: "fd_seek", parameters: ["i32", "i64", "i32", "i32"] },
      { name: "fd_tell", parameters: ["i32", "i32"] },
      { name: "fd_fdstat_get", parameters: ["i32", "i32"] },
      { name: "fd_filestat_get", parameters: ["i32", "i32"] },
      { name: "fd_filestat_set_size", parameters: ["i32", "i64"] },
    ]),
  ).wasi_snapshot_preview1 as Record<string, (...args: any[]) => number>;
  const fsImports = wasi.imports(
    guestModule("runtime_fs", [
      { name: "path_permissions_get", parameters: ["i32", "i32", "i32", "i32", "i32"] },
      { name: "path_realpath", parameters: ["i32", "i32", "i32", "i32", "i32", "i32"] },
      { name: "path_probe", parameters: ["i32", "i32", "i32", "i32", "i32"] },
    ]),
  ).runtime_fs as Record<string, (...args: any[]) => number>;
  // Bind memory onto wasi after building both import maps
  wasi.start(new WebAssembly.Instance(probeWasmModule, wasi.imports(probeWasmModule)));
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bytes = () => new Uint8Array(memory.buffer);
  const view = () => new DataView(memory.buffer);
  const writeStr = (offset: number, text: string): number => {
    const encoded = encoder.encode(text);
    bytes().set(encoded, offset);
    return encoded.length;
  };
  const readStr = (offset: number, length: number): string =>
    decoder.decode(bytes().subarray(offset, offset + length));
  const openPath = (
    dirFd: number,
    path: string,
    opts: {
      dirflags?: number;
      oflags?: number;
      rightsBase?: bigint;
      rightsInheriting?: bigint;
      fdflags?: number;
    } = {},
  ) => {
    const pathLen = writeStr(1024, path);
    const errno = exports.path_open!(
      dirFd,
      opts.dirflags ?? 1,
      1024,
      pathLen,
      opts.oflags ?? 0,
      opts.rightsBase ?? RIGHTS_RDONLY,
      opts.rightsInheriting ?? 0n,
      opts.fdflags ?? 0,
      2048,
    );
    return { errno, fd: view().getUint32(2048, true) };
  };
  const readAll = (fd: number) => {
    let text = "";
    for (;;) {
      view().setUint32(4096, 4200, true);
      view().setUint32(4100, 64, true);
      const errno = exports.fd_read!(fd, 4096, 1, 4120);
      if (errno !== 0) return { errno, text };
      const count = view().getUint32(4120, true);
      if (count === 0) return { errno: 0, text };
      text += readStr(4200, count);
    }
  };
  return { wasi, memory, exports, fsImports, rootFd: 3, writeStr, readStr, openPath, readAll };
}

describe("virtual /etc/machine-id", () => {
  test("preserves empty root while serving a 33-byte regular read-only /etc/machine-id", () => {
    const fs = new MemFS();
    expect(fs.root.children.size).toBe(0);
    expect(fs.readdir(fs.preopen("/")).map((entry) => entry.name)).toEqual([".", ".."]);
    expect(fs.machineId).toMatch(/^[0-9a-f]{32}$/);

    const h = createHarness(fs);
    const etcLen = h.writeStr(1024, "etc");
    expect(h.exports.path_filestat_get!(h.rootFd, 1, 1024, etcLen, 3000)).toBe(44); // ENOENT

    const opened = h.openPath(h.rootFd, "etc/machine-id");
    expect(opened.errno).toBe(0);
    expect(h.wasi.descriptors.kind(opened.fd)).toBe(3);

    expect(h.exports.fd_fdstat_get!(opened.fd, 3000)).toBe(0);
    const v = new DataView(h.memory.buffer);
    expect(v.getUint8(3000)).toBe(4); // FT_FILE

    expect(h.exports.fd_filestat_get!(opened.fd, 3000)).toBe(0);
    expect(v.getBigUint64(3008, true)).toBe(BigInt(MACHINE_ID_INO));
    expect(v.getUint8(3016)).toBe(4); // FT_FILE
    expect(v.getBigUint64(3032, true)).toBe(BigInt(MACHINE_ID_FILE_SIZE));

    const first = h.readAll(opened.fd);
    expect(first.errno).toBe(0);
    expect(first.text).toBe(`${fs.machineId}\n`);
    expect(first.text.length).toBe(33);

    // Normalized relative spellings resolve identically (without crossing a missing /etc/..)
    const normalized = h.openPath(h.rootFd, "./etc/./machine-id");
    expect(normalized.errno).toBe(0);
    expect(h.readAll(normalized.fd).text).toBe(`${fs.machineId}\n`);
    expect(h.openPath(h.rootFd, "./etc/../etc/machine-id").errno).toBe(44);

    // Seek, tell, pread, dup, and fdReopen
    expect(h.exports.fd_tell!(opened.fd, 3000)).toBe(0);
    expect(v.getBigUint64(3000, true)).toBe(33n);

    expect(h.exports.fd_seek!(opened.fd, -5n, 2, 3000)).toBe(0); // SEEK_END - 5
    expect(v.getBigUint64(3000, true)).toBe(28n);
    expect(h.exports.fd_seek!(opened.fd, -100n, 1, 3000)).toBe(28); // EINVAL

    // pread does not alter current offset (28)
    v.setUint32(4096, 4200, true);
    v.setUint32(4100, 8, true);
    expect(h.exports.fd_pread!(opened.fd, 4096, 1, 4n, 4120)).toBe(0);
    expect(v.getUint32(4120, true)).toBe(8);
    expect(h.readStr(4200, 8)).toBe(fs.machineId.slice(4, 12));
    expect(h.exports.fd_tell!(opened.fd, 3000)).toBe(0);
    expect(v.getBigUint64(3000, true)).toBe(28n);

    // dup shares offset
    const dupFd = h.wasi.descriptors.dup(opened.fd);
    expect(dupFd).toBeGreaterThanOrEqual(0);
    expect(h.readAll(dupFd).text).toBe(`${fs.machineId.slice(28)}\n`);
    expect(h.exports.fd_tell!(opened.fd, 3000)).toBe(0);
    expect(v.getBigUint64(3000, true)).toBe(33n);

    // fdReopen creates a fresh offset 0 description and rejects write/trunc/directory
    expect(h.wasi.fdReopen(opened.fd, 2, 0, RIGHTS_RDONLY, 2048)).toBe(54); // ENOTDIR
    expect(h.wasi.fdReopen(opened.fd, 8, 0, RIGHTS_RDONLY, 2048)).toBe(2); // EACCES
    expect(h.wasi.fdReopen(opened.fd, 0, 0, RIGHT_FD_WRITE, 2048)).toBe(2); // EACCES
    expect(h.wasi.fdReopen(opened.fd, 0, 0, RIGHTS_RDONLY, 2048)).toBe(0);
    const reopenedFd = v.getUint32(2048, true);
    expect(h.readAll(reopenedFd).text).toBe(`${fs.machineId}\n`);

    // Root remained completely untouched
    expect(fs.root.children.size).toBe(0);
  });

  test("enforces read-only open/mutation errnos and supports stat, permissions, probe, realpath", () => {
    const fs = new MemFS(undefined, "0123456789abcdef0123456789abcdef");
    fs.writeFile("/fallback.txt", "real");
    const h = createHarness(fs);
    const v = new DataView(h.memory.buffer);

    // Open flag & access rejections
    expect(h.openPath(h.rootFd, "etc/machine-id", { rightsBase: RIGHT_FD_WRITE }).errno).toBe(2); // EACCES
    expect(
      h.openPath(h.rootFd, "etc/machine-id", { oflags: 8, rightsBase: RIGHTS_RDONLY }).errno,
    ).toBe(2); // O_TRUNC -> EACCES
    expect(
      h.openPath(h.rootFd, "etc/machine-id", { oflags: 1 | 4, rightsBase: RIGHTS_RDONLY }).errno,
    ).toBe(20); // O_CREAT|O_EXCL -> EEXIST
    expect(
      h.openPath(h.rootFd, "etc/machine-id", { oflags: 2, rightsBase: RIGHTS_RDONLY }).errno,
    ).toBe(54); // O_DIRECTORY -> ENOTDIR
    expect(h.openPath(h.rootFd, "etc/machine-id/").errno).toBe(54); // trailing slash -> ENOTDIR

    // path_filestat_get
    const pathLen = h.writeStr(1024, "etc/machine-id");
    expect(h.exports.path_filestat_get!(h.rootFd, 1, 1024, pathLen, 3000)).toBe(0);
    expect(v.getBigUint64(3008, true)).toBe(BigInt(MACHINE_ID_INO));
    expect(v.getUint8(3016)).toBe(4);
    expect(v.getBigUint64(3032, true)).toBe(33n);

    // path_permissions_get
    expect(h.fsImports.path_permissions_get!(h.rootFd, 1024, pathLen, 0, 3000)).toBe(0);
    expect(v.getUint32(3000, true)).toBe(0o444);
    expect(v.getUint32(3008, true)).toBe(4); // R_OK only

    // path_realpath (rooted)
    expect(h.fsImports.path_realpath!(h.rootFd, 1024, pathLen, 3100, 128, 3000)).toBe(0);
    const realLen = v.getUint32(3000, true);
    expect(h.readStr(3100, realLen)).toBe("/etc/machine-id");

    // Missing /etc must NOT let synthetic traversal cross etc/.. into /dev/null
    expect(h.openPath(h.rootFd, "etc/../dev/null").errno).toBe(44); // ENOENT
    expect(h.openPath(h.rootFd, "etc/./machine-id").errno).toBe(0);

    // path_probe: virtual /etc/machine-id and symlinks pointing to it beat later physical files
    fs.symlink(fs.resolve(fs.preopen("/"), "id-link") as any, "/etc/machine-id");
    const probeLen = h.writeStr(1024, "missing\0etc/machine-id\0fallback.txt\0");
    expect(h.fsImports.path_probe!(h.rootFd, 1024, probeLen, 1, 3000)).toBe(0);
    expect(v.getUint32(3000, true)).toBe(1);
    const linkProbeLen = h.writeStr(1024, "missing\0id-link\0fallback.txt\0");
    expect(h.fsImports.path_probe!(h.rootFd, 1024, linkProbeLen, 1, 3000)).toBe(0);
    expect(v.getUint32(3000, true)).toBe(1);

    // fd_filestat_set_size rejected on virtual file
    const opened = h.openPath(h.rootFd, "etc/machine-id", {
      rightsBase: RIGHTS_ALL & ~RIGHT_FD_WRITE,
    });
    expect(opened.errno).toBe(0);
    expect(h.exports.fd_filestat_set_size!(opened.fd, 0n)).toBe(2); // EACCES
  });

  test("physical /etc and /etc/machine-id precedence, permissions, openat, and symlinks", () => {
    const fs = new MemFS(undefined, "fedcba9876543210fedcba9876543210");
    fs.mkdirp("/etc");
    fs.symlink(fs.resolve(fs.preopen("/"), "mid-link") as any, "/etc/machine-id");
    const h = createHarness(fs);
    const v = new DataView(h.memory.buffer);

    // Physical /etc without machine-id still serves virtual /etc/machine-id
    expect(h.readAll(h.openPath(h.rootFd, "etc/machine-id").fd).text).toBe(
      "fedcba9876543210fedcba9876543210\n",
    );

    // openat(etcFd, "machine-id") works too
    const etcOpened = h.openPath(h.rootFd, "etc", {
      oflags: 2,
      rightsBase: RIGHTS_ALL,
      rightsInheriting: RIGHTS_ALL,
    });
    expect(etcOpened.errno).toBe(0);
    const relOpened = h.openPath(etcOpened.fd, "machine-id");
    expect(relOpened.errno).toBe(0);
    expect(h.readAll(relOpened.fd).text).toBe("fedcba9876543210fedcba9876543210\n");

    // Symlink mid-link -> /etc/machine-id (with physical /etc present)
    const linkLen = h.writeStr(1024, "mid-link");
    expect(h.exports.path_filestat_get!(h.rootFd, 0, 1024, linkLen, 3000)).toBe(0);
    expect(v.getUint8(3016)).toBe(7); // symlink when not following
    expect(h.exports.path_filestat_get!(h.rootFd, 1, 1024, linkLen, 3000)).toBe(0);
    expect(v.getUint8(3016)).toBe(4); // regular file when following
    expect(h.openPath(h.rootFd, "mid-link", { dirflags: 0 }).errno).toBe(32); // ELOOP
    expect(h.readAll(h.openPath(h.rootFd, "mid-link", { dirflags: 1 }).fd).text).toBe(
      "fedcba9876543210fedcba9876543210\n",
    );
    const midProbeLen = h.writeStr(1024, "missing\0mid-link\0");
    expect(h.fsImports.path_probe!(h.rootFd, 1024, midProbeLen, 1, 3000)).toBe(0);
    expect(v.getUint32(3000, true)).toBe(1);
    // Physical /etc still allows crossing etc/../dev/null
    expect(h.openPath(h.rootFd, "etc/../dev/null").errno).toBe(0);

    // Physical /etc search permission (mode 0o000) is enforced
    const etcNode = fs.lookup("/etc")!;
    etcNode.mode = 0o000;
    expect(h.openPath(h.rootFd, "etc/machine-id").errno).toBe(2); // EACCES
    etcNode.mode = 0o755;

    // Physical /etc/machine-id overrides virtual fallback completely
    fs.writeFile("/etc/machine-id", "custom-physical-id\n");
    const override = h.openPath(h.rootFd, "etc/machine-id");
    expect(override.errno).toBe(0);
    expect(h.readAll(override.fd).text).toBe("custom-physical-id\n");
    expect(h.exports.fd_filestat_get!(override.fd, 3000)).toBe(0);
    expect(v.getBigUint64(3008, true)).not.toBe(BigInt(MACHINE_ID_INO));
    expect(v.getBigUint64(3032, true)).toBe(19n);
  });

  test("persists exact same machine-id across PersistentBackend reopen and shared workers", async () => {
    const store = new MetadataStore();
    const first = await PersistentBackend.open(store);
    const expectedId = machineIdFromWorkspace(first.workspaceId);
    expect(first.machineId).toBe(expectedId);
    expect(first.shared.getMachineId()).toBe(expectedId);
    await first.flush();
    await first.close();

    // Reopen over same storage: workspace UUID & machine-id persist identically
    const second = await PersistentBackend.open(store);
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.machineId).toBe(expectedId);
    expect(second.shared.getMachineId()).toBe(expectedId);

    // Shared header preserves machine-id across resetForRemount
    second.shared.resetForRemount();
    expect(second.shared.getMachineId()).toBe(expectedId);

    // FilesystemService -> FilesystemClient exposes exact same machineId across a real Worker
    const connection = createFilesystemConnection();
    const service = new FilesystemService(second);
    service.connect(connection.server);
    const client = new FilesystemClient(connection.client);
    const workerConn = createFilesystemConnection(connection.client);
    service.connect(workerConn.server);
    const worker = new Worker(new URL("./fixtures/machine-id-worker.ts", import.meta.url).href);
    try {
      expect(client.machineId).toBe(expectedId);
      const result = await new Promise<{ machineId?: string; text: string; errno: number }>(
        (resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("machine-id worker timed out")), 10_000);
          worker.onerror = (event) => {
            clearTimeout(timer);
            reject(new Error(event.message || "machine-id worker error"));
          };
          worker.onmessage = ({ data }) => {
            clearTimeout(timer);
            if (data.error) reject(new Error(data.error));
            else resolve(data);
          };
          worker.postMessage({ connection: workerConn.client }, [workerConn.client.port]);
        },
      );
      expect(result.machineId).toBe(expectedId);
      expect(result.errno).toBe(0);
      expect(result.text).toBe(`${expectedId}\n`);
    } finally {
      worker.terminate();
      client.dispose();
      await service.shutdown();
    }
  });

  test("RuntimeTerminalCodec transfers open virtual /etc/machine-id fd and validates tokens", () => {
    const explicit = "abcdef0123456789abcdef0123456789";
    const fs = new MemFS(undefined, explicit);
    const h = createHarness(fs);
    const opened = h.openPath(h.rootFd, "etc/machine-id");
    expect(opened.errno).toBe(0);
    expect(h.exports.fd_seek!(opened.fd, 10n, 0, 3000)).toBe(0);

    const fallback: WorkerDescriptorCodec = {
      export() {
        throw new Error("unexpected fallback export");
      },
      import() {
        throw new Error("unexpected fallback import");
      },
      discard() {},
    };
    const codec = createRuntimeTerminalCodec({ fallback });
    const token = codec.export(h.wasi.descriptors.get(opened.fd)!, 2);
    const imported = codec.import(token, 2);
    expect(imported.resource.kind).toBe("device");
    if (imported.resource.kind === "device") {
      expect(imported.resource.virtualFile?.offset).toBe(10);
      // Reading 4 bytes through the imported descriptor advances the shared cursor for the source too
      const part = new Uint8Array(4);
      expect(imported.resource.read([part])).toBe(4);
      expect(new TextDecoder().decode(part)).toBe(explicit.slice(10, 14));
      const v = new DataView(h.memory.buffer);
      expect(h.exports.fd_tell!(opened.fd, 3000)).toBe(0);
      expect(v.getBigUint64(3000, true)).toBe(14n);
      // Source continues reading from the shared offset 14
      expect(h.readAll(opened.fd).text).toBe(`${explicit.slice(14)}\n`);
      expect(imported.resource.virtualFile?.offset).toBe(33);
    }
    codec.discard(token);

    expect(() =>
      codec.import(
        {
          kind: "machine-id-file",
          machineId: "INVALID",
          offset: new SharedArrayBuffer(4),
          fdflags: 0,
        },
        2,
      ),
    ).toThrow(TypeError);
    expect(() =>
      codec.import({ kind: "machine-id-file", machineId: explicit, offset: 0, fdflags: 0 }, 2),
    ).toThrow(TypeError);
  });

  test("rejects invalid explicit machineId values and supports SharedFilesystemState seqlock", () => {
    const state = new SharedFilesystemState();
    expect(state.getMachineId()).toBeUndefined();
    const id = "00112233445566778899aabbccddeeff";
    state.setMachineId(id);
    expect(state.getMachineId()).toBe(id);

    for (const bad of ["", "short", "00112233445566778899AABBCCDDEEFF", `${id}0`, "g".repeat(32)]) {
      expect(() => new MemFS(undefined, bad)).toThrow(TypeError);
      expect(
        () => new MemoryBackend(undefined, undefined, undefined, undefined, undefined, bad),
      ).toThrow(TypeError);
      expect(() => createHarness(new MemFS(), { machineId: bad })).toThrow(TypeError);
    }
  });
});
