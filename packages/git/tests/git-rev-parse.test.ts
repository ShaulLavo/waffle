import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import * as git from "isomorphic-git";
import { runGit } from "../dist/git-command.js";
import { nodeGitFilesystem as filesystem } from "../src/node-filesystem.ts";
import type { GitFilesystem } from "../src/git-types.ts";
import { captureGit } from "./helpers/git-output.ts";

const environment = {
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  TZ: "UTC",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_DISCOVERY_ACROSS_FILESYSTEM: "1",
  GIT_AUTHOR_NAME: "Revision test",
  GIT_AUTHOR_EMAIL: "revision@example.invalid",
  GIT_COMMITTER_NAME: "Revision test",
  GIT_COMMITTER_EMAIL: "revision@example.invalid",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_DATE: "1700000000 +0000",
};

async function repository(context: TestContext) {
  const scratch = await fs.mkdtemp(join(tmpdir(), "waffle-git-rev-parse-"));
  context.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const root = `${scratch}/répo with spaces`;
  const nested = `${root}/nested space/ישראל`;
  await fs.mkdir(nested, { recursive: true });
  const command = (argv: readonly string[]) =>
    captureGit((invocation) => runGit(filesystem, invocation), {
      argv,
      cwd: root,
      env: environment,
    });
  assert.equal((await command(["init", "-b", "main"])).status, 0);
  await fs.writeFile(`${root}/story`, "base\n");
  assert.equal((await command(["add", "story"])).status, 0);
  assert.equal((await command(["commit", "-m", "base"])).status, 0);
  const oid = await git.resolveRef({ fs: filesystem, dir: root, ref: "HEAD" });
  await git.writeRef({ fs: filesystem, dir: root, ref: "refs/heads/topic/é", value: oid });
  await git.writeRef({ fs: filesystem, dir: root, ref: "refs/tags/v1", value: oid });
  await git.writeRef({ fs: filesystem, dir: root, ref: "refs/remotes/origin/main", value: oid });
  await git.writeRef({
    fs: filesystem,
    dir: root,
    ref: "refs/remotes/origin/HEAD",
    value: "refs/remotes/origin/main",
    symbolic: true,
  });
  return { scratch, root, nested, oid };
}

function native(cwd: string, argv: readonly string[]) {
  const result = spawnSync("git", ["rev-parse"].concat(argv), {
    cwd,
    env: environment,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  assert.notEqual(result.status, null);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function readonlyFilesystem() {
  let attempted = 0;
  const deny = async () => {
    attempted++;
    throw new Error("revision query attempted a filesystem mutation");
  };
  const fs = {
    promises: {
      ...filesystem.promises,
      writeFile: deny,
      unlink: deny,
      mkdir: deny,
      rmdir: deny,
      symlink: deny,
    },
  } satisfies GitFilesystem;
  return { fs, attempted: () => attempted };
}

async function query(cwd: string, argv: readonly string[]) {
  const readonly = readonlyFilesystem();
  const result = await captureGit((invocation) => runGit(readonly.fs, invocation), {
    argv: ["rev-parse"].concat(argv),
    cwd,
    env: environment,
  });
  assert.equal(readonly.attempted(), 0);
  return result;
}

async function snapshot(root: string, prefix = ""): Promise<string[]> {
  const entries = await fs.readdir(join(root, prefix), { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  let rows: string[] = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      rows = rows.concat(await snapshot(root, path));
      continue;
    }
    const bytes = await fs.readFile(join(root, path));
    rows.push(`${path}\0${createHash("sha256").update(bytes).digest("hex")}`);
  }
  return rows;
}

async function compare(cwd: string, argv: readonly string[]) {
  assert.deepEqual(await query(cwd, argv), native(cwd, argv), JSON.stringify({ cwd, argv }));
}

test("rev-parse matches native Git for refs, locations, verification and stable errors without writes", async (context) => {
  const { scratch, root, nested, oid } = await repository(context);
  const before = await snapshot(scratch);
  const cases = [
    [],
    ["HEAD"],
    ["main"],
    ["refs/heads/main"],
    ["topic/é"],
    ["v1"],
    ["refs/tags/v1"],
    ["origin/main"],
    ["origin"],
    [oid],
    [oid.toUpperCase()],
    ["0123456789012345678901234567890123456789"],
    [oid.slice(0, 9)],
    ["HEAD", "main", "v1"],
    ["--verify", "HEAD"],
    ["--verify", "refs/heads/main"],
    ["--short", "HEAD"],
    ["--short=4", "HEAD"],
    ["--short=0", "HEAD"],
    ["--short=2", "HEAD"],
    ["--short=40", "HEAD"],
    ["--short=100", "HEAD"],
    ["--verify"],
    ["--verify", "HEAD", "main"],
    ["--short"],
    ["--short", "HEAD", "main"],
    ["missing"],
    ["--verify", "missing"],
    ["--short", "missing"],
    ["HEAD", "missing"],
    ["--show-toplevel"],
    ["--show-prefix"],
    ["--is-inside-work-tree"],
    ["--show-toplevel", "--show-prefix", "--is-inside-work-tree"],
    ["--show-prefix", "--short=8", "--verify", "HEAD"],
    ["--verify", "--show-toplevel"],
  ];
  for (const argv of cases) await compare(nested, argv);
  await compare(root, ["--show-prefix"]);
  await compare(`${nested}/../ישראל/.`, ["--show-prefix", "--show-toplevel"]);
  await compare(scratch, ["--is-inside-work-tree"]);
  await compare(scratch, ["--verify", "HEAD"]);
  await compare(`${root}/.git`, ["--is-inside-work-tree", "--show-prefix"]);
  await compare(`${root}/.git`, ["--show-toplevel"]);
  await compare(`${root}/.git/objects`, ["HEAD"]);
  assert.deepEqual(await snapshot(scratch), before);
});

test("rev-parse resolves packed refs, annotated tags and detached or unborn HEAD", async (context) => {
  const { root, oid } = await repository(context);
  await fs.writeFile(
    `${root}/.git/packed-refs`,
    `# pack-refs with: peeled fully-peeled sorted\n${oid} refs/heads/packed\n`,
  );
  await git.annotatedTag({
    fs: filesystem,
    dir: root,
    ref: "annotated",
    message: "release",
    tagger: {
      name: "Revision test",
      email: "revision@example.invalid",
      timestamp: 1700000000,
      timezoneOffset: 0,
    },
  });
  await compare(root, ["packed", "refs/heads/packed", "annotated"]);
  await fs.writeFile(`${root}/.git/HEAD`, `${oid}\n`);
  await compare(root, ["--verify", "HEAD"]);
  await fs.writeFile(`${root}/.git/HEAD`, "ref: refs/heads/unborn\n");
  await compare(root, ["--verify", "HEAD"]);
  await compare(root, ["HEAD"]);
  await compare(root, ["--is-inside-work-tree"]);
});

test("rev-parse short honors numeric or no core.abbrev without running configuration", async (context) => {
  const { root } = await repository(context);
  for (const value of ["10", "no"]) {
    await git.setConfig({ fs: filesystem, dir: root, path: "core.abbrev", value });
    const before = await snapshot(root);
    await compare(root, ["--short", "HEAD"]);
    await compare(root, ["--short=8", "HEAD"]);
    assert.deepEqual(await snapshot(root), before);
  }
  await git.setConfig({ fs: filesystem, dir: root, path: "core.abbrev", value: "auto" });
  assert.equal((await query(root, ["--short", "HEAD"])).status, 129);
});

function collidingBlobs() {
  const prefixes = new Map<string, string>();
  for (let index = 0; index < 10000; index++) {
    const text = `revision collision ${index}\n`;
    const oid = createHash("sha1")
      .update(`blob ${Buffer.byteLength(text)}\0${text}`)
      .digest("hex");
    const previous = prefixes.get(oid.slice(0, 4));
    if (previous !== undefined) return [previous, text];
    prefixes.set(oid.slice(0, 4), text);
  }
  throw new Error("deterministic collision search exhausted");
}

test("rev-parse short grows past object collisions and refuses ambiguous input prefixes", async (context) => {
  const { root } = await repository(context);
  const oids: string[] = [];
  for (const text of collidingBlobs())
    oids.push(
      await git.writeBlob({ fs: filesystem, dir: root, blob: new TextEncoder().encode(text) }),
    );
  const before = await snapshot(root);
  for (const oid of oids) {
    await compare(root, ["--short=4", oid]);
    await compare(root, ["--short=1", oid]);
    await compare(root, ["--verify", oid.slice(0, 8)]);
  }
  const prefix = oids[0].slice(0, 4);
  const result = await query(root, ["--verify", prefix]);
  assert.equal(result.status, native(root, ["--verify", prefix]).status);
  assert.match(result.stderr, /ambiguous object prefix/);
  assert.equal(result.stdout, "");
  assert.deepEqual(await snapshot(root), before);
  const pack = await git.packObjects({ fs: filesystem, dir: root, oids, write: true });
  await git.indexPack({
    fs: filesystem,
    dir: root,
    filepath: `.git/objects/pack/${pack.filename}`,
  });
  for (const oid of oids)
    await fs.unlink(`${root}/.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`);
  const packedBefore = await snapshot(root);
  for (const oid of oids) {
    await compare(root, ["--short=4", oid]);
    await compare(root, ["--verify", oid.slice(0, 8)]);
  }
  assert.deepEqual(await snapshot(root), packedBefore);
});

test("rev-parse rejects unsupported forms and ambiguous refs explicitly without writes", async (context) => {
  const { root, oid } = await repository(context);
  await git.writeRef({ fs: filesystem, dir: root, ref: "refs/tags/main", value: oid });
  const before = await snapshot(root);
  const unsupported = [
    ["--abbrev-ref", "HEAD"],
    ["--git-dir"],
    ["--quiet", "--verify", "missing"],
    ["HEAD~1"],
    ["HEAD^{}"],
    ["HEAD:story"],
    ["main..v1"],
    ["@{1}"],
    ["../HEAD"],
    ["--", "HEAD"],
    ["HEAD", "--short"],
    ["--short=bad", "HEAD"],
    ["--short=-1", "HEAD"],
    ["--short=", "HEAD"],
    ["story"],
    ["main"],
    ["--verify", "main"],
  ];
  for (const argv of unsupported) {
    const result = await query(root, argv);
    assert.equal(result.status, 129, JSON.stringify({ argv, result }));
    assert.match(result.stderr, /unsupported|must precede|integer|ambiguous ref/);
    assert.equal(result.stdout, "");
  }
  await compare(root, ["refs/heads/main", "refs/tags/main"]);
  assert.deepEqual(await snapshot(root), before);
});

test("bundled git CLI on Bun shares revision query results and leaves fixture bytes unchanged", async (context) => {
  const { scratch, root, nested } = await repository(context);
  const before = await snapshot(scratch);
  const cli = resolve(import.meta.dirname, "../dist/git-cli.js");
  for (const argv of [
    ["--verify", "HEAD"],
    ["--short=8", "HEAD"],
    ["--show-prefix"],
    ["--show-toplevel"],
    ["--is-inside-work-tree"],
    ["--verify", "missing"],
    ["HEAD", "main"],
  ]) {
    const result = spawnSync("bun", [cli, "rev-parse"].concat(argv), {
      cwd: nested,
      env: { ...environment, PATH: process.env.PATH ?? environment.PATH },
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    assert.equal(result.status, native(nested, argv).status, result.stderr.slice(-2000));
    assert.deepEqual(
      { status: result.status, stdout: result.stdout, stderr: result.stderr },
      native(nested, argv),
    );
  }
  assert.equal((await query(root, ["--verify", "HEAD"])).status, 0);
  assert.deepEqual(await snapshot(scratch), before);
});
