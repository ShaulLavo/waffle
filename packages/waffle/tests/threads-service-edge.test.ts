import { expect, test } from "bun:test";
import { serviceFixture } from "./threads-service-fixture.ts";

function nextTurn(): Promise<"pending"> {
  return new Promise((resolve) => setImmediate(() => resolve("pending")));
}

for (const kind of ["read", "write"] as const) {
  test(`nonblocking pipe ${kind} returns EAGAIN without waiting for notification`, async () => {
    const value = await serviceFixture();
    try {
      const endpoint = kind === "read" ? value.reader : value.writer;
      endpoint.fdflags = 4;
      const fd =
        kind === "read" ? value.descriptors.open(endpoint, 0x1fffffffn, 0n) : value.writerFd;
      if (kind === "write") expect(value.writer.tryWrite([new Uint8Array(65536)])).toBe(65536);
      const pending = value.service.submit(value.call(), {
        kind,
        fd,
        spans: [{ address: 64, length: 1 }],
      });
      expect(await Promise.race([pending, nextTurn()])).toEqual({ kind: "error", errno: 6 });
    } finally {
      await value.dispose();
    }
  });
}

for (const spans of [[], [{ address: 64, length: 0 }]]) {
  test(`zero-byte append with ${spans.length} iovecs leaves cursor and file unchanged`, async () => {
    const value = await serviceFixture("growth");
    try {
      value.send({ kind: "release" });
      value.resource.append = true;
      expect(
        await value.service.submit(value.call(), { kind: "write", fd: value.fd, spans }),
      ).toEqual({ kind: "ok", value: 0 });
      expect(value.resource.offset).toBe(0);
      expect((await value.client.asyncCall("stat", [value.resource.handle])).size).toBe(65536);
    } finally {
      await value.dispose();
    }
  });
}

test("a blocking pipe call keeps its admitted flags when a sibling changes the description", async () => {
  const value = await serviceFixture();
  try {
    const fd = value.descriptors.open(value.reader, 0x1fffffffn, 0n);
    const pending = value.service.submit(value.call(), {
      kind: "read",
      fd,
      spans: [{ address: 64, length: 1 }],
    });
    value.reader.fdflags = 4;
    expect(await Promise.race([pending, nextTurn()])).toBe("pending");
    expect(value.writer.tryWrite([new Uint8Array([71])])).toBe(1);
    expect(await pending).toEqual({ kind: "ok", value: 1 });
    expect(new Uint8Array(value.memory.buffer)[64]).toBe(71);
  } finally {
    await value.dispose();
  }
});

test("explicit close failure remains in final cleanup without repeating release", async () => {
  const value = await serviceFixture();
  const failure = new Error("explicit resource release failed");
  let releases = 0;
  try {
    const fd = value.descriptors.open(
      {
        kind: "device",
        device: "null",
        read: () => 0,
        write: () => 0,
        readiness: () => ({ readable: true, writable: true, hangup: false }),
      },
      0n,
      0n,
      () => {
        releases++;
        throw failure;
      },
    );
    expect(() => value.service.submit(value.call(), { kind: "close", fd })).toThrow(failure);
    expect(value.descriptors.get(fd)).toBeUndefined();
    await expect(value.service.quiesce()).rejects.toThrow("thread service drain failed");
    await expect(value.service.quiesce()).rejects.toThrow("thread service drain failed");
    expect(releases).toBe(1);
  } finally {
    await expect(value.dispose()).rejects.toThrow("thread fixture teardown failed");
  }
});
