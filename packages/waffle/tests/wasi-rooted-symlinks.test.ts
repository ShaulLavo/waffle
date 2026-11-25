import { afterEach, describe, expect, test } from "bun:test";
import { MemFS } from "../fs/memory.js";
import {
  preview1,
  rootedSymlinkExpected,
  rootedSymlinkScenario,
} from "./fixtures/rooted-symlinks-guest.js";
import { openVfsBackend, VFS_BACKEND_KINDS, type VfsBackendKind } from "./fixtures/vfs-backends.js";

const DIRECTORY = 3,
  SYMLINK = 7,
  ALL = (1n << 29n) - 1n;
function at(fs: MemFS, path: string) {
  const found = fs.resolveAbsolute(path);
  if (typeof found === "number") throw new Error(`errno ${found}`);
  return found;
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanups.splice(0).reverse()) stop();
});

test("Preview1 follows absolute and climbing links in the guest's root namespace", () => {
  expect(rootedSymlinkScenario(new MemFS())).toEqual(rootedSymlinkExpected);
});

describe.each(VFS_BACKEND_KINDS)("worker-backed rooted symlinks (%s)", (kind: VfsBackendKind) => {
  test("the worker-backed client resolves the same namespace and keeps rooted and confined cache entries apart", async () => {
    const env = await openVfsBackend(kind);
    try {
      const child = env.forkConnection();
      const worker = new Worker(
        new URL("./fixtures/rooted-symlinks-worker.ts", import.meta.url).href,
      );
      try {
        const reply = new Promise<unknown>((resolve, reject) => {
          worker.onmessage = ({ data }) => resolve(data);
          worker.onerror = reject;
        });
        worker.postMessage(child, [child.port]);
        expect(await reply).toEqual({
          scenario: rootedSymlinkExpected,
          same: true,
          cache: [4, -63, 4, -63],
        });
      } finally {
        worker.terminate();
      }
    } finally {
      await env.close();
    }
  });
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

test("a held descriptor of a removed directory still climbs to its former parent, as on Linux", () => {
  const fs = new MemFS();
  fs.writeFile("/tmp/sibling", "beside");
  fs.mkdirp("/tmp/gone");
  const p = preview1(fs);
  cleanups.push(p.dispose);
  const directory = p.openDirectory("tmp/gone");
  expect(p.rmdir("tmp/gone")).toBe(0);
  expect(p.stat("..", true, directory)).toBe(DIRECTORY);
  expect(p.contents("../sibling", directory)).toBe("beside");
  expect(p.stat("anything", true, directory)).toBe(-44);
});

test("rooted mode comes from what the / preopen opened, not how its path is spelled", () => {
  const fs = new MemFS();
  fs.writeFile("/volume/inside", "inside");
  fs.writeFile("/outside", "outside");
  fs.mkdirp("/volume/deep");
  expect(fs.symlink(at(fs, "/jump"), "/volume/deep")).toBe(0);
  expect(fs.symlink(at(fs, "/rootlink"), "/")).toBe(0);
  // `/jump/..` is `/volume` once the link is followed: a confined guest.
  const confined = preview1(fs, { "/": "/jump/.." });
  cleanups.push(confined.dispose);
  expect(confined.contents("inside")).toBe("inside");
  expect(confined.contents("../outside")).toBe(-63);
  // A link to the root is the root: a rooted guest.
  const rooted = preview1(fs, { "/": "/rootlink" });
  cleanups.push(rooted.dispose);
  expect(rooted.symlink("/outside", "volume/abs")).toBe(0);
  expect(rooted.contents("volume/abs")).toBe("outside");
});

test("an exec successor without a root preopen is confined, even for a directory it kept", () => {
  const fs = new MemFS();
  fs.writeFile("/peer", "peer");
  fs.mkdirp("/keep");
  let kept = -1;
  const p = preview1(fs, { "/": "/" }, (wasi) => {
    // What exec's binding installation does: keep the listed descriptors, close the rest.
    kept = wasi.descriptors.open({ kind: "directory", handle: fs.preopen("/keep") }, ALL, ALL);
    wasi.descriptors.closeUnlisted([kept]);
  });
  cleanups.push(p.dispose);
  expect(p.stat("../peer", true, kept)).toBe(-63);
});

test("links from any directory reach live descriptors and /dev/null, never a physical stand-in", () => {
  const fs = new MemFS();
  fs.writeFile("/tmp/d/a.txt", "inside");
  const p = preview1(fs);
  cleanups.push(p.dispose);
  const source = p.open("tmp/d/a.txt");
  const directory = p.openDirectory("tmp/d");
  const live = p.handleOf(source);
  expect(p.symlink("/dev/null", "nul", directory)).toBe(0);
  expect(p.symlink(`/dev/fd/${source}`, "alias", directory)).toBe(0);
  expect(p.symlink(`/dev/fd/${source}`, "tmp/rootalias")).toBe(0);
  const opens = () => [
    p.contents("nul", directory),
    p.handleOf(p.open("alias", true, 0, directory)),
    p.handleOf(p.open("tmp/rootalias")),
    p.handleOf(p.open(`dev/fd/${source}`)),
  ];
  expect(opens()).toEqual(["", live, live, live]);
  // Physical entries at the same paths change nothing: the virtual names win either way.
  fs.writeFile("/dev/null", "physical");
  fs.writeFile(`/dev/fd/${source}`, "physical");
  expect(opens()).toEqual(["", live, live, live]);
});

test("lookups below a directory descriptor keep real parents, results and one 40-link budget", () => {
  const fs = new MemFS();
  fs.writeFile("/dir/file", "file");
  fs.writeFile("/sibling", "sibling");
  const p = preview1(fs);
  cleanups.push(p.dispose);
  const n = p.openDirectory("dir");
  expect(p.symlink(`/dev/fd/${n}/file`, "into")).toBe(0);
  expect(p.symlink(`/dev/fd/${n}/../sibling`, "beside")).toBe(0);
  expect(p.contents("into")).toBe("file");
  expect(p.contents("beside")).toBe("sibling");
  // One outer link plus 39 under the descriptor is 40 links; one more is ELOOP.
  for (let i = 0; i < 39; i++) p.symlink(i === 38 ? "file" : `c${i + 1}`, `dir/c${i}`);
  for (let i = 0; i < 40; i++) p.symlink(i === 39 ? "file" : `e${i + 1}`, `dir/e${i}`);
  expect(p.symlink(`/dev/fd/${n}/c0`, "forty")).toBe(0);
  expect(p.symlink(`/dev/fd/${n}/e0`, "forty-one")).toBe(0);
  expect(p.contents("forty")).toBe("file");
  expect(p.contents("forty-one")).toBe(-32);
});

test("a trailing slash follows a final link for stat and open, and refuses it elsewhere", () => {
  const fs = new MemFS();
  fs.mkdirp("/directory");
  const p = preview1(fs);
  cleanups.push(p.dispose);
  expect(p.symlink("/directory", "link")).toBe(0);
  expect(p.symlink("/dev/null/", "devslash")).toBe(0);
  expect([p.stat("link/", false), p.open("link/", false) >= 0, p.readlink("link/")]).toEqual([
    DIRECTORY,
    true,
    -28,
  ]);
  expect([p.unlink("link/"), p.rmdir("link/"), p.rename("link/", "moved")]).toEqual([54, 54, 54]);
  expect(p.stat("link", false)).toBe(SYMLINK);
  expect(p.open("devslash")).toBe(-54);
});

test("MemFS keeps unrooted lookups confined and roots only when asked", () => {
  const fs = new MemFS();
  fs.writeFile("/a/b/file", "bytes");
  expect(fs.symlink(at(fs, "/abs"), "/a/b/file")).toBe(0);
  const dir = at(fs, "/a/b").node!;
  const file = at(fs, "/a/b/file").node;
  expect(fs.resolve(dir, "../../abs", true)).toBe(63);
  expect(fs.resolve(at(fs, "/").node!, "abs", true)).toBe(63);
  expect(fs.resolve(dir, "../../../../abs", true, true)).toMatchObject({ node: file });
  expect(fs.resolve(dir, "../../abs", false, true)).toMatchObject({ name: "abs" });
});
