import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  FamilyAcceptanceSession,
  LaunchRequest,
} from "../../../../tools/family-acceptance.ts";
import { checksumNames, type ChecksumName } from "../../scripts/build-checksums.ts";

const environment = { PATH: "/usr/bin:/bin", HOME: "/tmp/spec", LC_ALL: "C", TZ: "UTC" };
const data = "Waffle checksum\n";
const digest = "c19ca03d5d5604003f0b0b827060d88006cf6a597a7b1cb5787b166e5b9633f2";
const files = new Map([
  ["input", data],
  ["expected", `${digest}  input\n`],
  ["stdin-expected", `${digest}  -\n`],
  ["mismatch", `${"0".repeat(64)}  input\n`],
  ["back\\slash", data],
  ["line\nbreak", data],
  ["literal\\n", data],
  ["double\\\\slash", data],
]);

interface Invocation {
  readonly utility: ChecksumName;
  readonly args: readonly string[];
  readonly input?: Uint8Array | string;
  readonly close?: 0 | 1;
}

function native(root: string, invocation: Invocation) {
  const command = `/usr/bin/${invocation.utility}`;
  const options = { cwd: root, env: environment, input: invocation.input ?? "", timeout: 5000 };
  const result =
    invocation.close === undefined
      ? spawnSync(command, invocation.args, options)
      : spawnSync(
          "/bin/sh",
          [
            "-c",
            `exec ${invocation.close}${invocation.close === 0 ? "<&-" : ">&-"}; exec "$@"`,
            "checksum-control",
            command,
          ].concat(invocation.args),
          options,
        );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.notEqual(result.status, null);
  return {
    status: result.status,
    stdout: new Uint8Array(result.stdout),
    stderr: result.stderr.length > 0,
  };
}

async function guest(session: FamilyAcceptanceSession, invocation: Invocation) {
  const stdin = session.filledPipe(invocation.input ?? "");
  const request: LaunchRequest = {
    executable: `/usr/bin/${invocation.utility}`,
    argv: ["unrelated-executable-name"].concat(invocation.args),
    cwd: "/work/checksum-regressions",
    env: { ...environment, PWD: "/work/checksum-regressions" },
    fds: [0, 1, 2]
      .filter((fd) => fd !== invocation.close)
      .map((fd) => ({ child: fd, parent: fd === 0 ? stdin : fd })),
  };
  try {
    const result = await session.exec(request);
    assert.equal(result.exit.kind, "exited");
    return { status: result.exit.status, stdout: result.stdout, stderr: result.stderr.length > 0 };
  } finally {
    session.descriptors.close(stdin);
  }
}

async function compare(session: FamilyAcceptanceSession, root: string, invocation: Invocation) {
  const expected = native(root, invocation);
  const actual = await guest(session, invocation);
  assert.deepEqual(actual, expected, JSON.stringify(invocation));
  return actual;
}

function descriptorCases(): Invocation[] {
  const cases: Invocation[] = [];
  for (const utility of checksumNames) {
    cases.push(
      { utility, args: [], close: 0 },
      { utility, args: ["input"], close: 0 },
      { utility, args: ["input"], close: 1 },
    );
  }
  return cases.concat([
    { utility: "sha256sum", args: ["--zero", "input"], close: 1 },
    { utility: "sha256sum", args: ["--check", "expected"], close: 1 },
    { utility: "sha256sum", args: ["--check", "expected"], close: 0 },
    { utility: "sha256sum", args: ["--check", "-"], close: 0 },
    { utility: "sha256sum", args: ["--check", "stdin-expected"], close: 0 },
    { utility: "sha256sum", args: ["--check", "--status", "expected"], close: 1 },
    { utility: "sha256sum", args: ["--check", "--quiet", "expected"], close: 1 },
    { utility: "sha256sum", args: ["--check", "--status", "mismatch"], close: 1 },
    { utility: "sha256sum", args: ["--check", "--quiet", "mismatch"], close: 1 },
    { utility: "sha256sum", args: ["--help"], close: 0 },
    { utility: "cksum", args: ["--algorithm=sha256", "--raw", "input"], close: 1 },
  ]);
}

function generationCases(utility: ChecksumName): Invocation[] {
  const algorithm = utility === "cksum" ? ["--algorithm=sha256"] : [];
  const untagged = utility === "cksum" ? algorithm.concat(["--untagged"]) : algorithm;
  return ["back\\slash", "line\nbreak", "literal\\n", "double\\\\slash"]
    .map((name) => ({ utility, args: untagged.concat([name]) }))
    .concat(
      ["back\\slash", "line\nbreak"].map((name) => ({
        utility,
        args: algorithm.concat(["--tag", name]),
      })),
    );
}

async function roundtrips(session: FamilyAcceptanceSession, root: string) {
  let count = 0;
  const utilities = checksumNames.filter((name) => name !== "sum");
  for (const utility of utilities) {
    for (const invocation of generationCases(utility)) {
      const generated = await compare(session, root, invocation);
      assert.equal(generated.status, 0);
      await compare(session, root, { utility, args: ["--check", "-"], input: generated.stdout });
      count += 2;
    }
  }
  return count;
}

export async function checksumRegressions(session: FamilyAcceptanceSession) {
  const parent = resolve(import.meta.dirname, "../../../../.build");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(resolve(parent, "checksum-regressions-"));
  try {
    await session.filesystem.mkdirp("/work/checksum-regressions");
    for (const [name, content] of files) {
      writeFileSync(resolve(root, name), content);
      await session.filesystem.writeFile(`/work/checksum-regressions/${name}`, content);
    }
    const cases = descriptorCases();
    for (const invocation of cases) await compare(session, root, invocation);
    const count = await roundtrips(session, root);
    console.log(
      `Passed ${cases.length + count} checksum selected-I/O and escaped-record regression observations`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
