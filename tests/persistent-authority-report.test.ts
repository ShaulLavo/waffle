import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseFileIdentity } from "../fs/file-identity";
import { proofEqual, proofReport, reportJson, type ProofStep } from "./persistent-authority-report";

const identity = {
  birthHistory: "b4b7fc40-2b55-43f8-bf12-43c88f4465cc",
  ino: 3,
  ...parseFileIdentity({ id: "10000000000000004", version: "10000000000000008" }),
};
const freezeIdentity = {
  ...identity,
  ...parseFileIdentity({ id: "10000000000000004", version: "10000000000000006" }),
};

function failedComparison(): Error {
  try {
    proofEqual(identity, freezeIdentity);
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("unequal file versions were accepted");
}

test("equal native bigint identities do not need JSON coercion", () => {
  expect(identity.id).toBe(18446744073709551620n);
  expect(identity.version).toBe(18446744073709551624n);
  expect(freezeIdentity.version).toBe(18446744073709551622n);
  proofEqual({ file: identity }, { file: { ...identity } });
  proofEqual([freezeIdentity], [{ ...freezeIdentity }]);
});

test("unequal native identities retain the exact assertion diagnostic", () => {
  const failure = failedComparison();
  expect(failure).not.toBeInstanceOf(TypeError);
  expect(failure.message).toContain("18446744073709551624");
  expect(failure.message).toContain("18446744073709551622");
  expect(failure.message).toContain("Expected");
  expect(failure.message).toContain("got");
  expect(() => proofEqual(identity, { ...identity, id: identity.id + 1n })).toThrow();
});

const unequal: [unknown, unknown][] = [
  [identity.id, identity.id.toString()],
  [identity.id, Number(identity.id)],
  [identity.id, { valueType: "bigint", value: identity.id.toString() }],
  [undefined, null],
  [undefined, false],
  [false, 0],
  [0, ""],
  [0, -0],
  [NaN, null],
  [{ value: undefined }, {}],
  [[undefined], [null]],
];
test.each(unequal)("comparison distinguishes %p from %p", (actual, expected) => {
  expect(() => proofEqual(actual, expected)).toThrow();
});

test("reporting retains undefined and falsy values without changing comparison semantics", () => {
  const values = {
    absent: undefined,
    nil: null,
    no: false,
    zero: 0,
    empty: "",
    negative: -0,
    nan: NaN,
  };
  expect(JSON.parse(reportJson(values))).toEqual({
    absent: { valueType: "undefined" },
    nil: null,
    no: false,
    zero: 0,
    empty: "",
    negative: { valueType: "negative-zero" },
    nan: { valueType: "nan" },
  });
  expect(JSON.parse(reportJson(undefined))).toEqual({ valueType: "undefined" });
  proofEqual(values, { ...values });
});

for (const { completed, unrun, failedName } of [
  { completed: 9, unrun: 7, failedName: "WASI rename and complete ordered effects" },
  {
    completed: 4,
    unrun: 3,
    failedName: "original owner resumes with one unchanged ordered history",
  },
]) {
  test(`failed native ledger retains ${completed}/1/${unrun} and the original error`, () => {
    const prototype = Object.getOwnPropertyDescriptor(BigInt.prototype, "toJSON");
    const failure = failedComparison();
    const completedSteps: ProofStep[] = Array.from({ length: completed }, (_, index) => ({
      name: `completed ${index}`,
      kind: "completed",
      value: { file: identity },
    }));
    const unrunSteps: ProofStep[] = Array.from({ length: unrun }, (_, index) => ({
      name: `unrun ${index}`,
      kind: "unrun",
    }));
    const steps = completedSteps.concat(
      [{ name: failedName, kind: "failed", failure: String(failure) }],
      unrunSteps,
    );
    const report = proofReport(
      { failure, changes: [{ file: identity }], cleanup: "retired" },
      steps,
    );
    const compact = JSON.parse(reportJson(report));
    expect(compact).toEqual(JSON.parse(reportJson(report, 2)));
    expect(compact.counts).toEqual({ completed, failed: 1, unrun });
    expect(compact.steps).toHaveLength(completed + 1 + unrun);
    expect(compact.steps[completed]).toEqual({
      name: failedName,
      kind: "failed",
      failure: String(failure),
    });
    expect(compact.steps.slice(completed + 1)).toEqual(unrunSteps);
    expect(compact.changes[0].file).toEqual({
      birthHistory: identity.birthHistory,
      ino: 3,
      id: { valueType: "bigint", value: "18446744073709551620" },
      version: { valueType: "bigint", value: "18446744073709551624" },
    });
    expect(compact.failure).toMatchObject({
      valueType: "error",
      name: failure.name,
      message: failure.message,
      stack: failure.stack,
    });
    expect(report.steps).toBe(steps);
    expect(identity.id).toBe(18446744073709551620n);
    expect(Object.getOwnPropertyDescriptor(BigInt.prototype, "toJSON")).toEqual(prototype);
  });
}

for (const { runner, variable, total } of [
  { runner: "persistent-authority-browser-runner.ts", variable: "PERSISTENT_AUTHORITY", total: 17 },
  { runner: "owner-freeze-browser-runner.ts", variable: "OWNER_FREEZE", total: 8 },
]) {
  test(`${runner} emits a complete report and still exits on the original failure`, async () => {
    const root = await mkdtemp(resolve(tmpdir(), "proof-report-"));
    try {
      const path = resolve(root, "report.json");
      const child = Bun.spawn([process.execPath, resolve(import.meta.dir, runner)], {
        env: {
          ...process.env,
          STORAGE_SCRATCH_ROOT: root,
          [`${variable}_PORT`]: "1",
          [`${variable}_REPORT`]: path,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exit).not.toBe(0);
      const report = await Bun.file(path).json();
      expect(report).toEqual(JSON.parse(stdout.trim()));
      expect(report.counts).toEqual({ completed: 0, failed: 0, unrun: total });
      expect(report.steps).toHaveLength(total);
      expect(report.steps.every((step: ProofStep) => step.kind === "unrun")).toBe(true);
      expect(report.failure).toMatchObject({ valueType: "error", name: "Error" });
      expect(report.failure.message).toContain(`explicit free ${variable}_PORT`);
      expect(stderr).toContain(report.failure.message);
      expect(await readdir(root)).toEqual(["report.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
