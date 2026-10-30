import { api } from "./api.ts";
import { loginWithToken } from "./auth.ts";
import { errorMessage, GhError } from "./errors.ts";
import { issueCreate, issueList, issueView } from "./issue.ts";
import { writeText } from "./output.ts";
import { parseCommand, type Command } from "./parse.ts";
import { prCreate, prList, prView } from "./pr.ts";
import { repoView } from "./repo.ts";
import { runList, runView } from "./run.ts";
import type { Invocation } from "./types.ts";

const HELP = `Work seamlessly with GitHub from the command line.

USAGE
  gh <command> <subcommand> [flags]

SUPPORTED COMMANDS
  auth login --with-token
  pr list|view|create
  issue list|view|create
  run list|view
  repo view
  api

This optional Waffle package implements the common noninteractive gh subset.
`;

export async function runGh(invocation: Invocation): Promise<number> {
  try {
    validateHost(invocation);
    return await dispatch(invocation, parseCommand(invocation.argv));
  } catch (error) {
    const exit = error instanceof GhError ? error.exit : 1;
    const message = errorMessage(error);
    await writeText(invocation, "stderr", `${redact(message, invocation)}\n`);
    return exit;
  }
}

async function dispatch(invocation: Invocation, command: Command): Promise<number> {
  switch (command.kind) {
    case "help":
      await writeText(invocation, "stdout", HELP);
      return 0;
    case "version":
      await writeText(
        invocation,
        "stdout",
        "gh version 2.103.0 (2026-10-21)\nhttps://github.com/cli/cli/releases/tag/v2.103.0\n",
      );
      return 0;
    case "auth-login":
      await loginWithToken(invocation, command.hostname);
      return 0;
    case "pr-list":
      await prList(invocation, command);
      return 0;
    case "pr-view":
      await prView(invocation, command);
      return 0;
    case "pr-create":
      await prCreate(invocation, command);
      return 0;
    case "issue-list":
      await issueList(invocation, command);
      return 0;
    case "issue-view":
      await issueView(invocation, command);
      return 0;
    case "issue-create":
      await issueCreate(invocation, command);
      return 0;
    case "run-list":
      await runList(invocation, command);
      return 0;
    case "run-view":
      return runView(invocation, command);
    case "repo-view":
      await repoView(invocation, command);
      return 0;
    case "api":
      await api(invocation, command);
      return 0;
  }
}

function validateHost(invocation: Invocation): void {
  const host = invocation.env.GH_HOST;
  if (host && host !== "github.com") throw new GhError("only github.com is supported");
}

function redact(message: string, invocation: Invocation): string {
  let result = message;
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    const token = invocation.env[name];
    if (token) result = result.replaceAll(token, "[REDACTED]");
  }
  return result;
}
