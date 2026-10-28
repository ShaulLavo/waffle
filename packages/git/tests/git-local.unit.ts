import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as git from "isomorphic-git";
import fixture from "../scripts/owned-fixtures/git-local.json" with { type: "json" };
import { runGit } from "../src/git-command";
import { nodeGitFilesystem as filesystem } from "../src/node-filesystem";
import { gitSnapshot } from "./helpers/git-snapshot";
import { captureGit } from "./helpers/git-output";

async function repository(context: TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), "bash-web-git-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const command = async (argv: readonly string[]) => {
    return captureGit((invocation) => runGit(filesystem, invocation), {
      argv,
      cwd: root,
      env: fixture.provenance.environment,
    });
  };
  const ok = async (...argv: string[]) => {
    const result = await command(argv);
    assert.equal(result.status, 0, result.stderr);
    return result;
  };
  return { root, command, ok };
}

for (const example of fixture.cases) {
  test(`native filesystem replay: ${example.id}`, async (context) => {
    const { root, command } = await repository(context);
    for (const [index, step] of example.steps.entries()) {
      const label = `${example.id} step ${index}: ${JSON.stringify(step.action)}`;
      await replayStep(root, command, step, label);
      assert.deepEqual(await gitSnapshot(filesystem, root, step.state.history), step.state, label);
    }
    const oid = await git.resolveRef({ fs: filesystem, dir: root, ref: "HEAD" });
    assert.match(oid, /^[a-f0-9]{40}$/);
  });
}

async function replayStep(
  root: string,
  command: Awaited<ReturnType<typeof repository>>["command"],
  step: (typeof fixture.cases)[number]["steps"][number],
  label: string,
) {
  if (step.action.kind === "write") {
    assert.ok(step.action.path !== undefined);
    await fs.mkdir(dirname(join(root, step.action.path)), { recursive: true });
    await fs.writeFile(join(root, step.action.path), step.action.text ?? "");
    return;
  }
  if (step.action.kind === "remove") {
    assert.ok(step.action.path !== undefined);
    return fs.unlink(join(root, step.action.path));
  }
  assert.ok(step.action.argv);
  assert.ok(step.expected);
  const result = await command(step.action.argv);
  assert.equal(result.status, step.expected.status, `${label}: ${result.stderr}`);
  if (step.expected.stdout !== null)
    assert.equal(normalize(result.stdout), step.expected.stdout, label);
  if (step.expected.stderr !== null) assert.equal(result.stderr, step.expected.stderr, label);
}

function normalize(value: string) {
  return value.replace(/^index [0-9a-f]+\.\.[0-9a-f]+/gm, "index <old>..<new>");
}

test("tracked stash preserves staged and unstaged content and rejects dirty apply", async (context) => {
  const { root, command, ok } = await repository(context);
  await ok("init");
  await fs.writeFile(`${root}/story`, "base\n");
  await ok("add", "story");
  await ok("commit", "-m", "base");
  await fs.writeFile(`${root}/story`, "stage\n");
  await ok("add", "story");
  await fs.writeFile(`${root}/story`, "stage\nwork\n");
  await ok("stash", "push", "-m", "shelved");
  assert.equal(await fs.readFile(`${root}/story`, "utf8"), "base\n");
  assert.equal((await ok("status", "--porcelain")).stdout, "");
  await fs.writeFile(`${root}/story`, "do not overwrite\n");
  assert.equal((await command(["stash", "apply"])).status, 1);
  assert.equal(await fs.readFile(`${root}/story`, "utf8"), "do not overwrite\n");
  await fs.writeFile(`${root}/story`, "base\n");
  await ok("stash", "pop", "--index");
  assert.equal(await fs.readFile(`${root}/story`, "utf8"), "stage\nwork\n");
  assert.equal((await ok("status", "--porcelain")).stdout, "MM story\n");
  assert.equal((await ok("stash", "list")).stdout, "");
});

test("unsupported remote and stash flags preserve repository files", async (context) => {
  const { root, command } = await repository(context);
  await command(["init"]);
  const before = await fs.readFile(`${root}/.git/HEAD`, "utf8");
  assert.equal((await command(["clone", "https://example.invalid/repo"])).status, 129);
  assert.equal((await command(["stash", "push", "--all"])).status, 129);
  assert.equal(await fs.readFile(`${root}/.git/HEAD`, "utf8"), before);
});

test("same-sized edits with subsecond timestamps are never reported clean", async (context) => {
  const { root, command } = await repository(context);
  assert.equal((await command(["init"])).status, 0);
  await fs.writeFile(`${root}/story`, "first\n");
  await fs.utimes(`${root}/story`, 1000000000.1, 1000000000.1);
  assert.equal((await command(["add", "story"])).status, 0);
  assert.equal((await command(["commit", "-m", "base"])).status, 0);
  await fs.writeFile(`${root}/story`, "other\n");
  await fs.utimes(`${root}/story`, 1000000000.2, 1000000000.2);
  const result = await command(["status", "--porcelain"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, " M story\n");
});

test("add force stages an explicitly ignored file", async (context) => {
  const { root, command } = await repository(context);
  await command(["init"]);
  await fs.writeFile(`${root}/.gitignore`, "secret\n");
  await fs.writeFile(`${root}/secret`, "local content\n");
  assert.equal((await command(["add", "secret"])).status, 1);
  const result = await command(["add", "-f", "secret"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match((await command(["status", "--porcelain"])).stdout, /^A  secret\n/m);
});

test("untracked-only stash preserves nested bytes, entries and colliding caller files", async (context) => {
  const { root, command, ok } = await repository(context);
  await ok("init");
  await ok("commit", "--allow-empty", "-m", "base");
  await fs.mkdir(`${root}/nested`);
  const bytes = new Uint8Array([0, 255, 128, 1]);
  await fs.writeFile(`${root}/nested/loose`, bytes);
  await ok("stash", "push", "-u", "-m", "first");
  assert.equal((await ok("status")).stdout, "");
  const oid = await git.resolveRef({ fs: filesystem, dir: root, ref: "refs/stash" });
  assert.equal((await git.readCommit({ fs: filesystem, dir: root, oid })).commit.parent.length, 3);
  await fs.writeFile(`${root}/nested/loose`, "caller owns this");
  assert.equal((await command(["stash", "pop", "--index"])).status, 1);
  assert.equal(await fs.readFile(`${root}/nested/loose`, "utf8"), "caller owns this");
  assert.equal((await ok("stash", "list", "--format=%gs")).stdout, "On main: first\n");
  await fs.unlink(`${root}/nested/loose`);
  await ok("stash", "apply", "--index");
  assert.deepEqual(new Uint8Array(await fs.readFile(`${root}/nested/loose`)), bytes);
  await fs.unlink(`${root}/nested/loose`);
  await fs.writeFile(`${root}/another`, "second");
  await ok("stash", "push", "-u", "-m", "second");
  await ok("stash", "drop", "stash@{1}");
  assert.equal((await ok("stash", "list", "--format=%gs")).stdout, "On main: second\n");
  await ok("stash", "pop");
  assert.equal(await fs.readFile(`${root}/another`, "utf8"), "second");
  assert.equal((await ok("stash", "list")).stdout, "");
});

test("stash restores staged deletion and leaves unrelated untracked files alone", async (context) => {
  const { root, ok } = await repository(context);
  await ok("init");
  await fs.writeFile(`${root}/gone`, "base");
  await ok("add", ".");
  await ok("commit", "-m", "base");
  await fs.unlink(`${root}/gone`);
  await ok("add", "-u");
  await fs.writeFile(`${root}/loose`, "keep");
  await ok("stash", "push", "-m", "delete");
  assert.equal(await fs.readFile(`${root}/gone`, "utf8"), "base");
  assert.equal(await fs.readFile(`${root}/loose`, "utf8"), "keep");
  await ok("stash", "pop", "--index");
  assert.equal((await ok("status")).stdout, "D  gone\n?? loose\n");
});

test("merge abort keeps binary bytes and unrelated unstaged edits", async (context) => {
  const { root, command, ok } = await repository(context);
  await ok("init");
  const binary = new Uint8Array([0, 255, 128]);
  await fs.writeFile(`${root}/binary`, binary);
  await fs.writeFile(`${root}/story`, "base\n");
  await fs.writeFile(`${root}/other`, "base\n");
  await ok("add", ".");
  await ok("commit", "-m", "base");
  await ok("checkout", "-b", "side");
  await fs.writeFile(`${root}/story`, "side\n");
  await ok("add", ".");
  await ok("commit", "-m", "side");
  await ok("checkout", "main");
  await fs.writeFile(`${root}/story`, "main\n");
  await ok("add", ".");
  await ok("commit", "-m", "main");
  assert.equal((await command(["merge", "side"])).status, 1);
  await fs.writeFile(`${root}/story`, "base\n");
  assert.equal((await ok("status")).stdout, "UU story\n");
  await fs.writeFile(`${root}/other`, "caller edit\n");
  await ok("merge", "--abort");
  assert.deepEqual(new Uint8Array(await fs.readFile(`${root}/binary`)), binary);
  assert.equal(await fs.readFile(`${root}/other`, "utf8"), "caller edit\n");
});
