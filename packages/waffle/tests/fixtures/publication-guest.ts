import { fixturePayloadHooks, coldPublicationRoot } from "./publication-storage";
import { nextReservation } from "../../fs/file-identity";
import {
  FilesystemClient,
  FilesystemService,
  MemoryBackend,
  type FilesystemConnection,
} from "../../fs";
import { Wasi } from "../../core/wasi";
import { DescriptorTable, type Resource } from "../../core/descriptors";
import { shareFileResource } from "../../core/open-file";
import { ProcessABI, type ProcessService } from "../../proc/abi";
import { createSignalState } from "../../proc/signals";
import { outcomeWord } from "../../proc/outcome";
import { PersistentBackend } from "../../fs/persistent";
import { guestFunction, publicationProcModule, publicationWasiModule } from "./publication-wasm";

interface Setup {
  readonly connection: FilesystemConnection;
  readonly mode: "wasi" | "proc";
  readonly admissionGate?: SharedArrayBuffer;
}
interface Call {
  readonly operation:
    | "write"
    | "offsetWrite"
    | "read"
    | "append"
    | "directWrite"
    | "directAppend"
    | "inspect";
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
  if (request.operation === "inspect") {
    const output = new Uint8Array(128);
    const result = guest.client.tryRead(guest.resource.handle, [output], 0);
    return { result, bytes: Array.from(output.subarray(0, Math.max(0, result))) };
  }
  if (request.operation === "directWrite")
    return guest.client.tryWrite(guest.resource.handle, [new Uint8Array([request.byte])], 0);
  if (request.operation === "directAppend")
    return guest.client.tryAppend(guest.resource.handle, [new Uint8Array([request.byte])]);
  const bytes = new Uint8Array(guest.memory.buffer, 256, 1);
  bytes[0] = request.byte;
  const view = new DataView(guest.memory.buffer);
  view.setUint32(0, 256, true);
  view.setUint32(4, 1, true);
  view.setUint32(32, 0xdeadbeef, true);
  let result: number;
  guest.resource.append = request.operation === "append";
  if (guest.mode === "proc")
    result = guestFunction(guest.instance, request.operation === "read" ? "read" : "write")(
      guest.fd,
      256,
      1,
    );
  else if (request.operation === "read")
    result = guestFunction(guest.instance, "fd_read")(guest.fd, 0, 1, 32);
  else if (request.operation === "offsetWrite" || request.operation === "append")
    result = guestFunction(guest.instance, "fd_write")(guest.fd, 0, 1, 32);
  else result = guestFunction(guest.instance, "fd_pwrite")(guest.fd, 0, 1, 0n, 32);
  return { result, offset: guest.resource.offset, byte: bytes[0], count: view.getUint32(32, true) };
}
function pauseAdmission(connection: FilesystemConnection, buffer: SharedArrayBuffer): void {
  const control = connection.publication?.buffers.control;
  const gate = new Int32Array(buffer);
  const original = Atomics.compareExchange;
  Atomics.compareExchange = function (array, index, expected, replacement) {
    const previous = Reflect.apply(original, Atomics, [array, index, expected, replacement]);
    if (array.buffer !== control || index !== 1 || expected !== 0 || previous !== 0)
      return previous;
    Atomics.compareExchange = original;
    self.postMessage({ admissionHeld: true });
    while (!Atomics.load(gate, 0)) Atomics.wait(gate, 0, 0);
    return previous;
  };
}
interface ServiceSetup {
  readonly connection: FilesystemConnection;
  readonly mode: "service";
  readonly cold?: boolean;
}
type ServiceControl =
  | { readonly control: "releaseLoad" | "serviceState" | "deliverResponse" }
  | { readonly control: "holdResponse"; readonly id: number };
let service: FilesystemService | undefined;
let backend: MemoryBackend | undefined;
let releaseLoad: (() => void) | undefined;
let hydrationCount = 0;
let heldResponse: (() => void) | undefined;
let responseId = -1;
async function installService(request: ServiceSetup): Promise<void> {
  if (request.cold) {
    const pending = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    backend = await PersistentBackend.open(
      {
        ...fixturePayloadHooks(new Map([["fixture-payload", new Uint8Array([1, 2, 3])]])),
        async reserveIdentity() {
          return nextReservation(undefined);
        },
        async load() {
          return coldPublicationRoot();
        },
        async read() {
          self.postMessage({ reading: true });
          await pending;
          return new Uint8Array([1, 2, 3]);
        },
        async persist() {},
        async flush() {},
        async close() {},
      },
      { intervalMs: 0 },
    );
  } else {
    backend = new MemoryBackend();
    backend.fs.writeFile("/file", new Uint8Array([1, 2, 3]));
  }
  const post = request.connection.port.postMessage.bind(request.connection.port);
  request.connection.port.postMessage = (message: unknown) => {
    if (
      message &&
      typeof message === "object" &&
      "completed" in message &&
      (responseId === -2 || message.completed === responseId)
    ) {
      responseId = -1;
      heldResponse = () => post(message);
      self.postMessage({ responseHeld: true });
      return;
    }
    post(message);
  };
  service = new FilesystemService(backend);
  service.connect(request.connection);
  if (request.cold) {
    const hydrate = backend.shared.hydrate.bind(backend.shared);
    backend.shared.hydrate = (handle, bytes) => {
      hydrationCount++;
      return hydrate(handle, bytes);
    };
  }
  self.postMessage({ ready: true });
}
async function serviceControl(request: ServiceControl): Promise<void> {
  if (request.control === "releaseLoad") {
    releaseLoad?.();
    if (backend instanceof PersistentBackend) await backend.prepare("read", [fixtureHandle()]);
  }
  if (request.control === "holdResponse") responseId = request.id;
  if (request.control === "deliverResponse") {
    heldResponse?.();
    heldResponse = undefined;
    responseId = -1;
  }
  service?.sweep();
  self.postMessage({
    hydrations: hydrationCount,
    resident: backend?.shared.isResident(fixtureHandle()),
    resources: service?.resources(),
    diagnostics: backend?.shared.publication?.diagnostics(),
  });
}
function fixtureHandle(): number {
  const node = backend?.fs.lookup("/file");
  if (!node || !backend) throw new Error("Missing fixture inode");
  return backend.fs.handleForNode(node);
}
function initialize(request: Setup | ServiceSetup): void {
  if (request.mode === "service") {
    void installService(request).catch((error) => self.postMessage({ failure: String(error) }));
    return;
  }
  guest = setup(request);
  if (request.admissionGate) pauseAdmission(request.connection, request.admissionGate);
  self.postMessage({ ready: true });
}
let guest: ReturnType<typeof setup> | undefined;
self.onmessage = ({
  data,
}: MessageEvent<Setup | ServiceSetup | ServiceControl | Call | "stop">) => {
  try {
    if (data === "stop") {
      service?.dispose();
      if (backend instanceof PersistentBackend) backend.dispose();
      guest?.descriptors.dispose();
      guest?.client.dispose();
      self.postMessage({ stopped: true });
      return;
    }
    if ("connection" in data) {
      initialize(data);
      return;
    }
    if ("control" in data) {
      void serviceControl(data).catch((error) => self.postMessage({ failure: String(error) }));
      return;
    }
    if (!guest) throw new Error("publication fixture is not initialized");
    self.postMessage(call(guest, data));
  } catch (error) {
    self.postMessage({ failure: String(error) });
  }
};
