import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { buildDiffutils, packageRoot } from "./build-diffutils.ts";
import { sourceLock } from "./build-config.ts";
import { diffutils } from "../src/index.ts";

test("GNU source archive and local adaptation are immutably pinned", () => {
  assert.equal(sourceLock.upstream.version, "3.12");
  assert.match(sourceLock.upstream.archiveSha256, /^[0-9a-f]{64}$/);
  assert.ok(sourceLock.upstream.archive.endsWith("diffutils-3.12.tar.xz"));
  const patch = readFileSync(resolve(packageRoot, "patches/gnu-wasi.patch"), "utf8");
  const paths = Array.from(patch.matchAll(/^--- a\/(\S+)$/gm), (match) => match[1]);
  assert.deepEqual(paths, [
    "lib/signal.in.h",
    "lib/getdtablesize.c",
    "lib/pclose.c",
    "lib/popen.c",
    "lib/sigaction.c",
    "lib/time_rz.c",
    "lib/mktime.c",
    "src/system.h",
    "src/dir.c",
    "src/util.c",
  ]);
  assert.ok(patch.includes("__wasi__"));
  assert.ok(!patch.includes("/work/tmp/"));
  assert.ok(readFileSync(resolve(packageRoot, "LICENSE.gnu"), "utf8").includes("GNU GENERAL PUBLIC LICENSE"));
});

test("catalog exposes only separately selectable lazy diff and cmp guests", () => {
  assert.equal(diffutils.name, "diffutils");
  assert.deepEqual(
    diffutils.programs.map((program) => program.path),
    ["/usr/bin/diff", "/usr/bin/cmp"],
  );
  assert.equal(diffutils.pick("diff").programs.length, 1);
  assert.equal(diffutils.pick("/bin/cmp").programs[0], diffutils.programs[1]);
  assert.ok(diffutils.programs.every((program) => program.wasm instanceof URL));
  assert.throws(() => diffutils.pick("diff3"), /Unknown program/);
});

test("build recipe compiles only optimized diff and cmp guests", async () => {
  const invocations: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const verified: string[] = [];
  await buildDiffutils({
    prepare: async () => {},
    execute: (command, args, options) => {
      invocations.push({ command, args, env: options.env });
    },
    environment: () => ({ INHERITED: "yes" }),
    configuration: () => ({
      sdk: "/sdk",
      builder: "/builder",
      directory: "/cache",
      sysroot: "/sysroot",
      linker: "/clang",
      rustflags: [],
      identity: "test",
    }),
    verifier: (path) => verified.push(path),
  });
  assert.equal(invocations.length, 3);
  const configure = invocations[0];
  assert.ok(configure);
  assert.ok(configure.command.endsWith("/.sources/diffutils/configure"));
  assert.ok(configure.args.includes("--disable-nls"));
  assert.match(configure.env.CFLAGS ?? "", /-Oz/);
  assert.equal(configure.env.INHERITED, "yes");
  const targets = invocations[2];
  assert.ok(targets);
  assert.deepEqual(targets.args.slice(-2), ["diff", "cmp"]);
  assert.equal(verified.length, 2);
});
