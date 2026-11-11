import { parseModuleMemory } from "../memory/declarations.js";
import type { Runtime, ProcessService } from "../index.js";
import type { FilesystemConnection } from "../fs/protocol.js";
import { createPreview1Network } from "../browser/preview1-network.js";
import type { RuntimeWorkerMessage, RuntimeWorkerRequest } from "../browser/worker.js";
import type { NetworkCommand } from "./network-browser-worker.js";

type Peer = { call(command: NetworkCommand): Promise<unknown> };
function check(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error(`${label} timed out`)), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function read(peer: Peer, handle: number) {
  for (let i = 0; i < 300; i++) {
    const value = await peer.call({ op: "read", handle, cap: 64 });
    if (value !== -2) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Error("Preview 1 loopback peer read timed out");
}

/** The normal Preview 1 worker accepts NetHost traffic in this page's single runtime. */
export async function preview1ListenerBrowserCases(runtime: Runtime, peer: Peer): Promise<void> {
  const listening = Promise.withResolvers<void>();
  const owner = await createPreview1Network(runtime, {
    sockets: [{ fd: 3, socket: { listen: { host: "127.0.0.1", port: 32161 } } }],
  });
  check(owner, "Listener binding did not create a helper");
  let filesystem: FilesystemConnection | undefined;
  let service: ProcessService | undefined;
  let root: number | undefined;
  let actor: { kind: "no-agent" } | { kind: "worker"; worker: Worker } = { kind: "no-agent" };
  let conn: number | undefined;
  try {
    const response = await fetch("/preview1-listener.wasm");
    check(response.ok, "Listener WAT fixture missing");
    const source = new Uint8Array(await response.arrayBuffer());
    const module = await WebAssembly.compile(source);
    service = await runtime.processes();
    filesystem = runtime.filesystem.fork();
    const control = service;
    const pid = (root = await service.adoptRoot(
      { pid: runtime.identities.pid(), memory: parseModuleMemory(source) },
      {
        filesystem,
        stop: () => {
          if (actor.kind === "worker") return actor.worker.terminate();
        },
      },
    ));
    const controlGrant = service.rootControlGrant(pid);
    const worker = new Worker("/listener-preview1-worker.js", { type: "module" });
    actor = { kind: "worker", worker };
    const exit = Promise.withResolvers<number>();
    worker.onerror = (event) => {
      event.preventDefault();
      exit.reject(Error(event.message));
    };
    worker.onmessage = ({ data }: MessageEvent<RuntimeWorkerMessage>) => {
      if (data.type === "shared-control-allocation") {
        control.rootControlAllocated(pid, data.buffer);
        return;
      }
      if (data.type === "stdout") listening.resolve();
      if (data.type === "exit") exit.resolve(data.code);
      if (data.type === "error" || data.type === "cleanup-error")
        exit.reject(Error(JSON.stringify(data)));
    };
    void exit.promise.catch(() => {});
    worker.postMessage(
      {
        module,
        controlGrant,
        args: [],
        env: {},
        filesystem,
        network: owner.connection,
      } satisfies RuntimeWorkerRequest,
      [filesystem.port, owner.connection.port],
    );
    await bounded(
      Promise.race([
        listening.promise,
        exit.promise.then(() => {
          throw Error("Guest exited before listen");
        }),
      ]),
      "Listener registration",
    );
    conn = Number(await peer.call({ op: "connect", host: "127.0.0.1", port: 32161 }));
    check(conn > 0, "Bun-shaped same-runtime peer connect failed");
    check(
      (await peer.call({
        op: "write",
        handle: conn,
        bytes: new TextEncoder().encode("loopback"),
      })) === 8,
      "Bun-shaped peer write failed",
    );
    await peer.call({ op: "shutdown", handle: conn });
    const echo = await read(peer, conn);
    check(
      echo instanceof Uint8Array && new TextDecoder().decode(echo) === "loopback",
      "Accepted socket lost bytes",
    );
    check((await read(peer, conn)) === 0, "Accepted socket did not send FIN");
    check((await bounded(exit.promise, "Listener guest exit")) === 0, "Listener guest failed");
    owner.dispose();
    check(
      (await peer.call({ op: "connect", port: 32161 })) === -1,
      "Listener survived owner disposal",
    );
  } finally {
    owner.dispose();
    if (filesystem) await runtime.filesystem.quiesce(filesystem);
    if (actor.kind === "worker") {
      await actor.worker.terminate();
      actor = { kind: "no-agent" };
    }
    if (root !== undefined) service!.rootStopped(root);
    filesystem?.port.close();
    if (conn !== undefined && conn > 0) await peer.call({ op: "close", handle: conn });
  }
}
