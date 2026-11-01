import { Glob, YAML } from "bun";
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { record, array } from "../scripts/relay-image-contract.ts";

const text = readFileSync(
  new URL("../../../.github/workflows/relay-image.yml", import.meta.url),
  "utf8",
);
const workflow = record(YAML.parse(text));
const jobs = record(workflow.jobs);
const qualify = record(jobs.qualify);
const publish = record(jobs.publish);
const guard =
  "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.repository == 'ShaulLavo/waffle'";
const qualificationSteps = array(qualify.steps).map(record);
const publicationSteps = array(publish.steps).map(record);

function permits(expression: unknown, context: Record<string, string>) {
  expect(expression).toBe(guard);
  return String(expression)
    .split(" && ")
    .every((clause) => {
      const [key, value] = clause.split(" == ");
      return context[String(key)] === value?.slice(1, -1);
    });
}
const events = ["pull_request", "pull_request_target", "push", "workflow_run", "workflow_dispatch"];
const refs = [
  "refs/heads/main",
  "refs/heads/feature",
  "refs/tags/waffle-v0.0.110",
  "refs/pull/1/merge",
];
const repositories = ["ShaulLavo/waffle", "fork/waffle"];
const cases = events.flatMap((event) =>
  refs.flatMap((ref) => repositories.map((repository) => ({ event, ref, repository }))),
);

test("only canonical repository main dispatch can save, upload or enter the single write job", () => {
  expect(Object.keys(jobs)).toEqual(["qualify", "publish"]);
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(publish.permissions).toEqual({ contents: "read", packages: "write" });
  expect(text.match(/packages: write/g)).toHaveLength(1);
  expect(publish.needs).toBe("qualify");
  expect(workflow.on).not.toHaveProperty("pull_request_target");
  const upload = qualificationSteps.find((step) => step.id === "image");
  for (const { event, ref, repository } of cases) {
    const context = {
      "github.event_name": event,
      "github.ref": ref,
      "github.repository": repository,
    };
    const expected =
      event === "workflow_dispatch" &&
      ref === "refs/heads/main" &&
      repository === "ShaulLavo/waffle";
    expect(permits(publish.if, context)).toBe(expected);
    expect(permits(upload?.if, context)).toBe(expected);
  }
});

test("dispatch defaults to WS, PRs qualify both fixed choices, and exact Git ancestry is available", () => {
  const input = record(record(record(workflow.on).workflow_dispatch).inputs);
  expect(record(input.variant)).toMatchObject({
    type: "choice",
    required: true,
    default: "ws",
    options: ["ws", "native"],
  });
  expect(record(record(qualify.strategy).matrix).variant).toBe(
    "${{ fromJSON(github.event_name == 'pull_request' && '[\"ws\",\"native\"]' || format('[\"{0}\"]', inputs.variant)) }}",
  );
  const checkout = qualificationSteps[0];
  expect(record(checkout?.with)["fetch-depth"]).toBe(0);
});

test("every preparation, verifier, custody and contract input triggers read-only qualification", () => {
  const paths = array(record(record(workflow.on).pull_request).paths).map(String);
  const selected = (path: string) => paths.some((pattern) => new Glob(pattern).match(path));
  const base = new URL("../", import.meta.url);
  const inputs = [
    ".github/workflows/relay-image.yml",
    "packages/waffle-relay/docs/native-container.md",
    "packages/waffle-relay/container/.dockerignore",
    "packages/waffle-relay/container/native/.dockerignore",
  ];
  for (const directory of ["container", "container/native", "scripts", "tests"]) {
    const files = readdirSync(new URL(directory, base));
    const relevant = directory.startsWith("container")
      ? files.filter((file) => !file.startsWith(".") && !file.includes("native"))
      : files.filter(
          (file) =>
            file.includes("relay-image") ||
            file === "prepare-native-container.ts" ||
            file.endsWith("container.test.ts") ||
            file === "tcp-native-fixture.ts",
        );
    for (const file of relevant) inputs.push(`packages/waffle-relay/${directory}/${file}`);
  }
  for (const path of inputs) expect(selected(path), path).toBe(true);
  expect(selected("packages/waffle/browser/core.ts")).toBe(false);
  expect(selected("README.md")).toBe(false);
});

test("the write job consumes the producer ID and receipt, validates before login and never rebuilds", () => {
  const download = publicationSteps.find((step) =>
    String(step.uses).startsWith("actions/download-artifact@"),
  );
  expect(download?.with).toEqual({
    "artifact-ids": "${{ needs.qualify.outputs.artifact-id }}",
    "merge-multiple": true,
    path: "image",
  });
  expect(record(publish.env).RECEIPT_SHA256).toBe("${{ needs.qualify.outputs.receipt-sha256 }}");
  expect(record(qualify.outputs)).toEqual({
    "artifact-id": "${{ steps.image.outputs.artifact-id }}",
    "receipt-sha256": "${{ steps.qualify.outputs.receipt-sha256 }}",
  });
  const load = publicationSteps.findIndex((step) =>
    String(step.run).includes("relay-image-custody.ts load image"),
  );
  const login = publicationSteps.findIndex((step) =>
    String(step.uses).startsWith("docker/login-action@"),
  );
  expect(load).toBeGreaterThan(-1);
  expect(load).toBeLessThan(login);
  const commands = publicationSteps.map((step) => String(step.run ?? "")).join("\n");
  expect(commands).not.toMatch(/docker (?:build|run)\b/);
  expect(commands).not.toContain("latest");
  expect(text).not.toContain("workflow_run:");
  expect(text).not.toContain("run-id:");
  expect(commands).toContain('"$IMAGE:$IMAGE_VARIANT-$GITHUB_SHA"');
  expect(commands).toContain(
    'DOCKER_CONFIG="$RUNNER_TEMP/anonymous" docker pull --platform linux/amd64 "$reference"',
  );
  expect(commands).toContain("relay-image-custody.ts published image");
});
