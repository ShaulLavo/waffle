import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Program = "sort" | "uniq" | "tr";
type Case = {
  name: string;
  program: Program;
  args: string[];
  input: Buffer;
  mode: "stdin-pipe" | "file-operand";
};

const environment = { LC_ALL: "C", TZ: "UTC" };
const corpus = new URL("../fixtures/gnu-sort-uniq-tr-contracts/corpus.tsv", import.meta.url);
const ordered = Buffer.from("b\na\na\nc\n");
const grouped = Buffer.from("a\na\nb\nc\nc\nc\n");
const binary = Buffer.from([0xff, 0x0a, 0x61, 0x0a, 0x80, 0x0a, 0x00, 0x0a]);

function usage(
  program: Program,
  name: string,
  args: string[],
  input: Buffer,
  mode: Case["mode"] = "stdin-pipe",
): Case {
  return { name: `${program}-${name}`, program, args, input, mode };
}

const cases: Case[] = [
  usage("sort", "empty", [], Buffer.alloc(0)),
  usage("sort", "byte-ordering", [], binary),
  usage("sort", "numeric", ["-n"], Buffer.from("10\n2\n-3\n02\n0\n")),
  usage("sort", "stable-key", ["-s", "-k1,1"], Buffer.from("b first\na second\na first\nb second\n"), "file-operand"),
  usage("sort", "stable-numeric", ["-sn"], Buffer.from("2 z\n02 a\n1 x\n2 a\n")),
  usage("sort", "unique", ["-u"], ordered),
  usage("sort", "numeric-unique", ["-nu"], Buffer.from("2 z\n02 a\n1 x\n2 a\n")),
  usage("sort", "reverse", ["-r"], ordered, "file-operand"),
  usage("sort", "nul-records", ["-z"], Buffer.from("b\0a\0\0tail")),
  usage("sort", "unterminated", [], Buffer.from("b\na"), "file-operand"),
  usage("uniq", "empty", [], Buffer.alloc(0)),
  usage("uniq", "adjacent", [], grouped),
  usage("uniq", "count", ["-c"], grouped, "file-operand"),
  usage("uniq", "nonadjacent", [], Buffer.from("a\nb\na\na\nb\n")),
  usage("uniq", "repeated", ["-d"], grouped),
  usage("uniq", "unique-groups", ["-u"], grouped),
  usage("uniq", "nul-records", ["-z"], Buffer.from("a\0a\0b\0a\0a")),
  usage("uniq", "unterminated", ["-c"], Buffer.from("a\na\nb"), "file-operand"),
  usage("uniq", "invalid-utf8", [], Buffer.from([0xff, 0x0a, 0xff, 0x0a, 0x80, 0x0a])),
  usage("tr", "empty", ["a-z", "A-Z"], Buffer.alloc(0)),
  usage("tr", "translate-range", ["a-z", "A-Z"], Buffer.from("az By\n")),
  usage("tr", "delete", ["-d", "0-9"], Buffer.from("a1b22c3\n")),
  usage("tr", "squeeze", ["-s", " "], Buffer.from(" a   b  \n")),
  usage("tr", "translate-squeeze", ["-s", "a-z", "A-Z"], Buffer.from("aaabbccz\n")),
  usage("tr", "delete-squeeze", ["-ds", "0-9", " "], Buffer.from("a 1  b22  c\n")),
  usage("tr", "nul-translate", ["\\000", "X"], Buffer.from([0, 0x61, 0, 0xff, 0x0a])),
  usage("tr", "invalid-utf8", ["a", "b"], Buffer.from([0xff, 0x61, 0x80, 0xc3, 0x0a])),
  usage("tr", "unterminated-short-set", ["abc", "X"], Buffer.from("cababa")),
];

function hex(bytes: Uint8Array): string {
  if (bytes.length === 0) return "-";
  return Buffer.from(bytes).toString("hex");
}

async function oracle(program: Program, args: string[], cwd: string, input: Buffer) {
  const child = spawn(`/usr/bin/${program}`, args, {
    cwd,
    env: environment,
    stdio: "pipe",
    timeout: 3000,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const closed = Promise.withResolvers<{ status: number | null; signal: string | null }>();
  child.once("error", closed.reject);
  child.once("close", (status, signal) => closed.resolve({ status, signal }));
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") closed.reject(error);
  });
  child.stdin.end(input);
  const { status, signal } = await closed.promise;
  assert.equal(signal, null);
  assert.notEqual(status, null);
  return { status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
}

async function record(test: Case, cwd: string): Promise<string> {
  writeFileSync(join(cwd, "input"), test.input);
  const args = test.mode === "file-operand" ? test.args.concat(["input"]) : test.args;
  const result = await oracle(test.program, args, cwd, test.mode === "stdin-pipe" ? test.input : Buffer.alloc(0));
  assert.equal(result.status, 0, test.name);
  assert.equal(result.stderr.length, 0, test.name);
  return [
    test.name,
    test.program,
    args.map((arg) => hex(Buffer.from(arg))).join(":"),
    test.mode,
    hex(test.input),
    createHash("sha256").update(test.input).digest("hex"),
    result.status,
    hex(result.stdout),
    hex(result.stderr),
  ].join("\t");
}

async function recording(cwd: string): Promise<string> {
  const headers = ["# GNU sort uniq tr contracts v1", `# environment ${JSON.stringify(environment)}`];
  for (const program of ["sort", "uniq", "tr"] satisfies Program[]) {
    const result = await oracle(program, ["--version"], cwd, Buffer.alloc(0));
    assert.equal(result.status, 0);
    const version = result.stdout.toString().split("\n")[0];
    assert.ok(version);
    assert.match(version, new RegExp(`^${program} \\(GNU coreutils\\) 9\\.`));
    headers.push(`# oracle ${version}`);
  }
  headers.push("# descriptors stdin=pipe stdout=pipe stderr=pipe; file-operand adds regular file input and writes no stdin bytes");
  headers.push("# name\tprogram\targv-hex-colon-separated\tinput-kind\tinput-hex\tinput-sha256\tstatus\tstdout-hex\tstderr-hex");
  const rows: string[] = [];
  for (const test of cases) rows.push(await record(test, cwd));
  return headers.concat(rows).join("\n") + "\n";
}

const mode = process.argv[2];
assert.ok(mode === "--record" || mode === "--check", "use --record for a new corpus or --check to compare GNU");
const cwd = mkdtempSync(join(tmpdir(), "waffle-gnu-sort-uniq-tr-"));
try {
  const result = await recording(cwd);
  if (mode === "--check") assert.equal(result, readFileSync(corpus, "utf8"));
  if (mode === "--record") writeFileSync(corpus, result, { flag: "wx" });
  process.stdout.write(`${cases.length} GNU usage contracts ${mode.slice(2)} passed\n`);
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
