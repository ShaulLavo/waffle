import { describe, expect, test } from "bun:test";
import { FilesystemError, PROBE_PATH_LIMIT } from "../core/filesystem.js";
import { RIGHT_PATH_FILESTAT_GET } from "../core/rights.js";
import { MemFS } from "../fs/memory.js";
import { link, runtimeFsGuest } from "./fixtures/runtime-fs-guest.js";
import { openVfsBackend, VFS_BACKEND_KINDS } from "./fixtures/vfs-backends.js";

const encoder = new TextEncoder();
const NONE = 0xffffffff;

/** A package tree shaped like a resolver's probes: nested node_modules, a linked package, a
 * dangling link and a link loop. */
function tree(): { fs: MemFS; root: number } {
  const fs = new MemFS();
  fs.mkdirp("/app/node_modules/vite/dist/node/chunks");
  fs.writeFile("/app/node_modules/vite/dist/node/chunks/dep.js", "x");
  fs.mkdirp("/app/node_modules/vue");
  fs.mkdirp("/real/pkg");
  fs.writeFile("/real/pkg/index.mjs", "x");
  link(fs, "/app/node_modules/linked", "../../real/pkg");
  link(fs, "/app/node_modules/dangling", "missing");
  link(fs, "/app/node_modules/loop", "loop");
  link(fs, "/app/file-link.js", "node_modules/vite/dist/node/chunks/dep.js");
  return { fs, root: fs.preopen("/") };
}

/** The answer one stat per path, in order, gives: what probe must match exactly. */
function statOneByOne(
  fs: MemFS,
  root: number,
  paths: readonly string[],
  kind: "file" | "directory",
): number {
  for (let index = 0; index < paths.length; index++) {
    const resolved = fs.resolve(root, paths[index]!, true, true);
    if (typeof resolved === "number" || resolved.node === undefined) continue;
    const stat = fs.stat(resolved.node);
    if (stat.kind === (kind === "file" ? "file" : "directory")) return index;
  }
  return -1;
}

const WALK = [
  "app/node_modules/vite/dist/node/chunks/node_modules/vue",
  "app/node_modules/vite/dist/node/node_modules/vue",
  "app/node_modules/vite/dist/node_modules/vue",
  "app/node_modules/vite/node_modules/vue",
  "app/node_modules/vue",
  "node_modules/vue",
];
const EXTENSIONS = [
  "app/node_modules/vite/dist/node/chunks/dep",
  "app/node_modules/vite/dist/node/chunks/dep.tsx",
  "app/node_modules/vite/dist/node/chunks/dep.ts",
  "app/node_modules/vite/dist/node/chunks/dep.js",
  "app/node_modules/vite/dist/node/chunks/dep.mjs",
];

describe("MemFS.probe", () => {
  test.each([
    ["a node_modules walk", WALK, "directory", 4],
    ["extension probing", EXTENSIONS, "file", 3],
    ["a directory is not a file", ["app/node_modules/vue", "real/pkg/index.mjs"], "file", 1],
    ["a file is not a directory", ["real/pkg/index.mjs", "real/pkg"], "directory", 1],
    ["links are followed", ["app/node_modules/linked", "app/node_modules/vue"], "directory", 0],
    ["a file reached through a link", ["app/node_modules/linked/index.mjs"], "file", 0],
    ["a final link to a file", ["app/file-link.js"], "file", 0],
    [
      "dangling links and loops do not match",
      ["app/node_modules/dangling", "app/node_modules/loop", "real"],
      "directory",
      2,
    ],
    [
      "ENOTDIR and trailing slashes do not match",
      ["real/pkg/index.mjs/x", "real/pkg/index.mjs/", "real/pkg/"],
      "file",
      -1,
    ],
    ["absolute and empty pathnames do not match", ["/real/pkg", "", "real/pkg"], "directory", 2],
    ["no match", ["missing", "app/missing"], "file", -1],
    ["an empty list", [], "file", -1],
  ] as const)("%s", (_name, paths, kind, expected) => {
    const { fs, root } = tree();
    expect(fs.probe(root, paths, kind, true)).toBe(expected);
    expect(statOneByOne(fs, root, paths, kind)).toBe(expected);
  });

  test("a directory without search permission hides what is below it", () => {
    const { fs, root } = tree();
    const dir = fs.resolveAbsolute("/real/pkg");
    if (typeof dir === "number" || dir.node === undefined) throw new Error("fixture");
    fs.setMode(dir.node, 0o600);
    expect(fs.probe(root, ["real/pkg/index.mjs", "app/node_modules/vue"], "directory", true)).toBe(
      1,
    );
    expect(fs.probe(root, ["real/pkg/index.mjs"], "file", true)).toBe(-1);
  });

  test("an unrooted lookup cannot leave its directory", () => {
    const { fs } = tree();
    const app = fs.preopen("/app");
    expect(
      fs.probe(app, ["../real/pkg", "node_modules/linked", "node_modules/vue"], "directory"),
    ).toBe(2);
    expect(fs.probe(app, ["../real/pkg", "node_modules/linked"], "directory", true)).toBe(0);
  });

  test("more than the limit is EINVAL", () => {
    const { fs, root } = tree();
    const paths = Array.from({ length: PROBE_PATH_LIMIT + 1 }, () => "real");
    expect(() => fs.probe(root, paths, "directory", true)).toThrow(FilesystemError);
    expect(fs.probe(root, paths.slice(1), "directory", true)).toBe(0);
  });
});

describe.each(VFS_BACKEND_KINDS)("probe through the filesystem client (%s)", (kind) => {
  test("answers with the backend's tree", async () => {
    const env = await openVfsBackend(kind);
    try {
      await env.client.asyncCall("mkdirp", ["/app/node_modules/vue"]);
      await env.client.asyncCall("mkdirp", ["/real/pkg"]);
      await env.client.asyncCall(
        "writeFile",
        ["/real/pkg/index.js", false, false],
        encoder.encode("x"),
      );
      const root: number = await env.client.asyncCall("preopen", ["/"]);
      const at = await env.client.asyncCall("resolve", [root, "app/node_modules/linked", false]);
      expect(await env.client.asyncCall("symlink", [at, "../../real/pkg"])).toBe(0);
      const probe = (paths: string[], wanted: string) =>
        env.client.asyncCall("probe", [root, paths, wanted, true]);
      expect(
        await probe(["app/node_modules/x/node_modules/vue", "app/node_modules/vue"], "directory"),
      ).toBe(1);
      expect(
        await probe(["app/node_modules/linked/index", "app/node_modules/linked/index.js"], "file"),
      ).toBe(1);
      expect(await probe(["app/node_modules/linked/index.ts"], "file")).toBe(-1);
      const errnoOf = (call: Promise<unknown>) =>
        call.then(
          () => 0,
          (error: { errno?: number }) => error.errno,
        );
      expect(await errnoOf(probe(["real"], "symlink"))).toBe(28);
      expect(await errnoOf(env.client.asyncCall("probe", [root, "real", "file", true]))).toBe(28);
    } finally {
      await env.close();
    }
  });
});

describe("runtime_fs.path_probe", () => {
  class CountingFS extends MemFS {
    probes = 0;
    resolves = 0;
    override probe(
      directory: number,
      paths: readonly string[],
      kind: "file" | "directory",
      rooted?: boolean,
    ): number {
      this.probes++;
      return super.probe(directory, paths, kind, rooted);
    }
    override resolve(directory: number, path: string, followFinal?: boolean, rooted?: boolean) {
      this.resolves++;
      return super.resolve(directory, path, followFinal, rooted);
    }
  }

  function guest(rights?: bigint) {
    const fs = new CountingFS();
    fs.mkdirp("/app/node_modules/vue");
    fs.writeFile("/app/index.js", "x");
    const { memory, call } = runtimeFsGuest(fs, "path_probe", 5, rights);
    const resolvesBefore = fs.resolves;
    const probe = (paths: string[], kind: number, fd = 3) => {
      const input = encoder.encode(paths.map((path) => path + "\0").join(""));
      new Uint8Array(memory.buffer).set(input, 64);
      new DataView(memory.buffer).setUint32(32, 7, true);
      const errno = call(fd, 64, input.length, kind, 32);
      return { errno, found: new DataView(memory.buffer).getUint32(32, true) };
    };
    return { fs, memory, call, probe, resolvesBefore };
  }

  test("answers a whole list with one filesystem request", () => {
    const g = guest();
    const walk = ["app/x/node_modules/vue", "app/node_modules/vue", "node_modules/vue"];
    expect(g.probe(walk, 2)).toEqual({ errno: 0, found: 1 });
    expect(g.probe(["app/index", "app/index.ts", "app/index.js"], 1)).toEqual({
      errno: 0,
      found: 2,
    });
    expect(g.probe(["app/missing", "app/node_modules"], 1)).toEqual({ errno: 0, found: NONE });
    expect(g.fs.probes).toBe(3);
    expect(g.fs.resolves).toBe(g.resolvesBefore);
  });

  test("descriptor errors and bad pointers", () => {
    const g = guest();
    expect(g.probe(["app"], 2, 99).errno).toBe(8);
    expect(g.probe(["app"], 2, 0)).toEqual({ errno: 54, found: 7 });
    expect(g.call(3, g.memory.buffer.byteLength - 2, 4, 2, 32)).toBe(21);
    expect(g.call(3, 64, 4, 2, g.memory.buffer.byteLength - 2)).toBe(21);
    expect(guest(0n).probe(["app"], 2).errno).toBe(76);
    expect(guest(RIGHT_PATH_FILESTAT_GET).probe(["app"], 2)).toEqual({ errno: 0, found: 0 });
  });

  test("overlapping input/output, empty pathname, and the 64-path limit", () => {
    const g = guest();
    const input = encoder.encode("missing\0app\0");
    new Uint8Array(g.memory.buffer).set(input, 64);
    expect(g.call(3, 64, input.length, 2, 64)).toBe(0);
    expect(new DataView(g.memory.buffer).getUint32(64, true)).toBe(1);
    expect(g.probe([""], 2)).toEqual({ errno: 0, found: NONE });
    const atLimit = Array.from({ length: PROBE_PATH_LIMIT }, (_, i) =>
      i === PROBE_PATH_LIMIT - 1 ? "app" : `missing-${i}`,
    );
    expect(g.probe(atLimit, 2)).toEqual({ errno: 0, found: PROBE_PATH_LIMIT - 1 });
  });

  test("a malformed list or kind is EINVAL before any lookup, with the output untouched", () => {
    const g = guest();
    const memory = new Uint8Array(g.memory.buffer);
    const invalid = (bytes: number[], kind = 2) => {
      memory.set(bytes, 64);
      new DataView(g.memory.buffer).setUint32(32, 7, true);
      const errno = g.call(3, 64, bytes.length, kind, 32);
      expect(new DataView(g.memory.buffer).getUint32(32, true)).toBe(7);
      return errno;
    };
    expect(invalid([])).toBe(28);
    expect(invalid([0x61, 0x70, 0x70])).toBe(28);
    expect(invalid([0xff, 0x00])).toBe(28);
    expect(invalid([0x61, 0x00], 0)).toBe(28);
    expect(invalid([0x61, 0x00], 3)).toBe(28);
    expect(invalid(Array.from({ length: PROBE_PATH_LIMIT + 1 }, () => [0x61, 0x00]).flat())).toBe(
      28,
    );
    expect(g.fs.probes).toBe(0);
  });

  test("pathnames are their exact bytes: a leading U+FEFF is kept", () => {
    const g = guest();
    g.fs.writeFile("/﻿plain", "");
    expect(g.probe(["plain", "﻿plain"], 1)).toEqual({ errno: 0, found: 1 });
  });
});
