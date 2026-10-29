import { createGroupMember } from "../../group/member.ts";
import type { MemoryGroupMemberRequest } from "../../group/protocol.ts";

// A member worker for owner-backed ABI tests: owner RPCs block, so they cannot share the
// owner's thread. Each case reports raw import results.
onmessage = ({ data }: MessageEvent<{ request: MemoryGroupMemberRequest; mode: string }>) => {
  const member = createGroupMember(data.request, { checkActive() {} });
  const shm = member.imports;
  try {
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
