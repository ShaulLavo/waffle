import { FilesystemClient, type FilesystemConnection } from "../../fs";
import { Wasi } from "../../core/wasi";
import { DescriptorTable, type Resource } from "../../core/descriptors";
import { shareFileResource } from "../../core/open-file";
import { ProcessABI, type ProcessService } from "../../proc/abi";
import { createSignalState } from "../../proc/signals";
import { outcomeWord } from "../../proc/outcome";
import { guestFunction, publicationProcModule, publicationWasiModule } from "./publication-wasm";

interface Setup {
  readonly connection: FilesystemConnection;
  readonly mode: "wasi" | "proc";
}
interface Call {
  readonly operation: "write" | "read" | "append";
  readonly byte: number;
}
function unusedService(): ProcessService {
  const unused = (): never => {
    throw new Error("unexpected fixture process call");
  };
  return {
    spawn: unused,
    startStatus: unused,
    waitJob: unused,
    jobEmpty: unused,
    wait: unused,
    childExited: unused,
    kill: unused,
    killJob: unused,
    jobOf: unused,
    defaultSignal: unused,
  };
}
function setup({ connection, mode }: Setup) {
  const client = new FilesystemClient(connection);
  const directory: number = client.call("preopen", ["/"]);
  const path: { node: number } = client.call("resolve", [directory, "file"]);
  client.retain(path.node);
  const memory = new WebAssembly.Memory({ initial: 4 });
  const resource: Extract<Resource, { kind: "file" }> = {
    kind: "file",
    handle: path.node,
    offset: 0,
    append: false,
  };
  shareFileResource(resource, connection);
  const rights = (1n << 1n) | (1n << 2n) | (1n << 6n);
  if (mode === "wasi") {
    const wasi = new Wasi({
      args: [],
      env: {},
      fs: client,
      preopens: {},
      namespaces: { env: { memory } },
      stdout() {},
      stderr() {},
      sleep() {
        throw new Error("fixture WASI slept");
      },
    });
    const module = publicationWasiModule();
    const instance = new WebAssembly.Instance(module, wasi.imports(module));
    wasi.start(instance);
    const fd = wasi.descriptors.open(resource, rights, 0n);
    return { client, memory, resource, fd, instance, descriptors: wasi.descriptors, mode };
  }
  const descriptors = new DescriptorTable();
  const fd = descriptors.open(resource, rights, 0n);
  const abi = new ProcessABI({
    memory,
    descriptors,
    fs: client,
    pid: 7,
    service: unusedService(),
    signals: {
      signalState: createSignalState(),
      interrupt: new Int32Array(new SharedArrayBuffer(4)),
      requestedSignal: new Int32Array(new SharedArrayBuffer(4)),
      outcome: outcomeWord(),
    },
    wait() {
      throw new Error("nonblocking fixture slept");
    },
  });
  const instance = new WebAssembly.Instance(publicationProcModule(), {
    env: { memory },
    runtime_proc: abi.imports,
  });
  client.call = () => {
    throw new Error("nonblocking fixture used blocking RPC");
  };
  client.shared.onContention = () => {
    throw new Error("nonblocking fixture spun");
  };
  return { client, memory, resource, fd, instance, descriptors, mode };
}
function call(guest: ReturnType<typeof setup>, request: Call) {
  const bytes = new Uint8Array(guest.memory.buffer, 256, 1);
  bytes[0] = request.byte;
  const view = new DataView(guest.memory.buffer);
  view.setUint32(0, 256, true);
  view.setUint32(4, 1, true);
  view.setUint32(32, 0xdeadbeef, true);
  let result: number;
  if (guest.mode === "proc")
    result = guestFunction(guest.instance, request.operation)(guest.fd, 256, 1);
  else if (request.operation === "read")
    result = guestFunction(guest.instance, "fd_read")(guest.fd, 0, 1, 32);
  else result = guestFunction(guest.instance, "fd_pwrite")(guest.fd, 0, 1, 0n, 32);
  return { result, offset: guest.resource.offset, byte: bytes[0], count: view.getUint32(32, true) };
}
let guest: ReturnType<typeof setup> | undefined;
self.onmessage = ({ data }: MessageEvent<Setup | Call | "stop">) => {
  try {
    if (data === "stop") {
      guest?.descriptors.dispose();
      guest?.client.dispose();
      self.postMessage({ stopped: true });
      return;
    }
    if ("connection" in data) {
      guest = setup(data);
      self.postMessage({ ready: true });
      return;
    }
    if (!guest) throw new Error("publication fixture is not initialized");
    self.postMessage(call(guest, data));
  } catch (error) {
    self.postMessage({ failure: String(error) });
  }
};
