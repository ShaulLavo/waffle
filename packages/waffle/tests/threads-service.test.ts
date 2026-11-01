import { expect, test } from "bun:test";
import { claimFileOffset, shareFileResource } from "../core/open-file.ts";
import { serviceFixture } from "./threads-service-fixture.ts";

test("the thread service submits real file reads and advances the shared cursor once", async () => {
  const value = await serviceFixture();
  try {
    value.send({ kind: "release" });
    expect(
      await value.service.submit(value.call(), {
        kind: "read",
        fd: value.fd,
        spans: [{ address: 64, length: 3 }],
      }),
    ).toEqual({ kind: "ok", value: 3 });
    expect(new Uint8Array(value.memory.buffer, 64, 3)).toEqual(new Uint8Array([65, 65, 65]));
    expect(value.resource.offset).toBe(3);
    value.send({ kind: "release" });
    expect(await value.service.submit(value.call(), { kind: "tell", fd: value.fd })).toEqual({
      kind: "ok",
      value: 3,
    });
  } finally {
    await value.dispose();
  }
});

for (const mode of ["cold", "growth"] as const) {
  test(`${mode} filesystem preparation keeps a sibling pipe and close runnable`, async () => {
    const value = await serviceFixture(mode);
    try {
      new Uint8Array(value.memory.buffer, 64, 3).set([80, 81, 82]);
      if (mode === "growth") value.resource.offset = 65536;
      let settled = false;
      const pending = value.service
        .submit(value.call(), {
          kind: mode === "cold" ? "read" : "write",
          fd: value.fd,
          spans: [{ address: 64, length: 3 }],
        })
        .then((result) => {
          settled = true;
          return result;
        });
      await value.event("held");
      expect(settled).toBe(false);
      expect(new Int32Array(value.pair.client.sections)[0]).toBe(0);
      expect(
        await value.service.submit(value.call(2), {
          kind: "write",
          fd: value.writerFd,
          spans: [{ address: 64, length: 3 }],
        }),
      ).toEqual({ kind: "ok", value: 3 });
      const bytes = new Uint8Array(3);
      expect(value.reader.tryRead([bytes])).toBe(3);
      expect(bytes).toEqual(new Uint8Array([80, 81, 82]));
      const description = value.descriptors.get(value.fd)!.description;
      expect(await value.service.submit(value.call(3), { kind: "close", fd: value.fd })).toEqual({
        kind: "ok",
        value: 0,
      });
      expect(description.references).toBe(1);
      const replacement = value.descriptors.open(
        {
          kind: "device",
          device: "null",
          read: () => 0,
          write: () => 0,
          readiness: () => ({ readable: true, writable: true, hangup: false }),
        },
        0n,
        0n,
      );
      expect(replacement).toBe(value.fd);
      expect(await value.service.submit(value.call(3), { kind: "tell", fd: replacement })).toEqual({
        kind: "error",
        errno: 76,
      });
      value.send({ kind: "release" });
      expect(await pending).toEqual({ kind: "ok", value: 3 });
      expect(value.resource.offset).toBe(mode === "cold" ? 3 : 65539);
      expect(description.references).toBe(0);
      expect(value.descriptors.get(replacement)!.resource.kind).toBe("device");
      const actual: Uint8Array = await value.client.asyncCall("read", [
        value.resource.handle,
        3,
        mode === "cold" ? 0 : 65536,
      ]);
      expect(actual).toEqual(new Uint8Array(mode === "cold" ? [65, 65, 65] : [80, 81, 82]));
    } finally {
      await value.dispose();
    }
  });
}

test("real dirty-capacity waiting keeps the thread service responsive", async () => {
  const value = await serviceFixture("dirty");
  const spans = [{ address: 64, length: 4 }];
  try {
    new Uint8Array(value.memory.buffer, 64, 8).fill(66);
    expect(
      await value.service.submit(value.call(), { kind: "write", fd: value.fd, spans }),
    ).toEqual({ kind: "ok", value: 4 });
    value.send({ kind: "dirty", handle: value.resource.handle });
    await value.event("held");
    expect(
      await value.service.submit(value.call(), {
        kind: "write",
        fd: value.fd,
        spans: [{ address: 64, length: 8 }],
        position: 0,
      }),
    ).toEqual({ kind: "ok", value: 8 });
    const pending = value.service.submit(value.call(), {
      kind: "write",
      fd: value.fd,
      spans: [{ address: 64, length: 1 }],
      position: 8,
    });
    await value.event("dirty-wait");
    expect(
      await value.service.submit(value.call(2), { kind: "write", fd: value.writerFd, spans }),
    ).toEqual({ kind: "ok", value: 4 });
    value.send({ kind: "release" });
    expect(await pending).toEqual({ kind: "ok", value: 1 });
    expect(value.resource.offset).toBe(4);
    expect(await value.client.asyncCall("readFile", ["/file"])).toEqual(new Uint8Array(9).fill(66));
  } finally {
    await value.dispose();
  }
});

test("same-description calls queue in order and positioned writes do not change the cursor", async () => {
  const value = await serviceFixture("growth");
  try {
    new Uint8Array(value.memory.buffer, 64, 4).set([80, 81, 82, 83]);
    const first = value.service.submit(value.call(), {
      kind: "write",
      fd: value.fd,
      spans: [{ address: 64, length: 2 }],
    });
    await value.event("held");
    const second = value.service.submit(value.call(2), {
      kind: "write",
      fd: value.fd,
      spans: [{ address: 66, length: 2 }],
    });
    expect(() => value.service.submit(value.call(), { kind: "tell", fd: value.fd })).toThrow(
      "pending call",
    );
    value.send({ kind: "release" });
    expect(await first).toEqual({ kind: "ok", value: 2 });
    expect(await second).toEqual({ kind: "ok", value: 2 });
    expect(value.resource.offset).toBe(4);
    expect(
      await value.service.submit(value.call(), {
        kind: "write",
        fd: value.fd,
        position: 1,
        spans: [{ address: 67, length: 1 }],
      }),
    ).toEqual({ kind: "ok", value: 1 });
    expect(value.resource.offset).toBe(4);
    expect(await value.client.asyncCall("read", [value.resource.handle, 4, 0])).toEqual(
      new Uint8Array([80, 83, 82, 83]),
    );
  } finally {
    await value.dispose();
  }
});

test("append uses the filesystem EOF and returns an honest one-page partial write", async () => {
  const value = await serviceFixture("growth");
  try {
    value.send({ kind: "release" });
    value.resource.append = true;
    new Uint8Array(value.memory.buffer, 64, 65537).fill(90);
    expect(
      await value.service.submit(value.call(), {
        kind: "write",
        fd: value.fd,
        spans: [{ address: 64, length: 65537 }],
      }),
    ).toEqual({ kind: "ok", value: 65536 });
    expect(value.resource.offset).toBe(131072);
    expect((await value.client.asyncCall("stat", [value.resource.handle])).size).toBe(131072);
    expect(
      await value.service.submit(value.call(), {
        kind: "seek",
        fd: value.fd,
        offset: -1,
        whence: "end",
      }),
    ).toEqual({ kind: "ok", value: 131071 });
    expect(value.resource.offset).toBe(131071);
    expect(
      await value.service.submit(value.call(), {
        kind: "read",
        fd: value.fd,
        position: 65536,
        spans: [{ address: 0, length: 2 }],
      }),
    ).toEqual({ kind: "ok", value: 2 });
    expect(new Uint8Array(value.memory.buffer, 0, 2)).toEqual(new Uint8Array([90, 90]));
    expect(value.resource.offset).toBe(131071);
  } finally {
    await value.dispose();
  }
});

test("rejected spans, rights, and stale call keys have no file effects", async () => {
  const value = await serviceFixture("growth");
  try {
    value.send({ kind: "release" });
    const key = value.call();
    expect(
      await value.service.submit(key, {
        kind: "read",
        fd: value.fd,
        spans: [{ address: 131071, length: 2 }],
      }),
    ).toEqual({ kind: "error", errno: 21 });
    expect(() => value.service.submit(key, { kind: "tell", fd: value.fd })).toThrow("stale");
    expect(() =>
      value.service.submit(
        { thread: { directory: "other", pid: 1, tid: 1 }, sequence: 10 },
        { kind: "tell", fd: value.fd },
      ),
    ).toThrow("foreign");
    value.descriptors.get(value.fd)!.rightsBase = 0n;
    expect(
      await value.service.submit(value.call(), {
        kind: "write",
        fd: value.fd,
        spans: [{ address: 64, length: 1 }],
      }),
    ).toEqual({ kind: "error", errno: 76 });
    expect(value.resource.offset).toBe(0);
    expect(await value.client.asyncCall("read", [value.resource.handle, 1, 0])).toEqual(
      new Uint8Array([65]),
    );
  } finally {
    await value.dispose();
  }
});

test("an async offset lease commits once and duplicate release cannot unlock its successor", async () => {
  const value = await serviceFixture();
  try {
    const buffer = shareFileResource(value.resource, value.pair.client);
    const claim = claimFileOffset(value.resource);
    if (claim.kind !== "acquired") throw new Error("offset unavailable");
    claim.lease.commit(4);
    expect(() => claim.lease.commit(7)).toThrow("uncommitted");
    claim.lease.release();
    const next = claimFileOffset(value.resource);
    if (next.kind !== "acquired") throw new Error("successor unavailable");
    expect(next.lease.position).toBe(4);
    claim.lease.release();
    expect(Atomics.load(new Int32Array(buffer), 0)).toBe(value.pair.client.owner);
    next.lease.release();
    expect(Atomics.load(new Int32Array(buffer), 0)).toBe(0);
  } finally {
    await value.dispose();
  }
});
