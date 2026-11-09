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

onmessage = ({ data }: MessageEvent<{ request: MemoryGroupMemberRequest; mode: string }>) => {
  const member = createGroupMember(data.request, { checkActive() {} });
  const shm = member.imports;
  try {
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
