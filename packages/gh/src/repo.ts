import { HttpError } from "./errors.ts";
import { project } from "./fields.ts";
import { commandContext, query, repositoryPath } from "./handler-utils.ts";
import { object, parseJson } from "./json.ts";
import { emitJson, writeText } from "./output.ts";
import type { Command } from "./parse.ts";
import type { Invocation, JsonObject } from "./types.ts";

type RepoView = Extract<Command, { kind: "repo-view" }>;

export async function repoView(invocation: Invocation, command: RepoView): Promise<void> {
  const format = command.output;
  const context = await commandContext(invocation, command.repo);
  const repository = object(await context.client.json({
    method: "GET",
    path: repositoryPath(context.git.repository),
  }), "repository");
  if (format.kind === "json") {
    await emitJson(invocation, project("repo", repository, format.fields), format);
    return;
  }
  const readme = await readmeText(context.client, repositoryPath(context.git.repository), command.branch);
  await writeText(invocation, "stdout", plainRepository(repository, readme));
}

async function readmeText(client: import("./transport.ts").GitHubClient, path: string, branch?: string) {
  try {
    const response = await client.send({
      method: "GET",
      path: `${path}/readme`,
      query: query({ ref: branch }),
    });
    const readme = object(parseJson(response.body), "README response");
    if (typeof readme.content !== "string") return "";
    return Buffer.from(readme.content.replace(/\s/g, ""), "base64").toString("utf8");
  } catch (error) {
    if (error instanceof HttpError && error.response.status === 404) return "";
    throw error;
  }
}

function plainRepository(repository: JsonObject, readme: string): string {
  const lines = [`name:\t${String(repository.full_name ?? "")}`];
  if (repository.description) lines.push(`description:\t${String(repository.description)}`);
  if (!readme) return `${lines.join("\n")}\n`;
  return `${lines.join("\n")}\n--\n${readme}${readme.endsWith("\n") ? "\n" : "\n\n"}`;
}
