import { Wasi } from "../../core/wasi.js";
import { RIGHTS_ALL } from "../../core/rights.js";
import { releaseSharedOfd, resourceOfdLockState } from "../../core/open-file.js";
import { FilesystemClient } from "../../fs/client.js";
import type { FilesystemConnection } from "../../fs/protocol.js";
import {
  createFilesystemDescriptorCodec,
  type FilesystemDescriptorToken,
} from "../../proc/filesystem-codec.js";
import { guestFunction, guestModule } from "./publication-wasm.js";

type Command =
  | { readonly id: number; readonly op: "open"; readonly path: string; readonly rights?: string }
  | { readonly id: number; readonly op: "dup"; readonly fd: number }
  | { readonly id: number; readonly op: "close"; readonly fd: number }
  | { readonly id: number; readonly op: "flock"; readonly fd: number; readonly operation: number }
  | {
      readonly id: number;
      readonly op: "lock";
      readonly fd: number;
      readonly cmd: number;
      readonly type: number;
      readonly whence: number;
      readonly start: string;
      readonly len: string;
    }
  | {
      readonly id: number;
      readonly op: "export";
      readonly fd: number;
      readonly target: FilesystemConnection;
    }
  | { readonly id: number; readonly op: "import"; readonly token: FilesystemDescriptorToken }
  | { readonly id: number; readonly op: "dispose" };

let client: FilesystemClient | undefined;
let wasi: Wasi | undefined;
let memory: WebAssembly.Memory | undefined;
let fdFlock: ((fd: number, op: number) => number) | undefined;
let fdLock:
  | ((
      fd: number,
      cmd: number,
      type: number,
      whence: number,
      start: bigint,
      len: bigint,
      out: number,
    ) => number)
  | undefined;
let fdClose: ((fd: number) => number) | undefined;
let interruptCell: Int32Array | undefined;

function openPath(path: string, rights: bigint): number {
  const root = client!.preopen("/");
  const resolved = client!.resolve(root, path, true, true);
  if (typeof resolved === "number" || resolved.node === undefined)
    throw new Error(`resolve failed: ${String(resolved)}`);
  const handle = resolved.node;
  client!.retain(handle);
  const resource = { kind: "file" as const, handle, offset: 0, append: false, fdflags: 0 };
  return wasi!.descriptors.open(resource, rights, 0n, () => {
    const lock = resourceOfdLockState(resource);
    if (lock) {
      const ofd = lock.shared ? releaseSharedOfd(resource) : lock.id;
      if (ofd) client!.locks.releaseOfd(handle, ofd);
    } else {
      releaseSharedOfd(resource);
    }
    client!.release(handle);
  });
}

function handleCommand(cmd: Command): unknown {
  if (cmd.op === "open") return openPath(cmd.path, cmd.rights ? BigInt(cmd.rights) : RIGHTS_ALL);
  if (cmd.op === "dup") return wasi!.descriptors.dup(cmd.fd);
  if (cmd.op === "close") return fdClose!(cmd.fd);
  if (cmd.op === "flock") return fdFlock!(cmd.fd, cmd.operation);
  if (cmd.op === "lock") {
    const outPtr = 64;
    const errno = fdLock!(
      cmd.fd,
      cmd.cmd,
      cmd.type,
      cmd.whence,
      BigInt(cmd.start),
      BigInt(cmd.len),
      outPtr,
    );
    if (cmd.cmd !== 0 && cmd.cmd !== 3) return { errno };
    const view = new DataView(memory!.buffer);
    return {
      errno,
      conflict: {
        type: view.getUint32(outPtr, true),
        pid: view.getInt32(outPtr + 4, true),
        start: view.getBigInt64(outPtr + 8, true).toString(),
        len: view.getBigInt64(outPtr + 16, true).toString(),
      },
    };
  }
  if (cmd.op === "export") {
    const codec = createFilesystemDescriptorCodec(client!, cmd.target);
    return codec.export(wasi!.descriptors.get(cmd.fd)!, 2);
  }
  if (cmd.op === "import") {
    const codec = createFilesystemDescriptorCodec(client!);
    const desc = codec.import(cmd.token, 2);
    return wasi!.descriptors.add(desc, { rightsBase: RIGHTS_ALL, rightsInheriting: 0n });
  }
  if (cmd.op === "dispose") {
    wasi?.releasePosixLocks();
    wasi?.descriptors.dispose();
    client?.dispose();
    return true;
  }
  throw new Error(`unknown command`);
}

self.onmessage = ({ data }: MessageEvent) => {
  if (data.init) {
    client = new FilesystemClient(data.connection);
    interruptCell = data.interrupt ? new Int32Array(data.interrupt) : undefined;
    memory = new WebAssembly.Memory({ initial: 4 });
    wasi = new Wasi({
      pid: data.pid,
      args: ["lock-worker"],
      env: {},
      fs: client,
      preopens: { "/": "/" },
      namespaces: { env: { memory } },
      stdout() {},
      stderr() {},
      sleep() {},
      interruptPending: interruptCell ? () => Atomics.load(interruptCell!, 0) !== 0 : undefined,
    });
    const lockMod = guestModule("runtime_fs", [
      { name: "fd_flock", parameters: ["i32", "i32"] },
      { name: "fd_lock", parameters: ["i32", "i32", "i32", "i32", "i64", "i64", "i32"] },
    ]);
    const lockInst = new WebAssembly.Instance(lockMod, wasi.imports(lockMod));
    wasi.start(lockInst);
    fdFlock = guestFunction(lockInst, "fd_flock");
    fdLock = guestFunction(lockInst, "fd_lock");
    const closeMod = guestModule("wasi_snapshot_preview1", [
      { name: "fd_close", parameters: ["i32"] },
    ]);
    const closeInst = new WebAssembly.Instance(closeMod, wasi.imports(closeMod));
    fdClose = guestFunction(closeInst, "fd_close");
    self.postMessage({ ready: true });
    return;
  }
  const cmd = data as Command;
  try {
    const value = handleCommand(cmd);
    self.postMessage({ id: cmd.id, value });
  } catch (error) {
    self.postMessage({ id: cmd.id, error: String(error) });
  }
};
