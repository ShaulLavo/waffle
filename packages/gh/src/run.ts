import { GhError } from "./errors.ts";
import { project } from "./fields.ts";
import { collectionPage, commandContext, query, repositoryPath, wholeCollection } from "./handler-utils.ts";
import { object } from "./json.ts";
import { emitJson, writeText } from "./output.ts";
import type { Command } from "./parse.ts";
import type { GitHubClient } from "./transport.ts";
import type { Invocation, JsonObject, QueryEntry, Repository } from "./types.ts";

type RunList = Extract<Command, { kind: "run-list" }>;
type RunView = Extract<Command, { kind: "run-view" }>;

export async function runList(invocation: Invocation, command: RunList): Promise<void> {
  const format = command.output;
  const context = await commandContext(invocation, command.repo);
  const repository = context.git.repository;
  const records = await runPages(context.client, repository, query({
    branch: command.branch,
    status: command.status,
    head_sha: command.commit,
    event: command.event,
    exclude_pull_requests: true,
    per_page: Math.min(command.limit, 100),
  }), command.limit);
  const workflows = records.length ? await workflowNames(context.client, repository) : new Map<number, string>();
  if (format.kind === "json") {
    await emitJson(invocation, records.map((record) => projectRun(record, workflows, format.fields)), format);
    return;
  }
  await writeText(invocation, "stdout", records.map((record) => `${String(record.status ?? "")}\t${String(record.display_title ?? record.name ?? "")}\t${String(record.id ?? "")}\n`).join(""));
}

export async function runView(invocation: Invocation, command: RunView): Promise<number> {
  const format = command.output;
  const context = await commandContext(invocation, command.repo);
  const repository = context.git.repository;
  const suffix = command.attempt
    ? `/actions/runs/${command.id}/attempts/${command.attempt}`
    : `/actions/runs/${command.id}`;
  const original = object(await context.client.json({
    method: "GET",
    path: repositoryPath(repository, suffix),
    query: query({ exclude_pull_requests: true }),
  }), "workflow run");
  const workflows = await workflowForRun(context.client, repository, original);
  let record = original;
  if (format.kind === "plain" || format.fields.includes("jobs")) {
    const jobsPath = command.attempt
      ? `/actions/runs/${command.id}/attempts/${command.attempt}/jobs`
      : `/actions/runs/${command.id}/jobs`;
    const jobs = await wholeCollection(context.client, repositoryPath(repository, jobsPath), "jobs", query({ per_page: 100 }));
    record = { ...record, jobs };
  }
  if (format.kind === "json") {
    await emitJson(invocation, projectRun(record, workflows, format.fields), format);
    return 0;
  }
  const conclusion = String(record.conclusion ?? "");
  const jobs = Array.isArray(record.jobs) ? record.jobs.length : 0;
  await writeText(invocation, "stdout", `Run ${command.id}\nStatus: ${String(record.status ?? "")}\nConclusion: ${conclusion}\nJobs: ${jobs}\n`);
  return command.exitStatus && failedConclusion(conclusion) ? 1 : 0;
}

async function runPages(client: GitHubClient, repository: Repository, parameters: readonly QueryEntry[], limit: number) {
  const result: JsonObject[] = [];
  let next: string | undefined = repositoryPath(repository, "/actions/runs");
  let current = parameters;
  while (next && result.length < limit) {
    const page = await collectionPage(client, next, "workflow_runs", current);
    result.push(...page.values.slice(0, limit - result.length));
    next = page.next;
    current = [];
  }
  return result;
}

async function workflowNames(client: GitHubClient, repository: Repository) {
  const workflows = await wholeCollection(
    client,
    repositoryPath(repository, "/actions/workflows"),
    "workflows",
    query({ page: 1, per_page: 100 }),
  );
  const result = new Map<number, string>();
  for (const workflow of workflows) addWorkflow(result, workflow);
  return result;
}

async function workflowForRun(client: GitHubClient, repository: Repository, run: JsonObject) {
  const result = new Map<number, string>();
  if (typeof run.workflow_id !== "number") return result;
  const workflow = object(await client.json({
    method: "GET",
    path: repositoryPath(repository, `/actions/workflows/${run.workflow_id}`),
  }), "workflow");
  addWorkflow(result, workflow);
  return result;
}

function addWorkflow(result: Map<number, string>, workflow: JsonObject): void {
  if (typeof workflow.id !== "number" || typeof workflow.name !== "string")
    throw new GhError("gh: invalid workflow response");
  result.set(workflow.id, workflow.name);
}

function projectRun(record: JsonObject, workflows: ReadonlyMap<number, string>, fields: readonly string[]) {
  const workflowName = typeof record.workflow_id === "number" ? workflows.get(record.workflow_id) : undefined;
  return project("run", record, fields, { workflowName });
}

function failedConclusion(conclusion: string): boolean {
  return ["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"].includes(conclusion);
}
