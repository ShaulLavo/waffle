import { GhError } from "./errors.ts";
import { project } from "./fields.ts";
import { bodyText, commandContext, paginatedObjects, query, repositoryPath } from "./handler-utils.ts";
import { object } from "./json.ts";
import { emitJson, writeText } from "./output.ts";
import type { Command } from "./parse.ts";
import type { Invocation, Repository } from "./types.ts";

type IssueList = Extract<Command, { kind: "issue-list" }>;
type IssueView = Extract<Command, { kind: "issue-view" }>;
type IssueCreate = Extract<Command, { kind: "issue-create" }>;

export async function issueList(invocation: Invocation, command: IssueList): Promise<void> {
  const format = command.output;
  const context = await commandContext(invocation, command.repo);
  const records = await paginatedObjects(
    context.client,
    repositoryPath(context.git.repository, "/issues"),
    query({ state: command.state, per_page: Math.min(command.limit, 100) }),
    command.limit,
    (record) => !("pull_request" in record),
  );
  if (format.kind === "json") {
    await emitJson(invocation, records.map((record) => project("issue", record, format.fields)), format);
    return;
  }
  await writeText(invocation, "stdout", records.map((record) => `#${String(record.number ?? "")}\t${String(record.title ?? "")}\n`).join(""));
}

export async function issueView(invocation: Invocation, command: IssueView): Promise<void> {
  const format = command.output;
  const selected = issueSelector(command.selector, command.repo);
  const context = await commandContext(invocation, selected.repository);
  const record = object(await context.client.json({
    method: "GET",
    path: repositoryPath(context.git.repository, `/issues/${selected.number}`),
  }), "issue");
  let state: string | undefined;
  if ("pull_request" in record) {
    const pull = object(await context.client.json({
      method: "GET",
      path: repositoryPath(context.git.repository, `/pulls/${selected.number}`),
    }), "pull request");
    const value = project("pr", pull, ["state"]).state;
    if (typeof value === "string") state = value;
  }
  if (format.kind === "json") {
    await emitJson(invocation, project("issue", record, format.fields, { state }), format);
    return;
  }
  await writeText(invocation, "stdout", `${String(record.title ?? "")}\n${String(record.body ?? "")}\n`);
}

export async function issueCreate(invocation: Invocation, command: IssueCreate): Promise<void> {
  const context = await commandContext(invocation, command.repo);
  const created = object(await context.client.json({
    method: "POST",
    path: repositoryPath(context.git.repository, "/issues"),
    body: {
      title: command.title,
      body: await bodyText(invocation, command.body, command.bodyFile),
    },
  }), "created issue");
  const url = project("issue", created, ["url"]).url;
  if (typeof url !== "string") throw new GhError("gh: created issue has no URL");
  await writeText(invocation, "stdout", `${url}\n`);
}

function issueSelector(selector: string, repository?: Repository): { repository?: Repository; number: string } {
  if (/^\d+$/.test(selector)) return { repository, number: selector };
  const url = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)\/?$/.exec(selector);
  if (url) return { repository: { owner: url[1], name: url[2] }, number: url[3] };
  throw new GhError("issue must be selected by number or GitHub URL");
}
