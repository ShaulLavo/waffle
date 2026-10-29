import { FilesystemSection, isRevoked } from "../fs/section.js";
import { SharedFilesystemState } from "../fs/shared.js";
import type { FilesystemIdentity } from "../fs/protocol.js";
import {
  CONTROL_ABORT,
  CONTROL_HEARTBEAT,
  CONTROL_LIVE_SHARDS,
  FileReader,
  readAndScan,
  type IndexedResult,
  type ShardFile,
  type ShardProgram,
  type ShardReply,
  type ShardRequest,
} from "./shards.js";

// A nested worker of one search process. It loads only Waffle modules and never runs guest
// code. Every shared-page read enters the process's own filesystem section, so the process
// kill fence covers it, and revocation stops it at the next section entry.
const post = globalThis.postMessage.bind(globalThis) as (
  reply: ShardReply,
  transfer?: Transferable[],
) => void;

interface Shard {
  readonly state: SharedFilesystemState;
  readonly identity: FilesystemIdentity;
  readonly control: Int32Array;
  readonly program: ShardProgram;
  readonly reader: FileReader;
  readonly revoked: () => boolean;
  readonly alive: () => void;
}
let shard: Shard | undefined;
let stopped = false;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let liveness: ReturnType<typeof setInterval> | undefined;

function start(request: Extract<ShardRequest, { type: "start" }>): void {
  const identity = request.identity;
  const control = new Int32Array(request.control);
  const words = new Int32Array(request.liveness);
  const alive = () => void Atomics.add(words, request.slot, 1);
  const state = new SharedFilesystemState(
    identity.shared,
    identity.maxBytes,
    identity.owner,
    identity.segments,
    new FilesystemSection(identity),
    identity.publication?.buffers,
  );
  shard = {
    state,
    identity,
    control,
    program: request.program,
    reader: new FileReader(control, request.fileBytes),
    revoked: () => isRevoked(identity) || Atomics.load(control, CONTROL_ABORT) !== 0,
    alive,
  };
  liveness = setInterval(alive, 50);
  Atomics.add(control, CONTROL_LIVE_SHARDS, 1);
  if (request.heartbeat)
    heartbeat = setInterval(() => Atomics.add(control, CONTROL_HEARTBEAT, 1), 5);
  post({ type: "ready" });
}

function scan(active: Shard, file: ShardFile): IndexedResult {
  const slot = active.state.fileSlot(file.handle);
  if (!slot) return { index: file.index, kind: "fallback" };
  const result = readAndScan(active.reader, active.program, (chunk, offset) => {
    active.alive();
    return active.state.directRead(
      slot,
      file.handle,
      [chunk],
      offset,
      active.revoked,
      active.identity.owner,
    );
  });
  return { index: file.index, ...result };
}

function batch(id: number, files: readonly ShardFile[]): void {
  const active = shard;
  if (!active) throw new Error("search shard received a batch before start");
  const results = files.map((file) => scan(active, file));
  const transfer = results.flatMap((result) =>
    result.kind === "done" && result.output ? [result.output.buffer as ArrayBuffer] : [],
  );
  post({ type: "batch", id, results }, transfer);
}

function stop(): void {
  if (stopped) return;
  stopped = true;
  clearInterval(heartbeat);
  clearInterval(liveness);
  if (shard) Atomics.sub(shard.control, CONTROL_LIVE_SHARDS, 1);
  shard = undefined;
  post({ type: "stopped" });
}

globalThis.onmessage = ({ data }: MessageEvent<ShardRequest>) => {
  if (stopped) return;
  if (data.type === "start") start(data);
  else if (data.type === "batch") batch(data.id, data.files);
  else stop();
};
