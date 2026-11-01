import { Wasi } from "../core/wasi.ts";
import { RIGHTS_ALL } from "../core/rights.ts";
import { FilesystemClient } from "../fs/client.ts";
import { attachPipeEndpoint } from "../proc/pipes.ts";
import { ThreadService } from "../thread/service.ts";
import { createThreadLaneOwner, type ThreadRequest } from "../thread/lane.ts";
import type { CallKey, ThreadResult } from "../thread/protocol.ts";
import { check, type ServiceCommand, type ServiceEvent } from "./threads-browser-contract.ts";

const lanes = new Map<number, ReturnType<typeof createThreadLaneOwner>>();
const spawns = new Map<number, ReturnType<typeof Promise.withResolvers<number>>>();
let nextRequest = 0;
let state: { service: ThreadService; wasi: Wasi; client: FilesystemClient } | undefined;
function send(event: ServiceEvent) {
  self.postMessage(event);
}
async function initialize(message: Extract<ServiceCommand, { kind: "init" }>) {
  check(!state, "service initialized twice");
  const client = new FilesystemClient(message.connection);
  const wasi = new Wasi({
    args: [],
    env: {},
    fs: client,
    preopens: {},
    stdout() {},
    stderr() {},
    sleep() {},
  });
  const service = new ThreadService({
    directory: "browser-proof",
    pid: 1,
    memory: message.memory,
    filesystem: client,
    descriptors: wasi.descriptors,
  });
  state = { service, wasi, client };
  wasi.descriptors.close(1);
  const stdout = attachPipeEndpoint(message.stdout);
  wasi.descriptors.openAt(1, stdout, RIGHTS_ALL, RIGHTS_ALL);
  const binding = wasi.descriptors.get(1);
  check(binding, "canonical stdout missing");
  wasi.descriptors.inherit(2, binding);
  const root: number = await client.asyncCall("preopen", ["/"]);
  const { node: handle }: { node: number } = await client.asyncCall("resolve", [root, "probe"]);
  client.retain(handle);
  const fd = wasi.descriptors.open(
    { kind: "file", handle, offset: 0, append: false },
    RIGHTS_ALL,
    RIGHTS_ALL,
    () => client.release(handle),
  );
  const call = { thread: { directory: "browser-proof", pid: 1, tid: 1000000 }, sequence: 1 };
  const read = await service.submit(call, {
    kind: "read",
    fd,
    spans: [{ address: 128, length: 19 }],
  });
  check(read.kind === "ok" && read.value === 19, "real filesystem read did not finish");
  const fileBytes = new TextDecoder().decode(
    new Uint8Array(message.memory.buffer, 128, 19).slice(),
  );
  check(fileBytes === "thread-browser-file", "real filesystem bytes changed");
  send({ kind: "ready", fileBytes });
}
async function dispatch(call: CallKey, request: ThreadRequest): Promise<ThreadResult> {
  check(state, "service not initialized");
  if (request.kind !== "spawn") return state.service.submit(call, request);
  const id = ++nextRequest;
  const pending = Promise.withResolvers<number>();
  spawns.set(id, pending);
  send({ kind: "spawn", request: id, startArg: request.startArg });
  const tid = await pending.promise;
  spawns.delete(id);
  return tid > 0 ? { kind: "ok", value: tid } : { kind: "error", errno: -tid };
}
async function retire(tid: number) {
  await lanes.get(tid)?.retire();
  lanes.delete(tid);
  send({ kind: "retired", tid });
}
async function stop() {
  for (const spawn of spawns.values()) spawn.resolve(-6);
  await Promise.all(Array.from(lanes.keys(), retire));
  if (state) {
    state.service.cancelAll();
    const receipt = await state.service.quiesce();
    state.service.disposeCanonical(receipt, state.wasi);
    state.client.dispose();
    state = undefined;
  }
  send({ kind: "stopped", lanes: lanes.size, pendingSpawns: spawns.size });
}
async function command(message: ServiceCommand) {
  if (message.kind === "init") return initialize(message);
  if (message.kind === "spawned") return spawns.get(message.request)?.resolve(message.tid);
  if (message.kind === "retire") return retire(message.tid);
  if (message.kind === "stop") return stop();
  lanes.set(
    message.thread.tid,
    createThreadLaneOwner({
      thread: message.thread,
      lane: message.lane,
      dispatcher: { dispatch },
      terminal: () => !state,
      failed: (error) => send({ kind: "error", message: String(error) }),
    }),
  );
}
self.onmessage = ({ data }: MessageEvent<ServiceCommand>) => {
  void command(data).catch((error: unknown) =>
    send({
      kind: "error",
      message: error instanceof Error ? (error.stack ?? error.message) : String(error),
    }),
  );
};
