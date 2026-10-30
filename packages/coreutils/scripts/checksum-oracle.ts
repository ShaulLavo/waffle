import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { resolve } from "node:path";
import { checksumNames, type ChecksumName } from "./build-checksums.ts";

const packageRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(packageRoot, "../..");
export const fixturePath = resolve(packageRoot, "fixtures/checksums.json");
const upstreamRevision = "07763857f6b9a547742a994b58aef0ccd036198b";
const oracleEnvironment = {
  PATH: "/usr/bin:/bin",
  HOME: "/tmp/spec",
  LC_ALL: "C",
  TZ: "UTC",
} as const;

export interface ChecksumFile {
  readonly path: string;
  readonly contentBase64: string;
}

interface Observation {
  readonly status: number;
  readonly stdoutBase64: string;
  readonly stderrPresent: boolean;
}

interface CaseInput {
  readonly name: string;
  readonly utility: ChecksumName;
  readonly args: readonly [ChecksumName, ...string[]];
  readonly inputBase64: string;
  readonly files: readonly ChecksumFile[];
}

export type ChecksumCase = CaseInput & Observation;

interface OracleIdentity {
  readonly path: string;
  readonly version: string;
  readonly sha256: string;
}

export interface ChecksumFixture {
  readonly schema: 1;
  readonly upstreamRevision: string;
  readonly environment: typeof oracleEnvironment;
  readonly utilities: Readonly<Record<string, OracleIdentity>>;
  readonly cases: readonly ChecksumCase[];
  readonly stream: Observation;
}

const sourceInput = Buffer.from("Waffle checksum\n", "utf8");
const sourceFile = { path: "input", contentBase64: sourceInput.toString("base64") };
const sourceHash = "c19ca03d5d5604003f0b0b827060d88006cf6a597a7b1cb5787b166e5b9633f2";
export const streamingInput = {
  chunk: Uint8Array.from({ length: 8192 }, (_, index) => index & 255),
  repetitions: 128,
} as const;

function inputCase(
  utility: ChecksumName,
  label: string,
  args: readonly string[],
  input = "",
  files: readonly ChecksumFile[] = [],
): CaseInput {
  return {
    name: `${utility} ${label}`,
    utility,
    args: [utility, ...args],
    inputBase64: Buffer.from(input).toString("base64"),
    files,
  };
}

function verificationCase(utility: ChecksumName): CaseInput {
  const algorithm = utility === "b2sum" ? "blake2b512" : utility.replace(/sum$/, "");
  const checksum = `${createHash(algorithm).update(sourceInput).digest("hex")}  input\n`;
  return inputCase(utility, "verifies a matching file", ["--check", "expected"], "", [
    sourceFile,
    { path: "expected", contentBase64: Buffer.from(checksum).toString("base64") },
  ]);
}

function caseDefinitions(): CaseInput[] {
  const cases: CaseInput[] = [];
  for (const name of checksumNames) {
    cases.push(inputCase(name, "reads stdin", [], sourceInput.toString()));
    cases.push(inputCase(name, "reads a relative file", ["input"], "", [sourceFile]));
  }
  const verifying = checksumNames.filter((name) => name !== "sum" && name !== "cksum");
  const verified = cases.concat(verifying.map(verificationCase));
  return verified.concat([
    inputCase("sha256sum", "checks a list from stdin", ["--check", "-"], `${sourceHash}  input\n`, [
      sourceFile,
    ]),
    inputCase(
      "sha256sum",
      "rejects a mismatching file",
      ["--check", "-"],
      `${"0".repeat(64)}  input\n`,
      [sourceFile],
    ),
    inputCase(
      "sha256sum",
      "reports malformed verification lines",
      ["--check", "-"],
      "not a checksum\n",
    ),
    inputCase("sha256sum", "reports a missing data file", ["missing"]),
    inputCase("sha256sum", "reports a missing checksum list", ["--check", "missing"]),
    inputCase(
      "sha256sum",
      "reports a missing verification target",
      ["--check", "-"],
      `${sourceHash}  missing\n`,
    ),
    inputCase(
      "sha256sum",
      "suppresses successful verification output",
      ["--check", "--status", "-"],
      `${sourceHash}  input\n`,
      [sourceFile],
    ),
    inputCase("sha256sum", "rejects invalid options", ["--not-an-option"]),
    inputCase("sha256sum", "preserves binary file bytes", ["binary"], "", [
      { path: "binary", contentBase64: Buffer.from([0, 255, 13, 10, 128, 0]).toString("base64") },
    ]),
    inputCase("sum", "supports System V sums", ["-s"], sourceInput.toString()),
    inputCase("b2sum", "supports digest lengths", ["--length=128"], sourceInput.toString()),
    inputCase("cksum", "supports SHA256 selection", ["--algorithm=sha256"], sourceInput.toString()),
  ]);
}

function oraclePath(name: ChecksumName) {
  return resolve("/usr/bin", name);
}

function nativeVersion(path: string): string {
  const version = execFileSync(path, ["--version"], {
    env: oracleEnvironment,
    encoding: "utf8",
    timeout: 5000,
  }).split("\n", 1)[0];
  assert.ok(version);
  return version.trim();
}

function utilityIdentities(): Record<string, OracleIdentity> {
  return Object.fromEntries(
    checksumNames.map((name) => {
      const path = oraclePath(name);
      const version = nativeVersion(path);
      assert.equal(version, `${name} (GNU coreutils) 9.12`);
      return [
        name,
        { path, version, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") },
      ];
    }),
  );
}

function writeFiles(root: string, files: readonly ChecksumFile[]) {
  for (const file of files) {
    assert(
      !file.path.startsWith("/") && !file.path.includes(".."),
      `Unsafe fixture path: ${file.path}`,
    );
    writeFileSync(resolve(root, file.path), Buffer.from(file.contentBase64, "base64"));
  }
}

function observe(result: ReturnType<typeof spawnSync>): Observation {
  assert.equal(result.error, undefined, "Native oracle failed to start");
  assert.equal(result.signal, null, "Native oracle was signaled");
  assert.ok(
    result.status !== null && Buffer.isBuffer(result.stdout) && Buffer.isBuffer(result.stderr),
  );
  return {
    status: result.status,
    stdoutBase64: result.stdout.toString("base64"),
    stderrPresent: result.stderr.byteLength > 0,
  };
}

function runNative(root: string, definition: CaseInput): ChecksumCase {
  writeFiles(root, definition.files);
  const result = spawnSync(oraclePath(definition.utility), definition.args.slice(1), {
    cwd: root,
    env: oracleEnvironment,
    input: Buffer.from(definition.inputBase64, "base64"),
    timeout: 5000,
  });
  return { ...definition, ...observe(result) };
}

function streamingOracle(root: string): Observation {
  const path = resolve(root, "streaming-input");
  const writer = openSync(path, "w");
  try {
    for (let index = 0; index < streamingInput.repetitions; index++) {
      assert.equal(writeSync(writer, streamingInput.chunk), streamingInput.chunk.byteLength);
    }
  } finally {
    closeSync(writer);
  }
  const reader = openSync(path, "r");
  try {
    return observe(
      spawnSync(oraclePath("sha256sum"), [], {
        cwd: root,
        env: oracleEnvironment,
        stdio: [reader, "pipe", "pipe"],
        timeout: 5000,
      }),
    );
  } finally {
    closeSync(reader);
  }
}

function withOracleRoot<T>(run: (root: string) => T) {
  const parent = resolve(workspaceRoot, ".build");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(resolve(parent, "checksum-oracle-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export function recordFixture() {
  assert(!existsSync(fixturePath), `Refusing to overwrite owned fixture: ${fixturePath}`);
  const utilities = utilityIdentities();
  const fixture: ChecksumFixture = withOracleRoot((root) => ({
    schema: 1,
    upstreamRevision,
    environment: oracleEnvironment,
    utilities,
    cases: caseDefinitions().map((definition) => runNative(root, definition)),
    stream: streamingOracle(root),
  }));
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + "\n");
  return fixture;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObservation(value: unknown): Observation {
  assert.ok(record(value));
  assert.ok(typeof value.status === "number" && Number.isInteger(value.status));
  assert.ok(typeof value.stdoutBase64 === "string");
  assert.equal(Buffer.from(value.stdoutBase64, "base64").toString("base64"), value.stdoutBase64);
  assert.ok(typeof value.stderrPresent === "boolean");
  return {
    status: value.status,
    stdoutBase64: value.stdoutBase64,
    stderrPresent: value.stderrPresent,
  };
}

function parseCase(value: unknown, definition: CaseInput): ChecksumCase {
  assert.ok(record(value));
  for (const [key, expected] of Object.entries(definition)) assert.deepEqual(value[key], expected);
  return { ...definition, ...parseObservation(value) };
}

function parseIdentity(value: unknown): OracleIdentity {
  assert.ok(record(value));
  assert.ok(
    typeof value.path === "string" &&
      typeof value.version === "string" &&
      typeof value.sha256 === "string",
  );
  assert.match(value.sha256, /^[a-f0-9]{64}$/);
  return { path: value.path, version: value.version, sha256: value.sha256 };
}

export function readFixture(): ChecksumFixture {
  const value: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));
  assert.ok(record(value));
  assert.equal(value.schema, 1);
  assert.equal(value.upstreamRevision, upstreamRevision);
  assert.deepEqual(value.environment, oracleEnvironment);
  assert.ok(record(value.utilities) && Array.isArray(value.cases));
  const utilities = value.utilities;
  const cases = value.cases;
  assert.deepEqual(Object.keys(utilities), checksumNames);
  const definitions = caseDefinitions();
  assert.equal(cases.length, definitions.length);
  return {
    schema: 1,
    upstreamRevision,
    environment: oracleEnvironment,
    utilities: Object.fromEntries(
      checksumNames.map((name) => [name, parseIdentity(utilities[name])]),
    ),
    cases: definitions.map((definition, index) => parseCase(cases[index], definition)),
    stream: parseObservation(value.stream),
  };
}

export function verifyFixture(fixture = readFixture()) {
  assert.deepEqual(fixture.utilities, utilityIdentities());
  withOracleRoot((root) => {
    for (const definition of fixture.cases) {
      assert.deepEqual(runNative(root, definition), definition, definition.name);
    }
    assert.deepEqual(streamingOracle(root), fixture.stream);
  });
  return fixture;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  if (process.argv[2] === "--record") recordFixture();
  else if (process.argv[2] === "--verify") verifyFixture();
  else throw new Error("Usage: node scripts/checksum-oracle.ts --record|--verify");
}
