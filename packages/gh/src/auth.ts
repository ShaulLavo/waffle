import { GhError } from "./errors.ts";
import { resolvePath } from "./filesystem.ts";
import { decode, object } from "./json.ts";
import { GitHubClient, responseHeader } from "./transport.ts";
import type { Invocation } from "./types.ts";

const MISSING_AUTH =
  "To get started with GitHub CLI, please run:  gh auth login\n" +
  "Alternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.\n";

export function environmentToken(invocation: Invocation): { name: string; value: string } | undefined {
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    const value = invocation.env[name];
    if (value) return { name, value };
  }
  return undefined;
}

export async function resolveToken(invocation: Invocation): Promise<string> {
  const environment = environmentToken(invocation);
  if (environment) return environment.value;
  const config = await invocation.filesystem.readFile(hostsPath(invocation));
  const stored = config ? parseHosts(decode(config)).oauth_token : undefined;
  if (stored) return stored;
  throw new GhError(MISSING_AUTH.trimEnd(), 4);
}

export async function loginWithToken(invocation: Invocation, hostname?: string): Promise<void> {
  if (hostname && hostname !== "github.com") throw new GhError("only github.com is supported");
  const environment = environmentToken(invocation);
  if (environment) {
    throw new GhError(
      `The value of the ${environment.name} environment variable is being used for authentication.\n` +
        "To have GitHub CLI store credentials instead, first clear the value from the environment.",
    );
  }
  const token = decode(await invocation.stdin()).trim();
  if (!token || /[\r\n]/.test(token)) throw new GhError("a single authentication token is required");
  const client = new GitHubClient(invocation.transport, token);
  const root = await client.send({ method: "GET", path: "/" });
  validateScopes(responseHeader(root, "x-oauth-scopes"));
  const result = object(
    await client.json({
      method: "POST",
      path: "/graphql",
      body: { query: "query UserCurrent{viewer{login}}" },
    }),
    "GraphQL response",
  );
  const data = object(result.data ?? null, "GraphQL data");
  const viewer = object(data.viewer ?? null, "GraphQL viewer");
  if (typeof viewer.login !== "string" || !viewer.login) throw new GhError("token validation failed");
  const path = hostsPath(invocation);
  const yaml = `github.com:\n    oauth_token: ${JSON.stringify(token)}\n    user: ${JSON.stringify(viewer.login)}\n`;
  await invocation.filesystem.mkdir(parentDirectory(path));
  await invocation.filesystem.writeFile(path, new TextEncoder().encode(yaml), 0o600);
}

function hostsPath(invocation: Invocation): string {
  const configured = invocation.env.GH_CONFIG_DIR;
  if (configured) return `${resolvePath(invocation.cwd, configured)}/hosts.yml`;
  if (invocation.env.XDG_CONFIG_HOME)
    return `${resolvePath(invocation.cwd, invocation.env.XDG_CONFIG_HOME)}/gh/hosts.yml`;
  const home = invocation.env.HOME ?? "/";
  return `${resolvePath(invocation.cwd, home)}/.config/gh/hosts.yml`;
}

function parseHosts(source: string): { oauth_token?: string; user?: string } {
  const result: { oauth_token?: string; user?: string } = {};
  let github = false;
  for (const line of source.split(/\r?\n/)) {
    if (/^github\.com:\s*$/.test(line)) {
      github = true;
      continue;
    }
    if (/^\S/.test(line)) github = false;
    if (!github) continue;
    const match = /^\s+(oauth_token|user):\s*(.*?)\s*$/.exec(line);
    if (match?.[1] === "oauth_token") result.oauth_token = scalar(match[2]);
    if (match?.[1] === "user") result.user = scalar(match[2]);
  }
  return result;
}

function scalar(value: string): string {
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string" ? parsed : "";
    } catch {
      return "";
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value.replace(/\s+#.*$/, "");
}

function validateScopes(header: string | undefined): void {
  if (!header?.trim()) return;
  const scopes = new Set(header.split(",").map((scope) => scope.trim()));
  const missing = ["repo", "read:org", "gist"].filter((scope) => !scopes.has(scope));
  if (missing.length) throw new GhError(`token is missing required scopes: ${missing.join(", ")}`);
}

function parentDirectory(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}
