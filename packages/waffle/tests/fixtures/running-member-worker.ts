import { createGroupMember, holdExitLock } from "../../group/member.ts";
import type { MemoryGroupMemberRequest } from "../../group/protocol.ts";

export interface RunningMemberRequest {
  /** The busy guest; absent when the member parks instead. */
  readonly module?: WebAssembly.Module;
  readonly memory: WebAssembly.Memory;
  readonly base: number;
  readonly words: number;
  readonly marker: number;
  /** The incarnation's exit lock, held for the life of the thread. */
  readonly lock: string;
  /** Park through the real member's untimed futex_wait32 on `base` instead of spinning. */
  readonly member?: MemoryGroupMemberRequest;
  /** The polling guest's checkpoint returns this word; the page sets it before terminate(). */
  readonly interrupt?: SharedArrayBuffer;
}

function spin(data: RunningMemberRequest): void {
  const word = data.interrupt && new Int32Array(data.interrupt);
  const env: WebAssembly.ModuleImports = { memory: data.memory };
  if (word) env.checkpoint = () => Atomics.load(word, 0);
  const instance = new WebAssembly.Instance(data.module!, { env });
  postMessage({ event: "running" });
  (instance.exports.spin as (base: number, words: number, marker: number) => void)(
    data.base,
    data.words,
    data.marker,
  );
  // A polling guest saw its stop and returned, like a runtime worker posting its exit.
  postMessage({ event: "left" });
}

function park(request: MemoryGroupMemberRequest, base: number): void {
  const member = createGroupMember(request, { checkActive() {} });
  postMessage({ event: "running" });
  try {
    member.imports.futex_wait32!(base, 0, -1n);
  } finally {
    member.dispose();
  }
}

// Same order as the runtime worker: exit lock first, then guest code.
onmessage = ({ data }: MessageEvent<RunningMemberRequest>) => {
  holdExitLock(data.lock).then(
    () => (data.member ? park(data.member, data.base) : spin(data)),
    (error: unknown) => postMessage({ event: `exit lock refused: ${String(error)}` }),
  );
};
