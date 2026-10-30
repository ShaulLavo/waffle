import { GhError } from "./errors.ts";
import { resolvePath } from "./filesystem.ts";
import { decode } from "./json.ts";
import type { Invocation, Repository } from "./types.ts";

export interface GitContext {
  readonly repository: Repository;
  readonly source: "explicit" | "environment" | "git";
  readonly branch?: string;
  readonly mergeBase?: string;
}

export function parseRepository(input: string): Repository {
  const parts = input.replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length === 3 && parts[0] === "github.com") parts.shift();
  if (parts.length !== 2 || !parts[0] || !parts[1])
    throw new GhError(`invalid repository: ${input}`);
  return { owner: parts[0], name: parts[1] };
}

export async function resolveRepository(
  invocation: Invocation,
  explicit?: Repository,
): Promise<GitContext> {
  if (explicit) return { repository: explicit, source: "explicit" };
  if (invocation.env.GH_REPO)
    return { repository: parseRepository(invocation.env.GH_REPO), source: "environment" };
  return discoverGit(invocation);
}

export async function discoverGit(invocation: Invocation): Promise<GitContext> {
  const git = await findGitDirectory(invocation);
  if (!git) throw new GhError("no GitHub repository found; use --repo or GH_REPO");
  const configBytes = await readOptional(invocation, `${git.common}/config`);
  const config = parseConfig(configBytes ? decode(configBytes) : undefined);
  const remote = selectRemote(config.remotes);
  if (!remote) throw new GhError("no github.com remote found");
  const head = await readOptional(invocation, `${git.directory}/HEAD`);
  const branch = head ? /^ref:\s+refs\/heads\/(.+)$/m.exec(decode(head))?.[1] : undefined;
  const mergeBase = branch ? config.mergeBases.get(branch) : undefined;
  return { repository: remote, source: "git", branch, mergeBase };
}

export class PlaceholderResolver {
  private context: Promise<GitContext> | undefined;
  private readonly invocation: Invocation;
  constructor(invocation: Invocation) {
    this.invocation = invocation;
  }

  async expand(input: string): Promise<string> {
    const names = Array.from(input.matchAll(/\{(owner|repo|branch)\}/g), (match) => match[1]);
    if (!names.length) return input;
    const context = await this.contextValue();
    if (names.includes("branch") && context.source === "environment")
      throw new GhError("unable to determine an appropriate value for the 'branch' placeholder");
    if (names.includes("branch") && !context.branch)
      throw new GhError("unable to determine an appropriate value for the 'branch' placeholder");
    return input.replace(/\{(owner|repo|branch)\}/g, (_, name: string) => {
      if (name === "owner") return context.repository.owner;
      if (name === "repo") return context.repository.name;
      return context.branch ?? "";
    });
  }

  private contextValue(): Promise<GitContext> {
    this.context ??= resolveRepository(this.invocation);
    return this.context;
  }
}

interface ParsedConfig {
  readonly remotes: ReadonlyMap<string, string>;
  readonly mergeBases: ReadonlyMap<string, string>;
}

function parseConfig(source: string | undefined): ParsedConfig {
  const remotes = new Map<string, string>();
  const mergeBases = new Map<string, string>();
  let section = "";
  for (const line of (source ?? "").split(/\r?\n/)) {
    const header = /^\s*\[(remote|branch)\s+"([^"]+)"\]\s*$/.exec(line);
    if (header) {
      section = `${header[1]}:${header[2]}`;
      continue;
    }
    if (/^\s*\[/.test(line)) {
      section = "";
      continue;
    }
    const setting = /^\s*(url|gh-merge-base)\s*=\s*(.*?)\s*$/.exec(line);
    if (!setting) continue;
    if (section.startsWith("remote:") && setting[1] === "url")
      remotes.set(section.slice(7), setting[2]);
    if (section.startsWith("branch:") && setting[1] === "gh-merge-base")
      mergeBases.set(section.slice(7), setting[2]);
  }
  return { remotes, mergeBases };
}

function selectRemote(remotes: ReadonlyMap<string, string>): Repository | undefined {
  const names = remotes.has("origin") ? ["origin"].concat(Array.from(remotes.keys())) : Array.from(remotes.keys());
  for (const name of names) {
    const repository = parseRemote(remotes.get(name) ?? "");
    if (repository) return repository;
  }
  return undefined;
}

function parseRemote(remote: string): Repository | undefined {
  const https = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(remote);
  const ssh = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(remote);
  const match = https ?? ssh;
  return match ? parseRepository(match[1]) : undefined;
}

async function findGitDirectory(invocation: Invocation) {
  let directory = invocation.cwd;
  while (true) {
    const marker = `${directory}/.git`;
    if (await readOptional(invocation, `${marker}/HEAD`))
      return { directory: marker, common: marker };
    const pointer = await readOptional(invocation, marker);
    if (pointer) return worktreeDirectories(invocation, decode(pointer), directory);
    if (directory === "/") return undefined;
    directory = parentDirectory(directory);
  }
}

async function worktreeDirectories(invocation: Invocation, pointer: string, cwd: string) {
  const match = /^gitdir:\s*(.+)\s*$/m.exec(pointer);
  if (!match) return undefined;
  const directory = resolvePath(cwd, match[1]);
  const commonFile = await readOptional(invocation, `${directory}/commondir`);
  const common = commonFile ? resolvePath(directory, decode(commonFile).trim()) : directory;
  return { directory, common };
}

async function readOptional(invocation: Invocation, path: string) {
  return invocation.filesystem.readFile(resolvePath(invocation.cwd, path));
}

function parentDirectory(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}
