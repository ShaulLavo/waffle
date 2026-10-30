import { arity, choice, parseArgs, positiveInt, type OptionSpec, type ParsedArgs } from "./args.ts";
import { GhError } from "./errors.ts";
import { validateFields, type ResourceKind } from "./fields.ts";
import type { OutputFormat } from "./output.ts";
import { parseRepository } from "./repository.ts";
import type { Repository } from "./types.ts";

export type Command =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "auth-login"; readonly hostname?: string }
  | {
      readonly kind: "pr-list";
      readonly repo?: Repository;
      readonly output: OutputFormat;
      readonly state: "open" | "closed" | "merged" | "all";
      readonly head?: string;
      readonly base?: string;
      readonly limit: number;
    }
  | {
      readonly kind: "pr-view";
      readonly repo?: Repository;
      readonly output: OutputFormat;
      readonly selector?: string;
    }
  | {
      readonly kind: "pr-create";
      readonly repo?: Repository;
      readonly title: string;
      readonly body?: string;
      readonly bodyFile?: string;
      readonly head?: string;
      readonly base?: string;
      readonly draft: boolean;
      readonly maintainerCanModify: boolean;
    }
  | {
      readonly kind: "issue-list";
      readonly repo?: Repository;
      readonly output: OutputFormat;
      readonly state: "open" | "closed" | "all";
      readonly limit: number;
    }
  | {
      readonly kind: "issue-view";
      readonly repo?: Repository;
      readonly output: OutputFormat;
      readonly selector: string;
    }
  | {
      readonly kind: "issue-create";
      readonly repo?: Repository;
      readonly title: string;
      readonly body?: string;
      readonly bodyFile?: string;
    }
  | {
      readonly kind: "run-list";
      readonly repo?: Repository;
      readonly output: OutputFormat;
      readonly limit: number;
      readonly branch?: string;
      readonly status?: string;
      readonly commit?: string;
      readonly event?: string;
    }
  | {
      readonly kind: "run-view";
      readonly repo?: Repository;
      readonly output: OutputFormat;
      readonly id: string;
      readonly attempt?: number;
      readonly exitStatus: boolean;
    }
  | {
      readonly kind: "repo-view";
      readonly repo?: Repository;
      readonly output: OutputFormat;
      readonly branch?: string;
    }
  | {
      readonly kind: "api";
      readonly endpoint: string;
      readonly method?: string;
      readonly rawFields: readonly string[];
      readonly typedFields: readonly string[];
      readonly headers: readonly string[];
      readonly previews: readonly string[];
      readonly hostname?: string;
      readonly input?: string;
      readonly jq?: string;
      readonly paginate: boolean;
      readonly slurp: boolean;
      readonly silent: boolean;
      readonly include: boolean;
    };

const repoValues = { "-R": "repo", "--repo": "repo" };
const formatValues = { "--json": "json", "-q": "jq", "--jq": "jq" };
const bodyValues = {
  "-b": "body",
  "--body": "body",
  "-F": "body-file",
  "--body-file": "body-file",
};

export function parseCommand(argv: readonly string[]): Command {
  if (argv.length === 1 && argv[0] === "--version") return { kind: "version" };
  if (!argv.length || argv.includes("--help") || argv[0] === "help") return { kind: "help" };
  const [group, subcommand, ...rest] = argv;
  if (group === "api") return parseApi(argv.slice(1));
  if (group === "auth" && subcommand === "login") return parseAuth(rest);
  if (group === "repo" && subcommand === "view") return parseRepoView(rest);
  if (group === "pr") return parsePr(subcommand, rest);
  if (group === "issue") return parseIssue(subcommand, rest);
  if (group === "run") return parseRun(subcommand, rest);
  throw new GhError(`unknown command: ${argv.slice(0, 2).join(" ")}`);
}

function parsePr(subcommand: string | undefined, argv: readonly string[]): Command {
  if (subcommand === "list" || subcommand === "ls") return parsePrList(argv);
  if (subcommand === "view") return parsePrView(argv);
  if (subcommand === "create" || subcommand === "new") return parsePrCreate(argv);
  throw new GhError(`unknown command: pr ${subcommand ?? ""}`);
}

function parsePrList(argv: readonly string[]): Command {
  const spec = specWith({
    "--state": "state",
    "-s": "state",
    "--head": "head",
    "-H": "head",
    "--base": "base",
    "-B": "base",
    "--limit": "limit",
    "-L": "limit",
  });
  const args = parseArgs(argv, spec);
  arity(args, 0);
  const head = args.values.get("head");
  if (head?.includes(":")) throw new GhError("--head does not support <owner>:<branch> syntax");
  return {
    kind: "pr-list",
    repo: optionalRepository(args),
    output: outputFormat(args, "pr"),
    state: choice(args.values.get("state"), "open", ["open", "closed", "merged", "all"], "--state"),
    head,
    base: args.values.get("base"),
    limit: positiveInt(args.values.get("limit"), 30, "--limit"),
  };
}

function parsePrView(argv: readonly string[]): Command {
  const args = parseArgs(argv, specWith({}));
  arity(args, 0, 1);
  return {
    kind: "pr-view",
    repo: optionalRepository(args),
    output: outputFormat(args, "pr"),
    selector: args.positionals[0],
  };
}

function parsePrCreate(argv: readonly string[]): Command {
  const args = parseArgs(
    argv,
    specWith(
      {
        "--title": "title",
        "-t": "title",
        "--head": "head",
        "-H": "head",
        "--base": "base",
        "-B": "base",
        ...bodyValues,
      },
      { "--draft": "draft", "-d": "draft", "--no-maintainer-edit": "no-maintainer-edit" },
    ),
  );
  arity(args, 0);
  const title = args.values.get("title");
  if (!title) throw new GhError("--title is required in noninteractive mode");
  return {
    kind: "pr-create",
    repo: optionalRepository(args),
    title,
    body: args.values.get("body"),
    bodyFile: args.values.get("body-file"),
    head: args.values.get("head"),
    base: args.values.get("base"),
    draft: args.flags.has("draft"),
    maintainerCanModify: !args.flags.has("no-maintainer-edit"),
  };
}

function parseIssue(subcommand: string | undefined, argv: readonly string[]): Command {
  if (subcommand === "list" || subcommand === "ls") {
    const args = parseArgs(
      argv,
      specWith({ "--state": "state", "-s": "state", "--limit": "limit", "-L": "limit" }),
    );
    arity(args, 0);
    return {
      kind: "issue-list",
      repo: optionalRepository(args),
      output: outputFormat(args, "issue"),
      state: choice(args.values.get("state"), "open", ["open", "closed", "all"], "--state"),
      limit: positiveInt(args.values.get("limit"), 30, "--limit"),
    };
  }
  if (subcommand === "view") {
    const args = parseArgs(argv, specWith({}));
    arity(args, 1);
    return {
      kind: "issue-view",
      repo: optionalRepository(args),
      output: outputFormat(args, "issue"),
      selector: args.positionals[0],
    };
  }
  if (subcommand === "create" || subcommand === "new") {
    const args = parseArgs(argv, specWith({ "--title": "title", "-t": "title", ...bodyValues }));
    arity(args, 0);
    const title = args.values.get("title");
    if (!title) throw new GhError("--title is required in noninteractive mode");
    return {
      kind: "issue-create",
      repo: optionalRepository(args),
      title,
      body: args.values.get("body"),
      bodyFile: args.values.get("body-file"),
    };
  }
  throw new GhError(`unknown command: issue ${subcommand ?? ""}`);
}

function parseRun(subcommand: string | undefined, argv: readonly string[]): Command {
  if (subcommand === "list" || subcommand === "ls") {
    const args = parseArgs(
      argv,
      specWith({
        "--limit": "limit",
        "-L": "limit",
        "--branch": "branch",
        "-b": "branch",
        "--status": "status",
        "-s": "status",
        "--commit": "commit",
        "-c": "commit",
        "--event": "event",
        "-e": "event",
      }),
    );
    arity(args, 0);
    const status = args.values.get("status");
    if (status) choice(status, "completed", runStatuses, "--status");
    return {
      kind: "run-list",
      repo: optionalRepository(args),
      output: outputFormat(args, "run"),
      limit: positiveInt(args.values.get("limit"), 20, "--limit"),
      branch: args.values.get("branch"),
      status,
      commit: args.values.get("commit"),
      event: args.values.get("event"),
    };
  }
  if (subcommand === "view") {
    const args = parseArgs(
      argv,
      specWith({ "--attempt": "attempt", "-a": "attempt" }, { "--exit-status": "exit-status" }),
    );
    arity(args, 1);
    const id = args.positionals[0];
    if (!/^\d+$/.test(id)) throw new GhError("run ID must be numeric");
    return {
      kind: "run-view",
      repo: optionalRepository(args),
      output: outputFormat(args, "run"),
      id,
      attempt: args.values.has("attempt")
        ? positiveInt(args.values.get("attempt"), 1, "--attempt")
        : undefined,
      exitStatus: args.flags.has("exit-status"),
    };
  }
  throw new GhError(`unknown command: run ${subcommand ?? ""}`);
}

function parseRepoView(argv: readonly string[]): Command {
  const args = parseArgs(argv, {
    values: { ...formatValues, "--branch": "branch", "-b": "branch" },
  });
  arity(args, 0, 1);
  const repository = args.positionals[0];
  return {
    kind: "repo-view",
    repo: repository ? parseRepository(repository) : undefined,
    output: outputFormat(args, "repo"),
    branch: args.values.get("branch"),
  };
}

function parseAuth(argv: readonly string[]): Command {
  const args = parseArgs(argv, {
    values: { "--hostname": "hostname", "-h": "hostname" },
    flags: { "--with-token": "with-token" },
  });
  arity(args, 0);
  if (!args.flags.has("with-token")) throw new GhError("only auth login --with-token is supported");
  return { kind: "auth-login", hostname: args.values.get("hostname") };
}

function parseApi(argv: readonly string[]): Command {
  const args = parseArgs(argv, {
    values: {
      "-X": "method",
      "--method": "method",
      "-f": "raw-field",
      "--raw-field": "raw-field",
      "-F": "field",
      "--field": "field",
      "-H": "header",
      "--header": "header",
      "--hostname": "hostname",
      "--input": "input",
      "-q": "jq",
      "--jq": "jq",
      "-p": "preview",
      "--preview": "preview",
    },
    flags: {
      "--paginate": "paginate",
      "--slurp": "slurp",
      "--silent": "silent",
      "-i": "include",
      "--include": "include",
    },
    repeated: ["raw-field", "field", "header", "preview"],
  });
  arity(args, 1);
  const paginate = args.flags.has("paginate");
  const slurp = args.flags.has("slurp");
  const jq = args.values.get("jq");
  if (slurp && !paginate) throw new GhError("`--paginate` required when passing `--slurp`");
  if (slurp && jq) throw new GhError("cannot use `--slurp` with `--jq`");
  const hostname = args.values.get("hostname");
  if (hostname && hostname !== "github.com") throw new GhError("only github.com is supported");
  return {
    kind: "api",
    endpoint: args.positionals[0],
    method: args.values.get("method"),
    rawFields: args.repeated.get("raw-field") ?? [],
    typedFields: args.repeated.get("field") ?? [],
    headers: args.repeated.get("header") ?? [],
    previews: args.repeated.get("preview") ?? [],
    hostname,
    input: args.values.get("input"),
    jq,
    paginate,
    slurp,
    silent: args.flags.has("silent"),
    include: args.flags.has("include"),
  };
}

function specWith(
  values: Readonly<Record<string, string>>,
  flags: Readonly<Record<string, string>> = {},
): OptionSpec {
  return { values: { ...repoValues, ...formatValues, ...values }, flags };
}

function optionalRepository(args: ParsedArgs): Repository | undefined {
  const repository = args.values.get("repo");
  return repository ? parseRepository(repository) : undefined;
}

function outputFormat(args: ParsedArgs, kind: ResourceKind): OutputFormat {
  const json = args.values.get("json");
  const jq = args.values.get("jq");
  if (jq && json === undefined) throw new GhError("cannot use `--jq` without specifying `--json`");
  if (json === undefined) return { kind: "plain" };
  const fields = json.split(",");
  if (fields.some((field) => !field)) throw new GhError("JSON fields must not be empty");
  validateFields(kind, fields);
  return { kind: "json", fields, jq };
}

const runStatuses = [
  "queued",
  "completed",
  "in_progress",
  "requested",
  "waiting",
  "pending",
  "action_required",
  "cancelled",
  "failure",
  "neutral",
  "skipped",
  "stale",
  "startup_failure",
  "success",
  "timed_out",
] as const;
