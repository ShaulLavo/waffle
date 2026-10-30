import { flattenFields, prepareFields } from "./api-fields.ts";
import { resolveToken } from "./auth.ts";
import { GhError, HttpError } from "./errors.ts";
import { object, parseJson, stableJson } from "./json.ts";
import { readRequired } from "./filesystem.ts";
import { evaluate, writeText } from "./output.ts";
import type { Command } from "./parse.ts";
import { PlaceholderResolver } from "./repository.ts";
import { GitHubClient, nextLink, setQuery } from "./transport.ts";
import type { ApiRequest, HttpResponse, Invocation, JsonObject, JsonValue } from "./types.ts";

type ApiCommand = Extract<Command, { kind: "api" }>;
interface Page {
  readonly value: JsonValue;
  readonly response: HttpResponse;
}

export async function api(invocation: Invocation, command: ApiCommand): Promise<void> {
  const placeholders = new PlaceholderResolver(invocation);
  const endpoint = await placeholders.expand(command.endpoint);
  const fields = await prepareFields(
    invocation,
    command.rawFields,
    command.typedFields,
    placeholders,
  );
  const input =
    command.input === undefined ? undefined : await readRequired(invocation, command.input);
  const headers = requestHeaders(command.headers, command.previews);
  const client = new GitHubClient(invocation.transport, await resolveToken(invocation));
  const prepared = prepareRequest(command, endpoint, fields.values, fields.count, input, headers);
  if (command.paginate && endpoint.replace(/^\//, "") === "graphql") validateGraphQL(prepared.body);
  const pages: Page[] = [];
  let request: ApiRequest | undefined = prepared;
  while (request) {
    const response = await send(invocation, client, request);
    const value = response.body.length ? parseJson(response.body) : undefined;
    if (value !== undefined && command.jq) await evaluate(invocation, command.jq, value);
    else if (value !== undefined) pages.push({ value, response });
    request = command.paginate ? nextRequest(endpoint, request, response, value) : undefined;
  }
  if (!command.silent && !command.jq) await writePages(invocation, command, pages);
}

function prepareRequest(
  command: ApiCommand,
  endpoint: string,
  fields: JsonObject,
  fieldCount: number,
  input: Uint8Array | undefined,
  headers: Readonly<Record<string, string>>,
): ApiRequest {
  const graphql = endpoint.replace(/^\//, "") === "graphql";
  const method = (
    command.method ?? (graphql || fieldCount || input ? "POST" : "GET")
  ).toUpperCase();
  const getFields = method === "GET" || input !== undefined;
  const body =
    input ?? (getFields || !fieldCount ? undefined : graphql ? graphqlBody(fields) : fields);
  const query = getFields ? flattenFields(fields) : [];
  const path = command.paginate && !graphql ? setQuery(endpoint, "per_page", "100") : endpoint;
  return { method, path, query, headers, body };
}

function graphqlBody(fields: JsonObject): JsonObject {
  const variables: JsonObject = {};
  const body: JsonObject = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === "query" || key === "operationName") body[key] = value;
    else variables[key] = value;
  }
  body.variables = variables;
  return body;
}

async function send(invocation: Invocation, client: GitHubClient, request: ApiRequest) {
  try {
    return await client.send(request);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    if (error.response.body.length) await invocation.stdout(error.response.body);
    throw error;
  }
}

function nextRequest(
  endpoint: string,
  request: ApiRequest,
  response: HttpResponse,
  value: JsonValue | undefined,
): ApiRequest | undefined {
  if (endpoint.replace(/^\//, "") !== "graphql") {
    const next = nextLink(response);
    return next ? { ...request, path: next, query: [] } : undefined;
  }
  const pageInfo = value === undefined ? undefined : findPageInfo(value);
  if (!pageInfo) throw new GhError("gh: GraphQL pagination response has no pageInfo");
  if (!pageInfo.hasNextPage) return undefined;
  const requestBody = request.body instanceof Uint8Array ? null : (request.body ?? null);
  const body = object(requestBody, "GraphQL request body");
  const variables = object(body.variables ?? {}, "GraphQL variables");
  return {
    ...request,
    body: { ...body, variables: { ...variables, endCursor: pageInfo.endCursor } },
  };
}

function validateGraphQL(body: ApiRequest["body"]): void {
  const requestBody = body instanceof Uint8Array ? null : (body ?? null);
  const root = object(requestBody, "GraphQL request body");
  if (
    typeof root.query !== "string" ||
    !/\$endCursor\b/.test(root.query) ||
    !/pageInfo\s*\{/.test(root.query)
  )
    throw new GhError(
      "gh: GraphQL pagination requires $endCursor and pageInfo { hasNextPage, endCursor }",
    );
}

function findPageInfo(
  value: JsonValue,
): { hasNextPage: boolean; endCursor: string | null } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (value.pageInfo && typeof value.pageInfo === "object" && !Array.isArray(value.pageInfo)) {
    const page = value.pageInfo;
    if (
      typeof page.hasNextPage === "boolean" &&
      (typeof page.endCursor === "string" || page.endCursor === null)
    )
      return { hasNextPage: page.hasNextPage, endCursor: page.endCursor };
  }
  for (const child of Object.values(value)) {
    const found = findPageInfo(child);
    if (found) return found;
  }
  return undefined;
}

async function writePages(
  invocation: Invocation,
  command: ApiCommand,
  pages: readonly Page[],
): Promise<void> {
  if (command.slurp) {
    await writeText(invocation, "stdout", `${stableJson(pages.map((page) => page.value))}\n`);
    return;
  }
  if (command.paginate && pages.every((page) => Array.isArray(page.value))) {
    const merged = pages.flatMap((page) => (Array.isArray(page.value) ? page.value : []));
    await writeText(invocation, "stdout", `${stableJson(merged)}\n`);
    return;
  }
  for (const page of pages) {
    if (command.include) await writeHeaders(invocation, page.response);
    if (command.paginate) await writeText(invocation, "stdout", `${stableJson(page.value)}\n`);
    else await invocation.stdout(page.response.body);
  }
}

async function writeHeaders(invocation: Invocation, response: HttpResponse): Promise<void> {
  const headers = Object.entries(response.headers)
    .map(([name, value]) => `${name}: ${value}\n`)
    .join("");
  await writeText(invocation, "stdout", `HTTP/1.1 ${response.status}\n${headers}\n`);
}

function requestHeaders(
  headers: readonly string[],
  previews: readonly string[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const header of headers) {
    const colon = header.indexOf(":");
    if (colon <= 0) throw new GhError(`invalid header: ${header}`);
    result[header.slice(0, colon).trim()] = header.slice(colon + 1).trimStart();
  }
  if (previews.length) {
    const names = previews.flatMap((preview) => preview.split(","));
    result.Accept = names.map((name) => `application/vnd.github.${name}-preview+json`).join(", ");
  }
  return result;
}
