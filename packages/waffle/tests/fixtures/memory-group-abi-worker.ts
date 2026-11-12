import { createGroupMember, type GroupMember } from "../../group/member.ts";
import type { MemoryGroupMemberRequest } from "../../group/protocol.ts";

// A member worker for owner-backed ABI tests: owner RPCs block, so they cannot share the
// owner's thread. Each case reports raw import results.
const MEMORY = 1;

/** Publication imports over the real port, reporting every status and output word unsigned. */
function publications(shm: GroupMember["imports"], memory: WebAssembly.Memory) {
  const words = (at: number, count: number) =>
    Array.from({ length: count }, (_, index) =>
      new DataView(memory.buffer).getUint32(at + index * 4, true),
    );
  const bad = [0xfffffff8 | 0, 3, -4];
  shm.shm_create!(65536, 65536, 16);
  shm.shm_create!(16, 16, 24);
  const [data, base, cell, cellBase] = words(16, 4);
  const publishBad = bad.map((out) => shm.shm_publish!(MEMORY, data!, cell!, 1, out));
  const published = shm.shm_publish!(MEMORY, data!, cell!, 1, 32);
  const [token] = words(32, 1);
  const openBad = bad.map((out) => shm.shm_publication_open!(token!, MEMORY, out));
  const opened = shm.shm_publication_open!(token!, MEMORY, 64);
  return {
    region: [data!, base!, cell!, cellBase!],
    publishBad,
    published: [published, token!],
    openBad,
    opened: [opened].concat(words(64, 7)),
    wrongKind: [shm.shm_publication_open!(token!, 2, 64)],
    withdraw: [shm.shm_withdraw!(token!), shm.shm_withdraw!(token!)],
  };
}

type Request =
  | { request: MemoryGroupMemberRequest; mode: "grow"; pages: readonly number[] }
  | { request: MemoryGroupMemberRequest; mode: "outputs" | "publications" | "group-pin" }
  | { request: MemoryGroupMemberRequest; mode: "unpin"; pin: number; gate: SharedArrayBuffer };

function racedUnpin(shm: GroupMember["imports"], pin: number, gate: SharedArrayBuffer): number {
  const controls = new Int32Array(gate);
  Atomics.add(controls, 0, 1);
  Atomics.notify(controls, 0);
  while (Atomics.load(controls, 1) === 0) Atomics.wait(controls, 1, 0);
  return shm.shm_unpin!(pin | 0);
}

onmessage = ({ data }: MessageEvent<Request>) => {
  const member = createGroupMember(data.request, { checkActive() {} });
  const shm = member.imports;
  try {
    if (data.mode === "unpin") {
      postMessage(racedUnpin(shm, data.pin, data.gate));
      return;
    }
    if (data.mode === "group-pin") {
      const view = () => new DataView(member.memory.buffer);
      const created = shm.shm_create!(65536, 65536, 16);
      const handle = view().getUint32(16, true);
      const addr = view().getUint32(20, true);
      const pinned = shm.shm_pin!(handle, 24);
      const pin = view().getUint32(24, true);
      view().setUint32(addr, pin, true);
      const detached = shm.shm_detach!(handle);
      const routed = shm.shm_route_group!(pin | 0);
      postMessage({
        created,
        pinned,
        handle,
        addr,
        pin,
        detached,
        routed,
        repeated: shm.shm_route_group!(pin | 0),
        route: shm.shm_route!(pin | 0, 999),
        accept: shm.shm_accept!(pin | 0, 32),
      });
      return;
    }
    if (data.mode === "grow") {
      postMessage(
        data.pages.map((pages) => ({
          page: shm.group_grow!(pages),
          bytes: member.memory.buffer.byteLength,
        })),
      );
      return;
    }
    if (data.mode === "publications") {
      postMessage(publications(shm, member.memory));
      return;
    }
    const bad = [0xfffffff8 | 0, 3, -4];
    const results: Record<string, number[]> = {
      create: bad.map((out) => shm.shm_create!(16, 16, out)),
      valid: [shm.shm_create!(16, 16, 16)],
    };
    const handle = new DataView(member.memory.buffer).getUint32(16, true);
    results.attach = bad.map((out) => shm.shm_attach!(handle, out));
    results.pin = bad.map((out) => shm.shm_pin!(handle, out));
    results.pinned = [shm.shm_pin!(handle, 32)];
    const pin = new DataView(member.memory.buffer).getUint32(32, true);
    results.accept = bad.map((out) => shm.shm_accept!(pin, out));
    results.accepted = [shm.shm_accept!(pin, 48)];
    postMessage(results);
  } finally {
    member.dispose();
  }
};
