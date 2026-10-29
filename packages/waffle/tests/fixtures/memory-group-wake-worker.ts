import { createGroupMember } from "../../group/member.ts";
import type { MemoryGroupMemberRequest } from "../../group/protocol.ts";

// A second agent issuing one-count wakes against watches registered by another agent.
onmessage = ({
  data,
}: MessageEvent<{ request: MemoryGroupMemberRequest; addr: number; count: number }>) => {
  const member = createGroupMember({ ...data.request, index: 1 }, { checkActive() {} });
  let total = 0;
  for (let index = 0; index < data.count; index++)
    total += member.imports.futex_wake!(data.addr, 1);
  member.dispose();
  postMessage(total);
};
