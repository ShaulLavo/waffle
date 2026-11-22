import { MemoryBackend } from "../../fs/backend.js";
import { requestBytes, requestCells, receiveRequestBuffer } from "../../fs/request-memory.js";
import {
  State,
  unpack,
  type FilesystemConnection,
  type RequestMessage,
} from "../../fs/protocol.js";
import { installFilesystemWorker } from "../../fs/service.js";

type Action = "gate" | "transport" | "errno11";
type Control = { kind: "arm"; path: string; action: Action } | { kind: "forward" | "release" };
type Gate = {
  readonly path: string;
  readonly action: Action;
  readonly backend: PromiseWithResolvers<void>;
  forward?: () => void;
};
const controls = new BroadcastChannel(new URL(location.href).searchParams.get("control")!);
let gate: Gate | undefined;
controls.onmessage = ({ data }: MessageEvent<Control>) => {
  if (data.kind === "arm") {
    gate = { path: data.path, action: data.action, backend: Promise.withResolvers() };
    controls.postMessage({ kind: "armed", path: gate.path });
    return;
  }
  if (data.kind === "forward") gate?.forward?.();
  if (data.kind === "release") gate?.backend.resolve();
};

class GatedBackend extends MemoryBackend {
  override execute(operation: string, args: unknown[], bytes: Uint8Array): unknown {
    const value = super.execute(operation, args, bytes);
    const held = gate;
    if (!held || operation !== "resolve" || held.path !== args[1] || !held.forward) return value;
    const result = held.action === "errno11" ? 11 : value;
    controls.postMessage({
      kind: "backend",
      path: held.path,
      errno: typeof result === "number" ? result : null,
    });
    return held.backend.promise.then(() => result);
  }
}

function intercept(connection: FilesystemConnection): void {
  const port = connection.port;
  const onmessage = Object.getOwnPropertyDescriptor(MessagePort.prototype, "onmessage")!;
  const post = port.postMessage.bind(port);
  const preopens = new Map<number, Int32Array>();
  let preopened = false;
  port.postMessage = (message: { completed?: number }) => {
    if (typeof message.completed === "number") {
      const cells = preopens.get(message.completed);
      if (cells) {
        preopens.delete(message.completed);
        preopened ||= Atomics.load(cells, 0) === State.Complete;
        // The guest may already have recycled the reply slot. Successful startup still
        // requires the earlier reply and reaches the target only after that preopen.
        preopened ||= Atomics.load(cells, 0) === State.Pending;
      }
    }
    post(message);
  };
  Object.defineProperty(port, "onmessage", {
    configurable: true,
    set(receive: (event: MessageEvent<RequestMessage>) => void) {
      onmessage.set!.call(port, (event: MessageEvent<RequestMessage>) => {
        if (holdRequest(connection, event, receive, preopens, preopened)) return;
        receive(event);
      });
    },
  });
}

function holdRequest(
  connection: FilesystemConnection,
  event: MessageEvent<RequestMessage>,
  receive: (event: MessageEvent<RequestMessage>) => void,
  preopens: Map<number, Int32Array>,
  preopened: boolean,
): boolean {
  const data = event.data;
  if (!("id" in data)) return false;
  const { id, generation, offset, length, payload } = data;
  const buffer = receiveRequestBuffer(connection.requests, id, generation, offset, length, payload);
  const cells = requestCells(buffer);
  const bytes = payload ? new Uint8Array(payload) : requestBytes(buffer);
  const { operation, args } = unpack(bytes.subarray(0, cells[1]!));
  if (operation === "preopen") preopens.set(id, cells);
  const held = gate;
  if (!held || operation !== "resolve" || held.path !== args[1] || held.forward) return false;
  if (!preopened) throw new Error("Target resolve reached the gate before startup preopen");
  held.forward = () => {
    const forwarded =
      held.action === "transport"
        ? new MessageEvent<RequestMessage>("message", { data: { ...data, offset: -1 } })
        : event;
    receive(forwarded);
  };
  controls.postMessage({ kind: "held", path: held.path, id, preopened });
  return true;
}

const scope: {
  onmessage: ((event: MessageEvent<{ connect?: FilesystemConnection }>) => void) | null;
  postMessage: (message: unknown) => void;
} = { onmessage: null, postMessage: globalThis.postMessage.bind(globalThis) };
installFilesystemWorker(scope, () => new GatedBackend());
globalThis.onmessage = (event) => {
  if (event.data.connect) intercept(event.data.connect);
  if (event.data.dispose) controls.close();
  scope.onmessage?.(event);
};
