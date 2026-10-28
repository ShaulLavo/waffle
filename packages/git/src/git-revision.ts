import * as git from "isomorphic-git";
import { absolute, exists, GitFailure, output, type GitContext } from "./git-context";
import type { GitFilesystem, GitInvocation } from "./git-types";

type LocationQuery = "--show-toplevel" | "--show-prefix" | "--is-inside-work-tree";

interface RevisionQuery {
  readonly locations: readonly LocationQuery[];
  readonly refs: readonly string[];
  readonly verify: boolean;
  readonly short: number | "default" | null;
}

export async function gitRevParse(
  fs: GitFilesystem,
  invocation: GitInvocation,
  args: readonly string[],
): Promise<number> {
  const cwd = absolute("/", invocation.cwd);
  const dir = await findRoot(fs, cwd);
  if (dir === null)
    return fatal(invocation, "not a git repository (or any of the parent directories): .git");
  const context = { fs, dir, invocation };
  const query = parseQuery(args);
  const gitdir = absolute(dir, ".git");
  const metadata = cwd === gitdir || cwd.startsWith(`${gitdir}/`);
  const inside = !metadata && (await git.getConfig({ ...context, path: "core.bare" })) !== true;
  for (const location of query.locations) {
    if (location === "--show-toplevel" && !inside)
      return fatal(invocation, "this operation must be run in a work tree");
    await output(context, locationValue(location, dir, cwd, inside));
  }
  if (query.verify && query.refs.length !== 1) return fatal(invocation, "Needed a single revision");
  const minimum = query.short === "default" ? await defaultShort(context) : query.short;
  for (const ref of query.refs) {
    const oid = await resolveRevision(context, ref);
    if (oid === null) return missingRevision(context, query, ref);
    const value = minimum === null ? oid : await shorten(context, oid, minimum);
    await output(context, `${value}\n`);
  }
  return 0;
}

async function findRoot(fs: GitFilesystem, cwd: string): Promise<string | null> {
  try {
    return await git.findRoot({ fs, filepath: cwd });
  } catch (error) {
    if (error instanceof git.Errors.NotFoundError) return null;
    throw error;
  }
}

function parseQuery(args: readonly string[]): RevisionQuery {
  const locations: LocationQuery[] = [];
  const refs: string[] = [];
  let verify = false;
  let short: number | "default" | null = null;
  for (const arg of args) {
    if (!arg.startsWith("-")) {
      validateRevision(arg);
      refs.push(arg);
      continue;
    }
    if (refs.length) throw new GitFailure("rev-parse options must precede revisions", 129);
    if (arg === "--show-toplevel" || arg === "--show-prefix" || arg === "--is-inside-work-tree") {
      locations.push(arg);
      continue;
    }
    if (arg === "--verify") {
      verify = true;
      continue;
    }
    if (arg === "--short" || arg.startsWith("--short=")) {
      short = shortLength(arg);
      verify = true;
      continue;
    }
    throw new GitFailure(`unsupported rev-parse option '${arg}'`, 129);
  }
  return { locations, refs, verify, short };
}

function shortLength(arg: string): number | "default" {
  if (arg === "--short") return "default";
  const value = arg.slice("--short=".length);
  if (!/^\d+$/.test(value)) throw new GitFailure("--short needs a nonnegative integer", 129);
  return Math.max(4, Math.min(40, Number(value)));
}

async function defaultShort(context: GitContext): Promise<number> {
  const value: unknown = await git.getConfig({ ...context, path: "core.abbrev" });
  if (value === undefined) return 7;
  if (value === "no") return 40;
  if (typeof value === "string" && /^\d+$/.test(value) && Number(value) >= 4 && Number(value) <= 40)
    return Number(value);
  throw new GitFailure("rev-parse supports only numeric core.abbrev (4..40) or no", 129);
}

function validateRevision(ref: string) {
  if (
    !ref ||
    ref === "@" ||
    /[~^:?*[\\]/.test(ref) ||
    Array.from(ref).some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    ) ||
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock")) ||
    ref.endsWith(".")
  )
    throw new GitFailure(`unsupported revision syntax '${ref}'`, 129);
}

function locationValue(location: LocationQuery, dir: string, cwd: string, inside: boolean) {
  if (location === "--show-toplevel") return `${dir}\n`;
  if (location === "--is-inside-work-tree") return `${inside}\n`;
  if (!inside || cwd === dir) return "\n";
  return `${cwd.slice(dir === "/" ? 1 : dir.length + 1)}/\n`;
}

async function resolveRevision(context: GitContext, ref: string): Promise<string | null> {
  if (/^[0-9a-fA-F]{40}$/.test(ref)) return ref.toLowerCase();
  const names = new Set(
    (await git.listRefs({ ...context, filepath: "refs" })).map((name) => `refs/${name}`),
  );
  names.add("HEAD");
  const matches = [
    ref,
    `refs/${ref}`,
    `refs/tags/${ref}`,
    `refs/heads/${ref}`,
    `refs/remotes/${ref}`,
    `refs/remotes/${ref}/HEAD`,
  ].filter((name) => names.has(name));
  if (matches.length > 1)
    throw new GitFailure(`ambiguous ref '${ref}'; use its full ref name`, 129);
  try {
    if (matches.length) return await git.resolveRef({ ...context, ref: matches[0] });
    if (/^[0-9a-fA-F]{4,39}$/.test(ref))
      return await git.expandOid({ ...context, oid: ref.toLowerCase() });
    return null;
  } catch (error) {
    if (error instanceof git.Errors.NotFoundError) return null;
    if (error instanceof git.Errors.AmbiguousError)
      throw new GitFailure(`ambiguous object prefix '${ref}'; use a longer object ID`, 128);
    throw error;
  }
}

async function shorten(context: GitContext, oid: string, minimum: number): Promise<string> {
  for (let length = minimum; length < 40; length++) {
    const prefix = oid.slice(0, length);
    try {
      if ((await git.expandOid({ ...context, oid: prefix })) === oid) return prefix;
    } catch (error) {
      if (error instanceof git.Errors.NotFoundError) return prefix;
      if (!(error instanceof git.Errors.AmbiguousError)) throw error;
    }
  }
  return oid;
}

async function missingRevision(context: GitContext, query: RevisionQuery, ref: string) {
  if (query.verify) return fatal(context.invocation, "Needed a single revision");
  if (await exists(context.fs, absolute(context.invocation.cwd, ref)))
    throw new GitFailure("rev-parse path operands are unsupported", 129);
  await output(context, `${ref}\n`);
  return fatal(
    context.invocation,
    `ambiguous argument '${ref}': unknown revision or path not in the working tree.\n` +
      "Use '--' to separate paths from revisions, like this:\n" +
      "'git <command> [<revision>...] -- [<file>...]'",
  );
}

async function fatal(invocation: GitInvocation, message: string) {
  await invocation.stderr(new TextEncoder().encode(`fatal: ${message}\n`));
  return 128;
}
