import * as git from "isomorphic-git";
import type { GitFilesystem, GitInvocation } from "./git-types";
import { conflictStatus } from "./git-index";

export class GitFailure extends Error {
  constructor(
    message: string,
    readonly status = 128,
  ) {
    super(message);
  }
}

export interface GitContext {
  readonly fs: GitFilesystem;
  readonly dir: string;
  readonly invocation: GitInvocation;
}

export function options(
  args: readonly string[],
  switches: readonly string[],
  values: readonly string[] = [],
) {
  const flags = new Set<string>();
  const named = new Map<string, string>();
  const paths: string[] = [];
  let literal = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (literal || !arg.startsWith("-") || arg === "-") {
      paths.push(arg);
      continue;
    }
    if (arg === "--") {
      literal = true;
      continue;
    }
    if (switches.includes(arg)) {
      flags.add(arg);
      continue;
    }
    index = readOption(args, index, named, values);
  }
  return { flags, named, paths };
}

function readOption(
  args: readonly string[],
  index: number,
  named: Map<string, string>,
  values: readonly string[],
) {
  const arg = args[index];
  const equals = arg.indexOf("=");
  const key = equals < 0 ? arg : arg.slice(0, equals);
  if (!values.includes(key)) throw new GitFailure(`unsupported option '${arg}'`, 129);
  const value = equals < 0 ? args[index + 1] : arg.slice(equals + 1);
  if (value === undefined) throw new GitFailure(`option '${key}' needs a value`, 129);
  named.set(key, value);
  return equals < 0 ? index + 1 : index;
}

export function arity(paths: readonly string[], minimum: number, maximum = minimum) {
  if (paths.length < minimum || paths.length > maximum)
    throw new GitFailure("unexpected arguments", 129);
}

export function absolute(base: string, path: string): string {
  const parts = (path.startsWith("/") ? path : `${base}/${path}`).split("/");
  const result: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") result.pop();
    else result.push(part);
  }
  return `/${result.join("/")}`;
}

export function pathspec(context: GitContext, path: string): string {
  const resolved = absolute(context.invocation.cwd, path);
  if (resolved === context.dir) return ".";
  const prefix = context.dir === "/" ? "/" : `${context.dir}/`;
  if (!resolved.startsWith(prefix)) throw new GitFailure(`'${path}' is outside the repository`);
  const relative = resolved.slice(prefix.length);
  if (relative === ".git" || relative.startsWith(".git/"))
    throw new GitFailure("cannot add Git metadata");
  if (/[*?[\]:]/.test(relative))
    throw new GitFailure("wildcard and magic pathspecs are unsupported", 129);
  return relative;
}

export function selected(path: string, specs: readonly string[]) {
  return (
    specs.length === 0 ||
    specs.some((spec) => spec === "." || path === spec || path.startsWith(`${spec}/`))
  );
}

export async function text(fs: GitFilesystem, path: string): Promise<string> {
  const contents = await fs.promises.readFile(path, "utf8");
  return typeof contents === "string" ? contents : new TextDecoder().decode(contents);
}

export async function exists(fs: GitFilesystem, path: string): Promise<boolean> {
  try {
    await fs.promises.stat(path);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

export async function output(context: GitContext, value: string) {
  if (value) await context.invocation.stdout(new TextEncoder().encode(value));
}

export async function identity(context: GitContext, kind: "AUTHOR" | "COMMITTER") {
  const env = context.invocation.env ?? {};
  const name = env[`GIT_${kind}_NAME`] ?? (await git.getConfig({ ...context, path: "user.name" }));
  const email =
    env[`GIT_${kind}_EMAIL`] ?? (await git.getConfig({ ...context, path: "user.email" }));
  if (!name || !email)
    throw new GitFailure(
      "identity unknown; set GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL or repository user config",
    );
  const rawDate = env[`GIT_${kind}_DATE`];
  if (!rawDate) return { name, email };
  const raw = /^@?(\d+) ([+-])(\d{2})(\d{2})$/.exec(rawDate);
  if (raw)
    return {
      name,
      email,
      timestamp: Number(raw[1]),
      timezoneOffset: (raw[2] === "+" ? -1 : 1) * (Number(raw[3]) * 60 + Number(raw[4])),
    };
  const timestamp = Date.parse(rawDate);
  const zone = /([+-])(\d{2}):?(\d{2})$/.exec(rawDate);
  if (!Number.isFinite(timestamp) || !zone) throw new GitFailure(`invalid date '${rawDate}'`);
  return {
    name,
    email,
    timestamp: Math.floor(timestamp / 1000),
    timezoneOffset: (zone[1] === "+" ? -1 : 1) * (Number(zone[2]) * 60 + Number(zone[3])),
  };
}

export async function clean(context: GitContext) {
  if ((await conflictStatus(context)).size) throw new GitFailure("unresolved merge conflicts", 1);
  const rows = await git.statusMatrix(context);
  if (
    rows.some(
      ([, head, work, stage]) => (head !== 0 || stage !== 0) && (head !== work || head !== stage),
    )
  )
    throw new GitFailure("local changes would be overwritten", 1);
}

function statusLine([path, head, work, stage]: git.StatusRow): string {
  if (head === 0 && stage === 0) return work === 0 ? "" : `?? ${quote(path)}\n`;
  const index = stage === head ? " " : stage === 0 ? "D" : head === 0 ? "A" : "M";
  const working = work === stage ? " " : work === 0 ? "D" : "M";
  return index === " " && working === " " ? "" : `${index}${working} ${quote(path)}\n`;
}

export function porcelain(
  rows: git.StatusRow[],
  conflicts: ReadonlyMap<string, string> = new Map(),
) {
  const tracked = rows.filter(([, head, , stage]) => head !== 0 || stage !== 0);
  const untracked = rows.filter(([, head, , stage]) => head === 0 && stage === 0);
  return tracked
    .concat(untracked)
    .map((row) =>
      conflicts.has(row[0]) ? `${conflicts.get(row[0])} ${quote(row[0])}\n` : statusLine(row),
    )
    .join("");
}

function quote(path: string): string {
  return /[\s"\\]/.test(path) ? JSON.stringify(path) : path;
}
