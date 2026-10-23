import { expect, test } from "bun:test";
import { FilesystemClient } from "../fs";
import { PAGE } from "../fs/protocol";
import { Wasi } from "../core/wasi";
import { shareFileResource } from "../core/open-file";
import { guestModule, guestFunction } from "./fixtures/publication-wasm";
import { residentReadFixture } from "./fixtures/workspace-read";

for (const kind of [
  "service-write",
  "service-append",
  "writeFile",
  "resize",
  "direct-write",
  "direct-append",
] as const) {
  test(`retained complete backing survives actual ${kind}`, async () => {
    const value = await residentReadFixture(PAGE * 3 + 3);
    try {
      const before = value.backend.shared.resources().usedBytes;
      const pin = value.pin();
      expect(value.backend.shared.resources().usedBytes).toBe(before);
      await mutate(kind, value);
      expect(pin.read(PAGE * 2 + 1, 2)).toEqual(new Uint8Array(2).fill(65));
      expect(pin.read(0, 3)).toEqual(new Uint8Array(3).fill(65));
    } finally {
      await value.close();
    }
  });
}

type Fixture = Awaited<ReturnType<typeof residentReadFixture>>;
async function mutate(kind: string, value: Fixture) {
  const bytes = new Uint8Array(3).fill(90);
  if (kind === "service-write") return value.client.asyncCall("write", [value.handle, 0], bytes);
  if (kind === "service-append") return value.client.asyncCall("append", [value.handle], bytes);
  if (kind === "writeFile") return value.client.asyncCall("writeFile", ["/file"], bytes);
  if (kind === "resize") return value.client.asyncCall("resize", [value.handle, 1, true]);
  const sibling = new FilesystemClient(value.client.fork());
  try {
    const root = await sibling.asyncCall("preopen", ["/"]);
    const handle = (await sibling.asyncCall("resolve", [root, "file"])).node;
    sibling.retain(handle);
    if (kind === "direct-write") return sibling.tryWrite(handle, [bytes], 0);
    return sibling.tryAppend(handle, [bytes]);
  } finally {
    sibling.dispose();
  }
}

for (const operation of ["fd_write", "fd_pwrite"] as const) {
  test(`retained complete backing survives real WASI ${operation}`, async () => {
    const value = await residentReadFixture(PAGE * 3 + 3);
    const guest = new FilesystemClient(value.client.fork());
    const memory = new WebAssembly.Memory({ initial: 4 });
    const wasi = new Wasi({
      fs: guest,
      args: [],
      env: {},
      preopens: {},
      namespaces: { env: { memory } },
      stdout() {},
      stderr() {},
      sleep() {
        throw new Error("guest must not wait");
      },
    });
    try {
      const root = await guest.asyncCall("preopen", ["/"]);
      const handle = (await guest.asyncCall("resolve", [root, "file"])).node;
      guest.retain(handle);
      const resource = { kind: "file", handle, offset: 0, append: false } as const;
      shareFileResource(resource, guest.connection);
      const parameters =
        operation === "fd_write"
          ? (["i32", "i32", "i32", "i32"] as const)
          : (["i32", "i32", "i32", "i64", "i32"] as const);
      const module = guestModule("wasi_snapshot_preview1", [{ name: operation, parameters }]);
      const instance = new WebAssembly.Instance(module, {
        ...wasi.imports(module),
        env: { memory },
      });
      wasi.start(instance);
      const fd = wasi.descriptors.open(resource, (1n << 6n) | (1n << 2n), 0n);
      const pin = value.pin();
      const view = new DataView(memory.buffer);
      view.setUint32(0, 32, true);
      view.setUint32(4, 1, true);
      new Uint8Array(memory.buffer)[32] = 90;
      const call = guestFunction(instance, operation);
      expect(operation === "fd_write" ? call(fd, 0, 1, 16) : call(fd, 0, 1, 0n, 16)).toBe(0);
      expect(pin.read(0, 1)).toEqual(new Uint8Array([65]));
    } finally {
      wasi.descriptors.dispose();
      guest.dispose();
      await value.close();
    }
  });
}

test("retained pages survive unlink, final descriptor release and new slot allocation", async () => {
  const value = await residentReadFixture(PAGE * 3 + 3);
  try {
    const pin = value.pin();
    await value.client.asyncCall("remove", ["/file"]);
    value.client.release(value.handle);
    await value.client.asyncCall("writeFile", ["/replacement"], new Uint8Array(PAGE).fill(90));
    expect(pin.read(PAGE * 2 + 1, 2)).toEqual(new Uint8Array(2).fill(65));
  } finally {
    await value.close();
  }
});
