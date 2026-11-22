import { afterEach, expect, test } from "bun:test";
import { MemFS } from "../fs/memory.js";
import { MemoryBackend } from "../fs/backend.js";
import { FilesystemClient } from "../fs/client.js";
import { FilesystemService } from "../fs/service.js";
import { createFilesystemConnection } from "../fs/protocol.js";
import {
  preview1,
  rootedSymlinkExpected,
  rootedSymlinkScenario,
} from "./fixtures/rooted-symlinks-guest.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanups.splice(0).reverse()) stop();
});

test("Preview1 follows absolute and climbing links in the guest's root namespace", () => {
  expect(rootedSymlinkScenario(new MemFS())).toEqual(rootedSymlinkExpected);
});

test("the worker-backed client resolves the same namespace and keeps rooted and confined cache entries apart", async () => {
  const backend = new MemoryBackend();
  const service = new FilesystemService(backend);
  cleanups.push(() => service.dispose());
  const connection = createFilesystemConnection();
  cleanups.push(() => connection.server.port.close());
  cleanups.push(() => connection.client.port.close());
  service.connect(connection.server);
  const client = new FilesystemClient(connection.client);
  cleanups.push(() => client.dispose());
  const child = createFilesystemConnection(client.connection);
  service.connect(child.server);
  const worker = new Worker(new URL("./fixtures/rooted-symlinks-worker.ts", import.meta.url).href);
  cleanups.push(() => worker.terminate());
  const reply = new Promise<unknown>((resolve, reject) => {
    worker.onmessage = ({ data }) => resolve(data);
    worker.onerror = reject;
  });
  worker.postMessage(child.client, [child.client.port]);
  expect(await reply).toEqual({ scenario: rootedSymlinkExpected, cache: [4, -63] });
});

test("a guest whose / is not the filesystem root keeps every lookup beneath its directories", () => {
  const fs = new MemFS();
  fs.writeFile("/volume/inside", "inside");
  fs.writeFile("/outside", "outside");
  const p = preview1(fs, { "/": "/volume" });
  cleanups.push(p.dispose);
  expect(p.symlink("/outside", "absolute")).toBe(0);
  expect(p.symlink("../outside", "climb")).toBe(0);
  expect(p.readlink("absolute")).toBe("/outside");
  expect(p.contents("absolute")).toBe(-63);
  expect(p.contents("climb")).toBe(-63);
  expect(p.contents("../outside")).toBe(-63);
  expect(p.contents("inside")).toBe("inside");
});

test("closing the / preopen leaves the namespace rooted for directories still open", () => {
  const fs = new MemFS();
  fs.writeFile("/tmp/d/a.txt", "inside");
  const p = preview1(fs);
  cleanups.push(p.dispose);
  const directory = p.openDirectory("tmp/d");
  expect(p.symlink("/tmp/d/a.txt", "link", directory)).toBe(0);
  expect(p.close(3)).toBe(0);
  expect(p.contents("link", directory)).toBe("inside");
  expect(p.contents("../../tmp/d/a.txt", directory)).toBe("inside");
});

test("rooted lookups from a removed directory find no parent", () => {
  const fs = new MemFS();
  fs.writeFile("/tmp/d/a.txt", "inside");
  fs.mkdirp("/tmp/gone");
  const p = preview1(fs);
  cleanups.push(p.dispose);
  const directory = p.openDirectory("tmp/gone");
  const gone = fs.resolveAbsolute("/tmp/gone");
  if (typeof gone === "number") throw new Error(`errno ${gone}`);
  expect(fs.removePath(gone, true)).toBe(0);
  expect(p.stat("..", true, directory)).toBe(-44);
});

test("MemFS keeps unrooted lookups confined and roots only when asked", () => {
  const fs = new MemFS();
  fs.writeFile("/a/b/file", "bytes");
  const at = (path: string) => {
    const found = fs.resolveAbsolute(path);
    if (typeof found === "number") throw new Error(`errno ${found}`);
    return found;
  };
  expect(fs.symlink(at("/abs"), "/a/b/file")).toBe(0);
  const dir = at("/a/b").node!;
  const file = at("/a/b/file").node;
  expect(fs.resolve(dir, "../../abs", true)).toBe(63);
  expect(fs.resolve(at("/").node!, "abs", true)).toBe(63);
  expect(fs.resolve(dir, "../../../../abs", true, true)).toMatchObject({ node: file });
  expect(fs.resolve(dir, "../../abs", false, true)).toMatchObject({ name: "abs" });
});
