import { YAML } from "bun";
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function workflowFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? workflowFiles(path) : [path];
  });
}

test("CI release downloads cannot use public-only setup actions or curl", () => {
  const findings = workflowFiles(join(root, ".github")).flatMap((path) => {
    const text = readFileSync(path, "utf8");
    return text
      .split("\n")
      .flatMap((line, index) =>
        /uses:\s*(?:oven-sh\/setup-bun|actions\/setup-node|mozilla-actions\/sccache-action|bytecodealliance\/actions\/wasmtime\/setup)@/.test(
          line,
        ) || /curl[^\n]*https:\/\/github\.com\/[^\s]+\/releases\/download\//.test(line)
          ? [`${path.slice(root.length)}:${index + 1}: ${line.trim()}`]
          : [],
      );
  });
  expect(findings).toEqual([]);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected mapping");
  return value;
}
function steps(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected steps");
  return value.map(record);
}
const workflows = workflowFiles(join(root, ".github/workflows")).map((path) => ({
  path,
  workflow: record(YAML.parse(readFileSync(path, "utf8"))),
}));

function programReleaseJobs(): Record<string, unknown> {
  const workflow = workflows.find(({ path }) => path.endsWith("/program-release.yml"))?.workflow;
  return record(workflow?.jobs);
}

function programReleaseStep(name: string): string {
  const allSteps = Object.values(programReleaseJobs()).flatMap((job) => steps(record(job).steps));
  const script = allSteps.find((step) => step.name === name)?.run;
  if (typeof script !== "string") throw new Error(`Missing program release step ${name}`);
  return script;
}

test("the program publish job retries from the qualified artifact without building", () => {
  const jobs = programReleaseJobs();
  const release = record(jobs.release);
  const publish = record(jobs.publish);
  expect(record(release.outputs).staged_artifact).toBe("${{ steps.staged.outputs.artifact-id }}");
  const build = steps(release.steps).find(
    (step) => step.name === "Prepare every family in the closure with its own route",
  );
  expect(record(build?.env).WASI_LIBC_SCRATCH_ROOT).toBe("${{ runner.temp }}");
  expect(publish.needs).toBe("release");
  const publishSteps = steps(publish.steps);
  const download = publishSteps.findIndex((step) => step.uses === "actions/download-artifact@v4");
  const npm = publishSteps.findIndex((step) => step.name === "Publish program packages to npm");
  expect(download).toBeGreaterThanOrEqual(0);
  expect(npm).toBeGreaterThan(download);
  const inputs = record(publishSteps[download]?.with);
  expect(inputs["artifact-ids"]).toBe("${{ needs.release.outputs.staged_artifact }}");
  expect(inputs["run-id"]).toBe("${{ github.run_id }}");
  expect(publishSteps.map((step) => step.run).join("\n")).not.toMatch(
    /build-python|prepare:package/,
  );
});

test("program release preflight downloads a matching draft receipt across release pages", () => {
  const cwd = mkdtempSync(join(tmpdir(), "waffle-draft-receipt-"));
  try {
    mkdirSync(join(cwd, ".build/program-release"), { recursive: true });
    const ghFixture = `
gh() {
  if [ "$1 $2 $3 $4" = 'api --paginate --slurp repos/ShaulLavo/waffle/releases?per_page=100' ]; then
    printf '%s\\n' '[[{"tag_name":"other-tag","id":6,"draft":false}],[{"tag_name":"programs-v0.0.24","id":24,"draft":true,"assets":[{"id":125,"name":"program-release.json","state":"uploaded"}]}]]'
    return
  fi
  [ "$1 $2 $3 $4" = 'api -H Accept: application/octet-stream repos/ShaulLavo/waffle/releases/assets/125' ] || return 1
  printf '%s\\n' '{"receipt":"draft"}'
}`;
    const result = Bun.spawnSync(
      [
        "bash",
        "-c",
        ghFixture + "\n" + programReleaseStep("Read the receipt for an existing release"),
      ],
      {
        cwd,
        env: {
          ...process.env,
          RELEASE_TAG: "programs-v0.0.24",
          GITHUB_REPOSITORY: "ShaulLavo/waffle",
          GITHUB_OUTPUT: join(cwd, "outputs"),
        },
      },
    );
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(join(cwd, ".build/program-release/existing-receipt.json"), "utf8")).toBe(
      '{"receipt":"draft"}\n',
    );
    expect(readFileSync(join(cwd, "outputs"), "utf8")).toBe("draft_id=24\n");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an incomplete draft can resume only with the workflow's receipt digest", () => {
  const cwd = mkdtempSync(join(tmpdir(), "waffle-empty-release-draft-"));
  try {
    mkdirSync(join(cwd, ".build/program-release"), { recursive: true });
    const digest = "a".repeat(64);
    const output = join(cwd, "outputs");
    const env = {
      ...process.env,
      RELEASE_TAG: "programs-v0.0.24",
      GITHUB_REPOSITORY: "ShaulLavo/waffle",
      GITHUB_OUTPUT: output,
    };
    const body = `<!-- waffle-npm-receipt-sha256=${digest} -->\n\nGenerated notes`;
    const starter = { id: 125, name: "program-release.json", state: "starter", size: 0 };
    const draft = { tag_name: env.RELEASE_TAG, id: 24, draft: true, body };
    const preflight = (notes: string, assets: object[]) =>
      Bun.spawnSync(
        [
          "bash",
          "-c",
          'gh() { printf "%s\\n" "$RELEASES"; }\n' +
            programReleaseStep("Read the receipt for an existing release"),
        ],
        {
          cwd,
          env: {
            ...env,
            RELEASES: JSON.stringify([[{ ...draft, assets, body: notes }]]),
          },
        },
      );
    const unmarked = preflight("Unrelated release notes", []);
    expect(unmarked.exitCode).not.toBe(0);
    expect(unmarked.stderr.toString()).toContain("draft with a receipt digest");
    expect(preflight(body, [{ ...starter, size: 1 }]).exitCode).not.toBe(0);
    const marked = preflight(body, []);
    expect(marked.exitCode, marked.stderr.toString()).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(
      `receipt_sha256=${digest}\nstarter_id=\ndraft_id=24\n`,
    );
    writeFileSync(output, "");
    expect(preflight(body, [starter]).exitCode).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(
      `receipt_sha256=${digest}\nstarter_id=125\ndraft_id=24\n`,
    );

    const receipt = ".build/program-release/program-release.json";
    writeFileSync(join(cwd, receipt), '{"receipt":"verified"}\n');
    const publish = (state: string) =>
      Bun.spawnSync(
        [
          "bash",
          "-c",
          `gh() {
  printf '%s\\n' "$*" >&2
  if [ "$*" = 'api repos/ShaulLavo/waffle/releases/24' ]; then printf '%s\\n' "$CURRENT_DRAFT"; fi
}\n` + programReleaseStep("Publish the npm closure receipt"),
        ],
        {
          cwd,
          env: {
            ...env,
            DRAFT_ID: "24",
            STARTER_ID: "125",
            EXISTING_RECEIPT_SHA256: digest,
            CURRENT_DRAFT: JSON.stringify({ ...draft, assets: [{ ...starter, state }] }),
          },
        },
      );
    const changed = publish("uploaded");
    expect(changed.exitCode).not.toBe(0);
    expect(changed.stderr.toString().trim()).toBe("api repos/ShaulLavo/waffle/releases/24");
    const result = publish("starter");
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString().split("\n").filter(Boolean)).toEqual([
      "api repos/ShaulLavo/waffle/releases/24",
      "api --method DELETE repos/ShaulLavo/waffle/releases/assets/125",
      `release upload ${env.RELEASE_TAG} ${receipt}`,
      "api --method PATCH repos/ShaulLavo/waffle/releases/24 -F draft=false",
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("program release rejects a source tag with a different publisher before publishing", () => {
  const cwd = mkdtempSync(join(tmpdir(), "waffle-publisher-version-"));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git("init", "-q");
    mkdirSync(join(cwd, "scripts"));
    const publisher = join(cwd, "scripts/publish-programs-npm.ts");
    const commit = (label: string) => {
      writeFileSync(publisher, label + "\n");
      git("add", publisher);
      git("-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit", "-qm", label);
      return git("rev-parse", "HEAD");
    };
    const old = commit("old publisher");
    const workflow = commit("current publisher");
    const run = () =>
      Bun.spawnSync(
        ["bash", "-c", programReleaseStep("Verify the tag uses the workflow publisher")],
        {
          cwd,
          env: { ...process.env, GITHUB_WORKFLOW_SHA: workflow },
        },
      );
    expect(run().exitCode).toBe(0);
    git("checkout", "--detach", old);
    const result = run();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("same npm publisher as the workflow revision");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
const safeActions = new Set([
  "actions/cache",
  "actions/cache/restore",
  "actions/cache/save",
  "actions/checkout",
  "actions/download-artifact",
  "actions/upload-artifact",
  "changesets/action",
  "dorny/paths-filter",
  "dtolnay/rust-toolchain",
  "docker/login-action",
]);

test("new remote CI actions must be audited for implicit release downloads", () => {
  for (const path of workflowFiles(join(root, ".github"))) {
    const source = readFileSync(path, "utf8");
    const actions = source.matchAll(/uses:\s*([^\s@]+)@[^\s]+/g);
    for (const match of actions)
      expect(safeActions.has(match[1] ?? ""), `${path}: ${match[1]}`).toBe(true);
  }
});

function verifyShellDownloads(path: string, list: Record<string, unknown>[]) {
  for (const step of list) {
    if (typeof step.run !== "string") continue;
    const expanded = step.run + JSON.stringify(step.env ?? {});
    if (/releases\/download\//.test(expanded))
      expect(step.run, path).not.toMatch(/\b(curl|wget)\b/);
  }
}

function verifyJob(path: string, job: Record<string, unknown>) {
  if (!job.steps) return;
  const list = steps(job.steps);
  const cache = list.findIndex((step) => step.uses === "./.github/actions/release-downloads");
  const consumers = list.flatMap((step, index) =>
    /^\.\/\.github\/actions\/(setup-tools|program-optimizer|rust-build-cache|setup-wasmtime)$/.test(
      String(step.uses),
    )
      ? [index]
      : [],
  );
  if (cache >= 0) {
    const saved = list.at(-1);
    expect(saved?.uses).toBe("./.github/actions/save-release-downloads");
    expect(saved?.if).toBe("always() && env.CI_RELEASE_CACHE_INITIAL != ''");
  }
  for (const index of consumers) {
    expect(cache, `${path}: cache before ${list[index]?.uses}`).toBeGreaterThanOrEqual(0);
    expect(cache).toBeLessThan(index);
  }
  verifyShellDownloads(path, list);
}

test("every download consumer restores release bytes before bootstrap and has a job token", () => {
  for (const { path, workflow } of workflows) {
    expect(record(workflow.env).GITHUB_TOKEN, path).toBe("${{ github.token }}");
    for (const value of Object.values(record(workflow.jobs))) verifyJob(path, record(value));
  }
});

test("local download actions cannot bypass the shared transport with a multiline curl", () => {
  for (const path of workflowFiles(join(root, ".github/actions"))) {
    const action = record(YAML.parse(readFileSync(path, "utf8")));
    verifyShellDownloads(path, steps(record(action.runs).steps));
  }
});

test("release cache saves an asset inventory only when new complete assets arrived", () => {
  const action = record(
    YAML.parse(readFileSync(join(root, ".github/actions/release-downloads/action.yml"), "utf8")),
  );
  const cache = steps(record(action.runs).steps).find(
    (step) => step.uses === "actions/cache/restore@v4",
  );
  const inputs = record(cache?.with);
  expect(inputs.path).toBe("${{ runner.temp }}/github-release-assets");
  expect(String(inputs.key)).toContain("${{ github.job }}");
  expect(String(inputs["restore-keys"])).toContain("${{ github.job }}-");
  const saved = record(
    YAML.parse(
      readFileSync(join(root, ".github/actions/save-release-downloads/action.yml"), "utf8"),
    ),
  );
  const save = steps(record(saved.runs).steps).find(
    (step) => step.uses === "actions/cache/save@v4",
  );
  expect(save?.if).toBe("steps.inventory.outputs.changed == 'true'");
  expect(String(record(save?.with).key)).toContain("${{ steps.inventory.outputs.inventory }}");
  expect(String(record(save?.with).key)).not.toMatch(/run_id|run_attempt/);
});

test("indirect native and package downloads enter the shared transport", () => {
  for (const path of [
    "packages/waffle-relay/scripts/prepare-relay-image.ts",
    "packages/waffle-relay/scripts/install-check.ts",
    "scripts/program-release.ts",
    "scripts/program-rebind.ts",
  ]) {
    const source = readFileSync(join(root, path), "utf8");
    expect(source, path).toContain("releaseDownload");
    expect(source, path).not.toMatch(/await fetch\(url|execFileSync\("curl"/);
  }
  const native = readFileSync(
    join(root, "packages/waffle-relay/scripts/prepare-native.ts"),
    "utf8",
  );
  expect(native).toContain('if (process.env.GITHUB_ACTIONS === "true") await seedNativePrebuild()');
  expect(native).toContain('resolve("prebuild-install/bin.js")');
  for (const path of ["bun.lock", "site/bun.lock"]) {
    const lock = readFileSync(join(root, path), "utf8");
    expect(lock, path).not.toMatch(/https:\/\/github\.com\/[^"\s]+\/releases\/download\//);
  }
});
