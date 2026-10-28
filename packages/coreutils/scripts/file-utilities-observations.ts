import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  fileUtilityCases,
  fileUtilityEnvironment,
  fileUtilityMetadataGap,
  initialTree,
  type FileTree,
} from "../tests/helpers/file-utility-cases.ts";

type Observation = { status: number; stdout: number[]; stderr: boolean; tree: FileTree };
const approvedIdentities = {
  bash: {
    path: "/work/tmp/bash-web-cut-tr-typecheck/oracle/bash",
    version: "GNU bash, version 5.3.15(1)-release (x86_64-pc-linux-gnu)",
    sha256: "575e03ac834b739349a4484de481abcd06a6f7193cefc795260a32a1943f20a5",
  },
  coreutils: {
    touch: {
      path: "/usr/bin/touch",
      version: "touch (GNU coreutils) 9.12",
      sha256: "119b05ac5f9e58eb32fdea66b069989c741645fafddeb11693b8aacc0cf512bb",
    },
    rm: {
      path: "/usr/bin/rm",
      version: "rm (GNU coreutils) 9.12",
      sha256: "1631d459e41a085f49eeb96a69dac08929de5e8beadbcab1477b54680d243466",
    },
    cp: {
      path: "/usr/bin/cp",
      version: "cp (GNU coreutils) 9.12",
      sha256: "3a597f7c21f2922e97bc1607f111ee15d2ed71998570d8a152d1e40aedfa2035",
    },
    mv: {
      path: "/usr/bin/mv",
      version: "mv (GNU coreutils) 9.12",
      sha256: "9c56da09ec48fe2a99436d3128d2e19d542ece9ecbea4b7ec58fa07219848bda",
    },
  },
};
const recordingSha256 = "7b64ee02c7430f2c1534dabd6d424abec48d1efec1329216b6a04904cde32ead";
const contextSha256 = "e2ac923fad1e7ad21182258c4d9a6715049994819071703653bf789092bcff23";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, keys?: string[]): Record<string, unknown> {
  assert.ok(isObject(value), "observation record");
  if (keys) assert.deepEqual(Object.keys(value).sort(), keys.toSorted(), "record keys");
  return value;
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), "observation array");
  return value;
}

function bytes(value: unknown): number[] {
  assert.ok(Array.isArray(value), "observation bytes");
  return value.map((byte: unknown) => {
    assert.ok(
      typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255,
      "observation bytes",
    );
    return byte;
  });
}

function tree(value: unknown): FileTree {
  const entries = Object.entries(record(value));
  const result: FileTree = Object.fromEntries(
    entries.map(([path, content]) => {
      const parts = path.split("/");
      assert.ok(
        parts.every((part) => part !== "" && part !== "." && part !== ".." && !part.includes("\0")),
        "tree path",
      );
      return [path, content === null ? null : bytes(content)];
    }),
  );
  for (const [path] of entries) {
    const separator = path.lastIndexOf("/");
    if (separator < 0) continue;
    assert.equal(result[path.slice(0, separator)], null, "tree parent");
  }
  return result;
}

function observation(value: unknown): Observation {
  const entry = record(value, ["status", "stdout", "stderr", "tree"]);
  const { status, stderr } = entry;
  assert.ok(
    typeof status === "number" && Number.isInteger(status) && status >= 0 && status <= 255,
    "observation status",
  );
  assert.ok(typeof stderr === "boolean", "diagnostic presence");
  return { status, stdout: bytes(entry.stdout), stderr, tree: tree(entry.tree) };
}

function example(value: unknown) {
  const entry = record(value, ["name", "script", "result", "diagnosticBytes"]);
  const { name, script } = entry;
  assert.ok(typeof name === "string" && typeof script === "string", "case identity");
  const diagnosticBytes = bytes(entry.diagnosticBytes);
  const result = observation(entry.result);
  assert.equal(result.stderr, diagnosticBytes.length > 0, "diagnostic presence");
  return { name, script, result, diagnosticBytes };
}

function digest(source: string | Uint8Array) {
  return createHash("sha256").update(source).digest("hex");
}

function readObservations() {
  const source = readFileSync(new URL("../fixtures/file-utilities.json", import.meta.url));
  const value: unknown = JSON.parse(source.toString("utf8"));
  const fixture = record(value, ["schema", "bash", "coreutils", "cases", "runtimeGaps"]);
  assert.equal(fixture.schema, 1, "schema");
  assert.deepEqual(fixture.bash, approvedIdentities.bash, "Bash identity");
  assert.deepEqual(fixture.coreutils, approvedIdentities.coreutils, "GNU identities");
  const cases = array(fixture.cases).map(example);
  const gaps = array(fixture.runtimeGaps).map(example);
  assert.deepEqual(
    cases.map(({ name, script }) => ({ name, script })),
    fileUtilityCases,
    "case identities",
  );
  assert.deepEqual(
    gaps.map(({ name, script }) => ({ name, script })),
    [fileUtilityMetadataGap],
    "runtime gap identities",
  );
  assert.equal(
    digest(JSON.stringify({ environment: fileUtilityEnvironment, initialTree })),
    contextSha256,
    "recording context digest",
  );
  assert.equal(source.byteLength, 17583, "recording byte length");
  assert.equal(digest(source), recordingSha256, "recording digest");
  return cases;
}

const cases = readObservations();
export function fileUtilityObservation(script: string): Observation {
  const entry = cases.find((candidate) => candidate.script === script);
  assert.ok(entry, `Missing frozen file utility observation: ${script}`);
  return structuredClone(entry.result);
}
