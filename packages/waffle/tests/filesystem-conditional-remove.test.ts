import { expect, test } from "bun:test";
import {
  FilesystemClient,
  FilesystemService,
  MemoryBackend,
  createFilesystemConnection,
} from "../fs";
import { SharedFilesystem } from "../browser/shared-fs.js";
import { PersistentBackend } from "../fs/persistent.js";
import { MetadataStore } from "./fixtures/metadata-enumeration-r173-store.js";
import type { PublicationLimits } from "../fs/publication-internal.js";

const encode = (text: string) => new TextEncoder().encode(text);
const marker = encode("waffle program: fixture /usr/bin/x\n");

async function fixture(publication: boolean) {
  const backend = new MemoryBackend();
  backend.fs.writeFile("/file", marker);
  const service = new FilesystemService(backend);
  const limits: PublicationLimits = {
    sessions: 4,
    operations: 8,
    inputBytes: 256,
    argumentBytes: 512,
    effectBytes: 2048,
    effects: 32,
    resultBytes: 128,
    logRecords: 4,
    logBytes: 8192,
    pins: 2,
    pinBytes: 128,
  };
  const connection = createFilesystemConnection(
    undefined,
    publication ? { limits, observe: true } : undefined,
  );
  service.connect(connection.server);
  const root = new FilesystemClient(connection.client);
  const guest = new FilesystemClient(root.fork());
  const directory = await root.asyncCall("preopen", ["/"]);
  const resolved = await guest.asyncCall("resolve", [
    await guest.asyncCall("preopen", ["/"]),
    "file",
  ]);
  guest.retain(resolved.node);
  const remove = (path: string, expected?: Uint8Array): Promise<boolean> =>
    expected ? root.asyncCall("remove", [path, true], expected) : root.asyncCall("remove", [path]);
  const read = async (path: string) => {
    const bytes: Uint8Array | undefined = await root.asyncCall("readFile", [path]);
    return bytes && new TextDecoder().decode(bytes);
  };
  return {
    root,
    guest,
    directory,
    handle: resolved.node as number,
    remove,
    read,
    stop() {
      guest.dispose();
      root.dispose();
      service.dispose();
    },
  };
}

for (const publication of [false, true]) {
  const label = publication ? "with publication" : "without publication";

  test(`conditional remove deletes only a regular file with the expected bytes (${label})`, async () => {
    const f = await fixture(publication);
    try {
      expect(await f.remove("/file", encode("something else\n"))).toBe(false);
      expect(await f.read("/file")).toBe(new TextDecoder().decode(marker));
      expect(await f.remove("/file", marker.subarray(0, 8))).toBe(false);
      expect(await f.remove("/missing", marker)).toBe(false);
      await f.root.asyncCall("mkdirp", ["/dir/child"]);
      expect(await f.remove("/dir", marker)).toBe(false);
      expect(await f.root.asyncCall("lookup", ["/dir/child"])).toMatchObject({ kind: "dir" });
      const link = await f.root.asyncCall("resolve", [f.directory, "link", false]);
      expect(await f.root.asyncCall("symlink", [link, "file"])).toBe(0);
      expect(await f.remove("/link", marker)).toBe(false);
      expect(await f.root.asyncCall("lookup", ["/link"])).toMatchObject({ kind: "symlink" });
      expect(await f.remove("/file", marker)).toBe(true);
      expect(await f.read("/file")).toBeUndefined();
      // Unconditional removal keeps its meaning, including whole directories.
      expect(await f.remove("/dir")).toBe(true);
      expect(await f.remove("/link")).toBe(true);
      expect(await f.root.asyncCall("lookup", ["/file"])).toBeUndefined();
    } finally {
      f.stop();
    }
  });

  test(`a guest write that lands first makes the conditional remove a no-op (${label})`, async () => {
    const f = await fixture(publication);
    try {
      // A direct shared-memory write through an open descriptor, not through the service.
      expect(f.guest.tryWrite(f.handle, [encode("WAFFLE")], 0)).toBe(6);
      expect(await f.remove("/file", marker)).toBe(false);
      expect(await f.read("/file")).toStartWith("WAFFLE");
      const grown = new Uint8Array(marker.length + 1);
      grown.set(marker);
      await f.root.asyncCall("writeFile", ["/file", false, false], grown);
      expect(await f.remove("/file", marker)).toBe(false);
      expect((await f.read("/file"))?.length).toBe(grown.length);
    } finally {
      f.stop();
    }
  });

  test(`malformed conditions are refused before any change (${label})`, async () => {
    const f = await fixture(publication);
    try {
      await expect(f.root.asyncCall("remove", ["/file", "yes"], marker)).rejects.toMatchObject({
        errno: 28,
      });
      await expect(f.root.asyncCall("remove", ["/file"], marker)).rejects.toMatchObject({
        errno: 28,
      });
      expect(await f.read("/file")).toBe(new TextDecoder().decode(marker));
    } finally {
      f.stop();
    }
  });
}

test("the page API owns the expected bytes and rejects a missing condition value", async () => {
  const page = new SharedFilesystem({
    mode: "memory",
    workerURL: new URL("../browser/fs-worker.ts", import.meta.url),
  });
  try {
    await page.writeFile("/marker", marker);
    const expected = new Uint8Array(marker);
    const removal = page.remove("/marker", { ifContent: expected });
    expected.fill(0);
    expect(await removal).toBe(true);
    await page.writeFile("/marker", marker);
    const invalid = { ifContent: "text" } as unknown as { ifContent: Uint8Array };
    const failure = await page.remove("/marker", invalid).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect(await page.lookup("/marker")).toMatchObject({ kind: "file" });
    expect(await page.remove("/marker")).toBe(true);
  } finally {
    await page.dispose();
  }
});

test("a persistent cold file is loaded and compared before a conditional remove", async () => {
  const storage = new MetadataStore();
  const seed = await PersistentBackend.open(storage, { intervalMs: 0 });
  try {
    for (const path of ["/marker", "/changed"]) {
      await seed.prepare("writeFile", [path]);
      seed.execute("writeFile", [path], marker);
    }
    await seed.flush();
  } finally {
    await seed.close();
    seed.dispose();
  }
  const reopen = async () => {
    const backend = await PersistentBackend.open(storage, { intervalMs: 0 });
    const service = new FilesystemService(backend);
    const pair = createFilesystemConnection();
    service.connect(pair.server);
    const client = new FilesystemClient(pair.client);
    return {
      client,
      backend,
      async stop() {
        client.dispose();
        service.dispose();
        await backend.close();
        backend.dispose();
      },
    };
  };
  const first = await reopen();
  try {
    await first.client.asyncCall("writeFile", ["/changed", false, false], encode("edited\n"));
    expect(await first.client.asyncCall("remove", ["/changed", true], marker)).toBe(false);
    expect(await first.client.asyncCall("remove", ["/marker", true], encode("other\n"))).toBe(
      false,
    );
    expect(await first.client.asyncCall("remove", ["/marker", true], marker)).toBe(true);
    await first.backend.flush();
  } finally {
    await first.stop();
  }
  const second = await reopen();
  try {
    expect(await second.client.asyncCall("lookup", ["/marker"])).toBeUndefined();
    expect(await second.client.asyncCall("readFile", ["/changed"])).toEqual(encode("edited\n"));
  } finally {
    await second.stop();
  }
});
