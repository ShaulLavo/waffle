import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import fixture from "./owned-fixtures/git-local.json" with { type: "json" };
import {
  gitLocalConfig,
  gitLocalDigest,
  gitLocalEnvironment,
  gitLocalInputs,
  gitLocalPath,
  gitLocalProbes,
  nativeGit,
  normalizeGitLocalOutput,
  recordGitLocal,
  validateGitLocalRecording,
  type GitLocalCase,
  type GitLocalState,
} from "./record-git-local.ts";

function redigest<T extends { cases: unknown; provenance: object }>(value: T) {
  return {
    ...value,
    provenance: { ...value.provenance, casesSha256: gitLocalDigest(value.cases) },
  };
}

function withSteps(change: (step: (typeof fixture.cases)[number]["steps"][number]) => unknown) {
  return redigest({
    ...fixture,
    cases: fixture.cases.map((entry) => ({ ...entry, steps: entry.steps.map(change) })),
  });
}

function contracts(cases: typeof fixture.cases | GitLocalCase[]) {
  return cases.map((example) => ({
    id: example.id,
    semantics: example.semantics,
    steps: example.steps.map(({ action, expected, state }) => ({ action, expected, state })),
  }));
}

test("fixture shape, inputs and evidence digests are intact", () => {
  validateGitLocalRecording(fixture);
  assert.equal(fixture.provenance.environment.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(fixture.provenance.environment.GIT_CONFIG_NOSYSTEM, "1");
  assert.ok(!Object.hasOwn(gitLocalEnvironment, "HOME"));
  assert.deepEqual(fixture.provenance.config, gitLocalConfig);
  assert.deepEqual(fixture.provenance.probes, gitLocalProbes);
  const commands = gitLocalInputs
    .flatMap((input) => input.actions)
    .flatMap((action) => (action.kind === "git" ? [action.argv[0]] : []));
  for (const command of [
    "init",
    "add",
    "commit",
    "status",
    "log",
    "diff",
    "branch",
    "checkout",
    "merge",
    "stash",
  ])
    assert.ok(commands.includes(command), `Missing ${command} acceptance coverage`);
  assert.doesNotMatch(JSON.stringify(contracts(fixture.cases)), /\b[0-9a-f]{40}\b/);
});

test("native Git replays every static file, ref, history, output and exit-status expectation", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bash-web-git-controls-"));
  try {
    const observed = recordGitLocal(scratch);
    validateGitLocalRecording(observed);
    assert.deepEqual(contracts(observed.cases), contracts(fixture.cases));
    assert.deepEqual(readdirSync(scratch), [], "Successful recording left scratch repos");
    assertUsageSemantics(observed.cases);
    const altered = contracts(fixture.cases);
    const first = altered[0];
    assert.ok(first);
    const last = first.steps.at(-1);
    assert.ok(last);
    Object.assign(last.state.files, { "invented.txt": "incorrect expectation\n" });
    assert.notDeepEqual(
      contracts(observed.cases),
      altered,
      "Replay must reject changed file expectations",
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

function example(cases: GitLocalCase[], id: string): GitLocalCase {
  const result = cases.find((entry) => entry.id === id);
  assert.ok(result, `Missing ${id}`);
  return result;
}

function gitSteps(value: GitLocalCase, command: string) {
  return value.steps.filter(
    (step) => step.action.kind === "git" && step.action.argv[0] === command,
  );
}

function hasMerge(state: GitLocalState): boolean {
  return Object.values(state.history).some((commit) => commit.parents.length === 2);
}

function assertUsageSemantics(cases: GitLocalCase[]) {
  const index = example(cases, "index-worktree");
  assert.ok(index.steps.some((step) => step.state.status.includes("MM notes.txt")));
  assert.ok(index.steps.some((step) => step.state.status.includes("?? loose.txt")));
  const emptyCommit = gitSteps(index, "commit").at(-1);
  assert.equal(emptyCommit?.expected?.status, 1);
  assert.equal(emptyCommit?.state.files["spaced name.txt"], undefined);
  const branches = example(cases, "branches-and-merges");
  const merge = gitSteps(branches, "merge").at(-1);
  assert.equal(merge?.expected?.status, 0);
  assert.ok(merge && hasMerge(merge.state));
  assert.equal(gitSteps(branches, "checkout").at(-1)?.expected?.status, 1);
  assertConflictSemantics(example(cases, "conflict-and-recovery"));
  assertStashSemantics(example(cases, "stash-index-and-untracked"));
}

function assertConflictSemantics(value: GitLocalCase) {
  const merges = gitSteps(value, "merge");
  assert.deepEqual(
    merges.map((step) => step.expected?.status),
    [1, 0, 1],
  );
  assert.equal(merges[0]?.state.status, "UU story.txt\n");
  assert.equal(
    merges[0]?.state.files["story.txt"],
    "<<<<<<< HEAD\nmain\n=======\nside\n>>>>>>> side\n",
  );
  assert.equal(merges[1]?.state.files["story.txt"], "main\n");
  assert.equal(merges[1]?.state.status, "");
  assert.deepEqual(merges[0]?.state.refs, merges[1]?.state.refs);
  const final = value.steps.at(-1);
  assert.equal(final?.state.files["story.txt"], "main and side\n");
  assert.equal(final?.state.status, "");
  assert.ok(final && hasMerge(final.state));
}

function assertStashSemantics(value: GitLocalCase) {
  const steps = gitSteps(value, "stash");
  const saved = steps.find(
    (step) => step.action.kind === "git" && step.action.argv.includes("shelved work"),
  );
  assert.equal(saved?.state.status, "");
  assert.equal(saved?.state.files["story.txt"], "base\n");
  assert.equal(saved?.state.files["loose.txt"], undefined);
  assert.deepEqual(saved?.state.stash, ["On main: shelved work"]);
  const popped = steps.find((step) => step.action.kind === "git" && step.action.argv[1] === "pop");
  assert.equal(popped?.state.files["story.txt"], "staged\nunstaged\n");
  assert.equal(popped?.state.files["loose.txt"], "keep me\n");
  assert.equal(popped?.state.status, "MM story.txt\n?? loose.txt\n");
  assert.deepEqual(popped?.state.stash, []);
  const applied = steps.find(
    (step) => step.action.kind === "git" && step.action.argv[1] === "apply",
  );
  assert.equal(applied?.state.files["story.txt"], "another change\n");
  assert.deepEqual(applied?.state.stash, ["On main: apply separately"]);
  assert.deepEqual(value.steps.at(-1)?.state.stash, []);
}

test("changed command, provenance, output, or state cannot pass the recorded digest", () => {
  const changed = structuredClone(fixture);
  const step = changed.cases[0]?.steps[0];
  assert.ok(step);
  Object.assign(step.state.files, { "injected.txt": "tamper" });
  assert.throws(() => validateGitLocalRecording(changed));
  assert.throws(() => validateGitLocalRecording({ ...fixture, schema: 2 }));
  assert.throws(() =>
    validateGitLocalRecording({
      ...fixture,
      provenance: {
        ...fixture.provenance,
        environment: { ...gitLocalEnvironment, HOME: "/owner" },
      },
    }),
  );
  assert.throws(() =>
    validateGitLocalRecording({
      ...fixture,
      provenance: { ...fixture.provenance, inputsSha256: "0".repeat(64) },
    }),
  );
});

test("malformed state, command, status and dangling refs fail even with a recomputed digest", () => {
  for (const state of [
    { ...fixture.cases[0]?.steps[0]?.state, status: 123 },
    { ...fixture.cases[0]?.steps[0]?.state, files: { "../escape": "bad" } },
    { ...fixture.cases[0]?.steps[0]?.state, files: { ".git/config": "bad" } },
    { ...fixture.cases[0]?.steps[0]?.state, refs: { "refs/heads/main": "c999" } },
    {
      ...fixture.cases[0]?.steps[0]?.state,
      history: { c1: { subject: "bad", parents: ["c999"] } },
    },
    { ...fixture.cases[0]?.steps[0]?.state, extra: true },
  ])
    assert.throws(() => validateGitLocalRecording(withSteps((step) => ({ ...step, state }))));
  for (const replacement of [
    { action: { kind: "git", argv: ["push"], output: "exit-only" } },
    { expected: { status: null, stdout: null, stderr: null } },
    { expected: { status: -1, stdout: null, stderr: null } },
    { expected: { status: 0, stdout: "invented output", stderr: null } },
    { oracle: { status: 0, stdout: null, stderr: "" } },
  ])
    assert.throws(() =>
      validateGitLocalRecording(withSteps((step) => ({ ...step, ...replacement }))),
    );
});

test("shape controls reject missing scenarios, reordered steps and missing provenance", () => {
  assert.throws(() => validateGitLocalRecording(null));
  assert.throws(() => validateGitLocalRecording({ ...fixture, provenance: {} }));
  assert.throws(() =>
    validateGitLocalRecording(redigest({ ...fixture, cases: fixture.cases.slice(1) })),
  );
  const reversed = structuredClone(fixture);
  reversed.cases[0]?.steps.reverse();
  assert.throws(() => validateGitLocalRecording(redigest(reversed)));
});

test("normalization changes only diff index object identities", () => {
  assert.equal(
    normalizeGitLocalOutput("index abc1234..def5678 100644\n+abc1234\n"),
    "index <old>..<new> 100644\n+abc1234\n",
  );
  assert.equal(normalizeGitLocalOutput("index words\n"), "index words\n");
});

test("recording failure removes its owned repository and preserves unrelated files", () => {
  const scratch = mkdtempSync(join(tmpdir(), "bash-web-git-failure-"));
  const input = gitLocalInputs[0];
  assert.ok(input);
  writeFileSync(join(scratch, "unrelated.txt"), "preserve\n");
  input.actions.splice(1, 0, { kind: "write", path: "../escape", text: "must fail" });
  try {
    assert.throws(() => recordGitLocal(scratch));
    assert.deepEqual(readdirSync(scratch), ["unrelated.txt"]);
    assert.equal(readFileSync(join(scratch, "unrelated.txt"), "utf8"), "preserve\n");
    assert.equal(nativeGit(scratch, ["--version"]).status, 0);
  } finally {
    input.actions.splice(1, 1);
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("worktree operations reject absolute paths and Git metadata", () => {
  for (const path of [
    "",
    "/absolute",
    "../escape",
    "dir/../../escape",
    ".git/config",
    "dir/.git/config",
  ])
    assert.throws(() => gitLocalPath("/repo", path));
  assert.equal(gitLocalPath("/repo", "spaced name.txt"), join("/repo", "spaced name.txt"));
});
