import { resolveToken } from "./auth.ts";
import { GhError } from "./errors.ts";
import { decode, object, parseJson } from "./json.ts";
import { readRequired } from "./filesystem.ts";
import { nextLink, GitHubClient } from "./transport.ts";
import { resolveRepository, type GitContext } from "./repository.ts";
import type { Invocation, JsonObject, JsonValue, QueryEntry, Repository } from "./types.ts";

export interface CommandContext {
  readonly invocation: Invocation;
  readonly client: GitHubClient;
  readonly git: GitContext;
}

export async function commandContext(
  invocation: Invocation,
  repository?: Repository,
): Promise<CommandContext> {
  const git = await resolveRepository(invocation, repository);
  const token = await resolveToken(invocation);
  return { invocation, git, client: new GitHubClient(invocation.transport, token) };
}

export function repositoryPath(repository: Repository, suffix = ""): string {
  return `/repos/${repository.owner}/${repository.name}${suffix}`;
}

export function query(
  entries: Readonly<Record<string, string | number | boolean | undefined>>,
): QueryEntry[] {
  return Object.entries(entries).flatMap(([name, value]) =>
    value === undefined ? [] : [[name, String(value)] as const],
  );
}

export async function bodyText(
  invocation: Invocation,
  body: string | undefined,
  bodyFile: string | undefined,
): Promise<string> {
  if (bodyFile !== undefined) return decode(await readRequired(invocation, bodyFile));
  return body ?? "";
}

export async function paginatedObjects(
  client: GitHubClient,
  path: string,
  parameters: readonly QueryEntry[],
  limit: number,
  accept: (value: JsonObject) => boolean = () => true,
): Promise<JsonObject[]> {
  const result: JsonObject[] = [];
  const visited = new Set<string>();
  let next: string | undefined = path;
  let parametersForRequest = parameters;
  while (next && result.length < limit) {
    if (visited.has(next)) throw new GhError("gh: API pagination loop detected");
    visited.add(next);
    const response = await client.send({ method: "GET", path: next, query: parametersForRequest });
    const page = parseJson(response.body);
    if (!Array.isArray(page)) throw new GhError("gh: invalid list response: expected an array");
    collectAccepted(result, page, limit, accept);
    next = nextLink(response);
    parametersForRequest = [];
  }
  return result;
}

export async function collectionPage(
  client: GitHubClient,
  path: string,
  key: string,
  parameters: readonly QueryEntry[] = [],
): Promise<{ values: JsonObject[]; next?: string }> {
  const response = await client.send({ method: "GET", path, query: parameters });
  const root = object(parseJson(response.body), "collection response");
  const page = root[key];
  if (!Array.isArray(page)) throw new GhError(`gh: invalid collection response: ${key}`);
  return { values: page.map((entry) => object(entry, `${key} entry`)), next: nextLink(response) };
}

export async function wholeCollection(
  client: GitHubClient,
  path: string,
  key: string,
  parameters: readonly QueryEntry[] = [],
): Promise<JsonObject[]> {
  const result: JsonObject[] = [];
  let next: string | undefined = path;
  let currentParameters = parameters;
  while (next) {
    const page = await collectionPage(client, next, key, currentParameters);
    result.push(...page.values);
    next = page.next;
    currentParameters = [];
  }
  return result;
}

function collectAccepted(
  result: JsonObject[],
  page: JsonValue[],
  limit: number,
  accept: (value: JsonObject) => boolean,
): void {
  for (const entry of page) {
    if (result.length >= limit) return;
    const value = object(entry, "list entry");
    if (accept(value)) result.push(value);
  }
}
