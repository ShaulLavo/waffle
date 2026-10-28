import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Program = "head" | "cut" | "wc";
type Case = {
  name: string;
  program: Program;
  args: string[];
  input: Buffer;
  mode: "stdin" | "file";
};

const environment = { LC_ALL: "C", TZ: "UTC" };
const corpus = new URL("../fixtures/gnu-usage-contracts/corpus.tsv", import.meta.url);
const lines = Buffer.from("one\ntwo\nthree");
const crlf = Buffer.from("a\r\nbb\r\nlast\r");
const binary = Buffer.from([0xff, 0, 0x61, 0x62, 0x0a, 0x80, 0x0a]);
const fields = Buffer.from(":a::b:\nplain\nx:y:z\n::\nlast:tail");

function usage(
  program: Program,
  name: string,
  args: string[],
  input: Buffer,
  mode: Case["mode"] = "stdin",
): Case {
  return { name: `${program}-${name}`, program, args, input, mode };
}

const cases: Case[] = [
  usage("head", "empty", [], Buffer.alloc(0)),
  usage("head", "unterminated", ["-n1"], Buffer.from("last")),
  usage("head", "crlf-lines", ["--lines=2"], crlf, "file"),
  usage("head", "binary-bytes", ["--bytes=4"], binary),
  usage("head", "zero-lines", ["-n", "0"], lines),
  usage("head", "zero-bytes", ["-c0"], binary, "file"),
  usage("head", "negative-lines", ["-n", "-1"], lines, "file"),
  usage("head", "negative-bytes", ["-c", "-2"], binary),
  usage("head", "negative-zero", ["-n-0"], lines, "file"),
  usage("head", "nul-records", ["-z", "-n2"], Buffer.from("a\0\0tail")),
  usage("head", "split-utf8", ["-c1"], Buffer.from("é\n"), "file"),
  usage("head", "obsolete-count", ["-1"], lines),
  usage("cut", "empty", ["-b1"], Buffer.alloc(0)),
  usage("cut", "unterminated", ["-b2-3"], Buffer.from("abcd")),
  usage("cut", "crlf-bytes", ["-b1,3-"], crlf, "file"),
  usage("cut", "binary-characters-c-locale", ["-c2-4"], binary),
  usage("cut", "overlap", ["-b1-3,2-5"], Buffer.from("abcdef\n")),
  usage("cut", "complement", ["-b2-4", "--complement"], binary, "file"),
  usage("cut", "tab-fields", ["-f1,3"], Buffer.from("a\tb\tc\n\t\tx\nplain")),
  usage("cut", "empty-fields", ["-d:", "-f1,3"], fields, "file"),
  usage("cut", "suppress-undelimited", ["-s", "-d:", "-f2"], fields),
  usage("cut", "output-delimiter", ["-d:", "-f1,3", "--output-delimiter=|"], fields),
  usage("cut", "empty-output-delimiter", ["-d:", "-f1,3", "--output-delimiter="], fields),
  usage("cut", "nul-records", ["-z", "-d:", "-f2"], Buffer.from("a:b\0x:y:z\0last:tail")),
  usage("wc", "empty", [], Buffer.alloc(0)),
  usage("wc", "unterminated", [], lines),
  usage("wc", "crlf", [], crlf, "file"),
  usage("wc", "nul", [], Buffer.from("a\0b c\0\n")),
  usage("wc", "invalid-utf8", [], binary, "file"),
  usage("wc", "line-boundaries", ["-l"], Buffer.from("\n\nlast")),
  usage("wc", "word-boundaries", ["-w"], Buffer.from(" a\tb\vc\fd\re\nf\0g ")),
  usage("wc", "byte-count", ["-c"], binary),
  usage("wc", "combined-order", ["-cwl"], lines, "file"),
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
  const args = test.mode === "file" ? test.args.concat(["input"]) : test.args;
  const result = await oracle(test.program, args, cwd, test.mode === "stdin" ? test.input : Buffer.alloc(0));
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
  const headers = ["# GNU usage contracts v1", `# environment ${JSON.stringify(environment)}`];
  for (const program of ["head", "cut", "wc"] satisfies Program[]) {
    const result = await oracle(program, ["--version"], cwd, Buffer.alloc(0));
    assert.equal(result.status, 0);
    const version = result.stdout.toString().split("\n")[0];
    assert.ok(version);
    assert.match(version, new RegExp(`^${program} \\(GNU coreutils\\) 9\\.`));
    headers.push(`# oracle ${version}`);
  }
  headers.push("# name\tprogram\targv-hex-colon-separated\tmode\tinput-hex\tinput-sha256\tstatus\tstdout-hex\tstderr-hex");
  const rows: string[] = [];
  for (const test of cases) rows.push(await record(test, cwd));
  return headers.concat(rows).join("\n") + "\n";
}

const mode = process.argv[2];
assert.ok(mode === "--record" || mode === "--check", "use --record for a new corpus or --check to compare GNU");
const cwd = mkdtempSync(join(tmpdir(), "waffle-gnu-usage-"));
try {
  const result = await recording(cwd);
  if (mode === "--check") assert.equal(result, readFileSync(corpus, "utf8"));
  if (mode === "--record") writeFileSync(corpus, result, { flag: "wx" });
  process.stdout.write(`${cases.length} GNU usage contracts ${mode.slice(2)} passed\n`);
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
