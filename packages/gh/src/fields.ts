import { GhError } from "./errors.ts";
import type { JsonObject, JsonValue } from "./types.ts";

export type ResourceKind = "pr" | "issue" | "run" | "repo";
export interface FieldContext {
  readonly state?: string;
  readonly workflowName?: string;
}

type Reader = (record: JsonObject, context: FieldContext) => JsonValue;

const pr: Record<string, Reader> = {
  number: (r) => numberAt(r, ["number"]),
  title: (r) => textAt(r, ["title"]),
  state: (r) => pullState(r),
  body: (r) => textAt(r, ["body"]),
  url: (r) => textAt(r, ["html_url"]),
  author: (r) => login(r, ["user", "login"]),
  headRefName: (r) => textAt(r, ["head", "ref"]),
  headRefOid: (r) => textAt(r, ["head", "sha"]),
  baseRefName: (r) => textAt(r, ["base", "ref"]),
  baseRefOid: (r) => textAt(r, ["base", "sha"]),
  isDraft: (r) => booleanAt(r, ["draft"]) ?? false,
  createdAt: (r) => textAt(r, ["created_at"]),
  updatedAt: (r) => textAt(r, ["updated_at"]),
  closedAt: (r) => textAt(r, ["closed_at"]),
  mergedAt: (r) => textAt(r, ["merged_at"]),
  additions: (r) => numberAt(r, ["additions"]),
  deletions: (r) => numberAt(r, ["deletions"]),
  changedFiles: (r) => numberAt(r, ["changed_files"]),
  mergeCommit: (r) => mergeCommit(r),
};

const issue: Record<string, Reader> = {
  number: (r) => numberAt(r, ["number"]),
  title: (r) => textAt(r, ["title"]),
  state: (r, c) => c.state ?? upper(textAt(r, ["state"])),
  stateReason: (r) => upper(textAt(r, ["state_reason"])),
  body: (r) => textAt(r, ["body"]),
  url: (r) => textAt(r, ["html_url"]),
  author: (r) => login(r, ["user", "login"]),
  labels: (r) => labels(r),
  assignees: (r) => logins(r, "assignees"),
  createdAt: (r) => textAt(r, ["created_at"]),
  updatedAt: (r) => textAt(r, ["updated_at"]),
  closedAt: (r) => textAt(r, ["closed_at"]),
};

const run: Record<string, Reader> = {
  databaseId: (r) => numberAt(r, ["id"]),
  name: (r) => textAt(r, ["name"]),
  displayTitle: (r) => textAt(r, ["display_title"]),
  number: (r) => numberAt(r, ["run_number"]),
  attempt: (r) => numberAt(r, ["run_attempt"]),
  event: (r) => textAt(r, ["event"]),
  status: (r) => textAt(r, ["status"]),
  conclusion: (r) => textAt(r, ["conclusion"]) ?? "",
  headBranch: (r) => textAt(r, ["head_branch"]),
  headSha: (r) => textAt(r, ["head_sha"]),
  workflowDatabaseId: (r) => numberAt(r, ["workflow_id"]),
  workflowName: (_r, c) => c.workflowName ?? null,
  createdAt: (r) => textAt(r, ["created_at"]),
  startedAt: (r) => textAt(r, ["run_started_at"]),
  updatedAt: (r) => textAt(r, ["updated_at"]),
  url: (r) => textAt(r, ["html_url"]),
  jobs: (r) => jobs(r),
};

const repo: Record<string, Reader> = {
  name: (r) => textAt(r, ["name"]),
  nameWithOwner: (r) => textAt(r, ["full_name"]),
  owner: (r) => login(r, ["owner", "login"]),
  description: (r) => textAt(r, ["description"]),
  url: (r) => textAt(r, ["html_url"]),
  defaultBranchRef: (r) => ({ name: textAt(r, ["default_branch"]) }),
  isPrivate: (r) => booleanAt(r, ["private"]),
  isFork: (r) => booleanAt(r, ["fork"]),
  isArchived: (r) => booleanAt(r, ["archived"]),
  visibility: (r) => visibility(r),
  stargazerCount: (r) => numberAt(r, ["stargazers_count"]),
  forkCount: (r) => numberAt(r, ["forks_count"]),
  createdAt: (r) => textAt(r, ["created_at"]),
  updatedAt: (r) => textAt(r, ["updated_at"]),
  pushedAt: (r) => textAt(r, ["pushed_at"]),
};

const registries = { pr, issue, run, repo } satisfies Record<ResourceKind, Record<string, Reader>>;

export function validateFields(kind: ResourceKind, fields: readonly string[]): void {
  for (const field of fields) {
    if (!registries[kind][field]) throw new GhError(`Unknown JSON field: "${field}"`);
  }
}

export function project(
  kind: ResourceKind,
  record: JsonObject,
  selected: readonly string[],
  context: FieldContext = {},
): JsonObject {
  const result: JsonObject = {};
  for (const field of selected.toSorted()) result[field] = registries[kind][field](record, context);
  return result;
}

function pullState(record: JsonObject): string | null {
  if (record.merged_at) return "MERGED";
  return upper(textAt(record, ["state"]));
}

function mergeCommit(record: JsonObject): JsonValue {
  const oid = textAt(record, ["merge_commit_sha"]);
  return oid ? { oid } : null;
}

function visibility(record: JsonObject): JsonValue {
  const value = textAt(record, ["visibility"]);
  if (value) return value.toUpperCase();
  return booleanAt(record, ["private"]) ? "PRIVATE" : "PUBLIC";
}

function labels(record: JsonObject): JsonValue[] {
  return objectArray(record.labels, "labels").map((label) => ({
    name: textAt(label, ["name"]),
    color: textAt(label, ["color"]),
    description: textAt(label, ["description"]),
  }));
}

function logins(record: JsonObject, key: string): JsonValue[] {
  return objectArray(record[key], key).map((entry) => ({ login: textAt(entry, ["login"]) }));
}

function jobs(record: JsonObject): JsonValue[] {
  return objectArray(record.jobs, "jobs").map((job) => ({
    databaseId: numberAt(job, ["id"]),
    name: textAt(job, ["name"]),
    status: textAt(job, ["status"]),
    conclusion: textAt(job, ["conclusion"]) ?? "",
    startedAt: textAt(job, ["started_at"]),
    completedAt: textAt(job, ["completed_at"]),
    url: textAt(job, ["html_url"]),
    steps: objectArray(job.steps, "steps").map((step) => ({
      number: numberAt(step, ["number"]),
      name: textAt(step, ["name"]),
      status: textAt(step, ["status"]),
      conclusion: textAt(step, ["conclusion"]) ?? "",
      startedAt: textAt(step, ["started_at"]),
      completedAt: textAt(step, ["completed_at"]),
    })),
  }));
}

function objectArray(value: JsonValue | undefined, context: string): JsonObject[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new GhError(`gh: invalid ${context}: expected an array`);
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new GhError(`gh: invalid ${context} entry: expected an object`);
    return entry;
  });
}

function login(record: JsonObject, path: readonly string[]): JsonObject {
  return { login: textAt(record, path) };
}

function at(record: JsonObject, path: readonly string[]): JsonValue | undefined {
  let value: JsonValue | undefined = record;
  for (const key of path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = value[key];
  }
  return value;
}

function textAt(record: JsonObject, path: readonly string[]): string | null {
  const value = at(record, path);
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new GhError(`gh: invalid response field: ${path.join(".")}`);
  return value;
}

function numberAt(record: JsonObject, path: readonly string[]): number | null {
  const value = at(record, path);
  if (value === undefined || value === null) return null;
  if (typeof value !== "number") throw new GhError(`gh: invalid response field: ${path.join(".")}`);
  return value;
}

function booleanAt(record: JsonObject, path: readonly string[]): boolean | null {
  const value = at(record, path);
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean")
    throw new GhError(`gh: invalid response field: ${path.join(".")}`);
  return value;
}

function upper(value: string | null): string | null {
  return value?.toUpperCase() ?? null;
}
