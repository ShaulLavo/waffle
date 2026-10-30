import { GhError } from "./errors.ts";
import { project } from "./fields.ts";
import { bodyText, commandContext, paginatedObjects, query, repositoryPath, type CommandContext } from "./handler-utils.ts";
import { object } from "./json.ts";
import { emitJson, writeText } from "./output.ts";
import type { Command } from "./parse.ts";
import { discoverGit } from "./repository.ts";
import type { Invocation, JsonObject, Repository } from "./types.ts";

type PrList = Extract<Command, { kind: "pr-list" }>;
type PrView = Extract<Command, { kind: "pr-view" }>;
type PrCreate = Extract<Command, { kind: "pr-create" }>;

export async function prList(invocation: Invocation, command: PrList): Promise<void> {
  const format = command.output;
  const context = await commandContext(invocation, command.repo);
  const repository = context.git.repository;
  const head = command.head ? `${repository.owner}:${command.head}` : undefined;
  const records = await paginatedObjects(
    context.client,
    repositoryPath(repository, "/pulls"),
    query({
      state: command.state === "merged" ? "closed" : command.state,
      head,
      base: command.base,
      per_page: Math.min(command.limit, 100),
    }),
    command.limit,
    (record) => command.state !== "merged" || record.merged_at != null,
  );
  const detailed = format.kind === "json"
    ? await withDetails(context, records, format.fields)
    : records;
  if (format.kind === "json") {
    await emitJson(invocation, detailed.map((record) => project("pr", record, format.fields)), format);
    return;
  }
  await writeText(invocation, "stdout", detailed.map(plainListRow).join(""));
}

export async function prView(invocation: Invocation, command: PrView): Promise<void> {
  const format = command.output;
  const selector = await prSelector(invocation, command);
  const context = await commandContext(invocation, selector.repository);
  const record = selector.number
    ? object(await context.client.json({ method: "GET", path: repositoryPath(context.git.repository, `/pulls/${selector.number}`) }), "pull request")
    : await findBranchPr(context, selector.branch ?? "");
  if (format.kind === "json") {
    await emitJson(invocation, project("pr", record, format.fields), format);
    return;
  }
  const title = record.title ?? "";
  const body = record.body ?? "";
  await writeText(invocation, "stdout", `${title}\n${body}\n`);
}

export async function prCreate(invocation: Invocation, command: PrCreate): Promise<void> {
  const context = await commandContext(invocation, command.repo);
  const local = command.head && command.base ? undefined : await discoverGit(invocation).catch(() => undefined);
  const head = command.head ?? context.git.branch ?? local?.branch;
  if (!head) throw new GhError("could not determine head branch; use --head");
  const base = command.base ?? context.git.mergeBase ?? local?.mergeBase ?? await defaultBranch(context);
  const body = await bodyText(invocation, command.body, command.bodyFile);
  const created = object(await context.client.json({
    method: "POST",
    path: repositoryPath(context.git.repository, "/pulls"),
    body: {
      title: command.title,
      body,
      draft: command.draft,
      base,
      head,
      maintainer_can_modify: command.maintainerCanModify,
    },
  }), "created pull request");
  const url = project("pr", created, ["url"]).url;
  if (typeof url !== "string") throw new GhError("gh: created pull request has no URL");
  await writeText(invocation, "stdout", `${url}\n`);
}

async function prSelector(invocation: Invocation, command: PrView) {
  if (!command.selector) {
    const local = await discoverGit(invocation);
    if (!local.branch) throw new GhError("cannot view a pull request from a detached HEAD");
    return { repository: command.repo ?? local.repository, branch: local.branch };
  }
  if (/^\d+$/.test(command.selector)) return { repository: command.repo, number: command.selector };
  const url = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(command.selector);
  if (url) return { repository: { owner: url[1], name: url[2] }, number: url[3] };
  return { repository: command.repo, branch: command.selector };
}

async function findBranchPr(context: CommandContext, branch: string): Promise<JsonObject> {
  if (!branch) throw new GhError("could not determine pull request branch");
  const repository = context.git.repository;
  const records = await paginatedObjects(
    context.client,
    repositoryPath(repository, "/pulls"),
    query({ state: "open", head: `${repository.owner}:${branch}`, per_page: 1 }),
    1,
  );
  if (!records[0]) throw new GhError(`no pull request found for branch ${branch}`);
  return records[0];
}

async function defaultBranch(context: CommandContext): Promise<string> {
  const repository = object(await context.client.json({
    method: "GET",
    path: repositoryPath(context.git.repository),
  }), "repository");
  const branch = project("repo", repository, ["defaultBranchRef"]).defaultBranchRef;
  if (!branch || typeof branch !== "object" || Array.isArray(branch) || typeof branch.name !== "string")
    throw new GhError("could not determine base branch; use --base");
  return branch.name;
}

async function withDetails(context: CommandContext, records: JsonObject[], fields: readonly string[]) {
  const needed = ["additions", "deletions", "changedFiles", "mergeCommit"];
  if (!fields.some((field) => needed.includes(field))) return records;
  const result: JsonObject[] = [];
  for (const record of records) {
    const number = record.number;
    if (typeof number !== "number") throw new GhError("gh: pull request has no number");
    const detail = object(await context.client.json({
      method: "GET",
      path: repositoryPath(context.git.repository, `/pulls/${number}`),
    }), "pull request");
    result.push({ ...record, ...detail });
  }
  return result;
}

function plainListRow(record: JsonObject): string {
  return `#${String(record.number ?? "")}\t${String(record.title ?? "")}\n`;
}
