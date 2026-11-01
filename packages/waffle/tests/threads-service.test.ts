import { expect, test } from "bun:test";
import { DescriptorTable } from "../core/descriptors.ts";
import { RIGHTS_ALL } from "../core/rights.ts";
import { ThreadService } from "../thread/service.ts";
import { residentReadFixture } from "./fixtures/workspace-read.ts";

export async function serviceFixture() {
  const filesystem = await residentReadFixture(8);
  const descriptors = new DescriptorTable();
  const resource = { kind: "file", handle: filesystem.handle, offset: 0, append: false } as const;
  const fd = descriptors.open(resource, RIGHTS_ALL, RIGHTS_ALL);
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
  const service = new ThreadService({
    directory: "test",
    pid: 1,
    memory,
    filesystem: filesystem.client,
    descriptors,
  });
  let sequence = 0;
  const call = (tid = 1) => ({ thread: { directory: "test", pid: 1, tid }, sequence: ++sequence });
  return {
    ...filesystem,
    descriptors,
    resource,
    fd,
    memory,
    service,
    call,
    async dispose() {
      service.cancelAll();
      await service.drain();
      descriptors.dispose();
      await filesystem.close();
    },
  };
}

test("the thread service submits real file reads and advances the shared cursor once", async () => {
  const value = await serviceFixture();
  try {
    expect(
      await value.service.submit(value.call(), {
        kind: "read",
        fd: value.fd,
        spans: [{ address: 64, length: 3 }],
      }),
    ).toEqual({ kind: "ok", value: 3 });
    expect(new Uint8Array(value.memory.buffer, 64, 3)).toEqual(new Uint8Array([65, 65, 65]));
    expect(value.resource.offset).toBe(3);
    expect(await value.service.submit(value.call(), { kind: "tell", fd: value.fd })).toEqual({
      kind: "ok",
      value: 3,
    });
  } finally {
    await value.dispose();
  }
});
