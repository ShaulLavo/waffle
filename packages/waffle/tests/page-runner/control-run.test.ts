import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const signal of ["SIGTERM", "SIGINT"])
  test(`a negative control cannot accept unrelated outer ${signal}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "control-signal-"));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await writeFile(
        join(root, "probe.ts"),
        `import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { ControlRun } from ${JSON.stringify(join(import.meta.dir, "control-run.ts"))};
const controls=new ControlRun();
let admitted=false;
try {
  await controls.check("cpu", "negative", async () => {
    const received=Promise.withResolvers<void>();
    process.once(${JSON.stringify(signal)}, () => received.resolve());
    process.kill(process.pid, ${JSON.stringify(signal)});
    await received.promise;
  });
  writeFileSync(${JSON.stringify(join(root, "result.json"))}, JSON.stringify(controls.results));
  assert.equal(controls.results[0]?.status, "fail");
  await assert.rejects(controls.check("cpu", "later", async () => { admitted=true; }), /interrupted/);
  assert.equal(admitted, false);
  assert.throws(() => controls.throwIfInterrupted(), /interrupted/);
} finally { controls.close(); }
assert.equal(process.listenerCount(${JSON.stringify(signal)}), 0);
`,
      );
      const launched = Bun.spawn([process.execPath, join(root, "probe.ts")], {
        stdout: "pipe",
        stderr: "pipe",
      });
      child = launched;
      const [code, stdout, stderr] = await Promise.all([
        launched.exited,
        new Response(launched.stdout).text(),
        new Response(launched.stderr).text(),
      ]);
      expect(code, stdout + stderr).toBe(0);
      expect(JSON.parse(await readFile(join(root, "result.json"), "utf8"))).toMatchObject([
        { engine: "cpu", control: "negative", status: "fail" },
      ]);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
      await child?.exited;
      await rm(root, { recursive: true, force: true });
    }
  });

test("ordinary negative verdicts remain independent without changing the process exit code", async () => {
  const { ControlRun } = await import("./control-run.js");
  const exitCode = process.exitCode;
  const controls = new ControlRun();
  try {
    await controls.check("cpu", "pass", async () => {});
    await controls.check("cpu", "failure", async () => {
      throw new Error("REAL_CONTROL_FAILURE");
    });
    await controls.check("cpu", "later", async () => {});
    expect(controls.results).toEqual([
      { engine: "cpu", control: "pass", status: "pass" },
      { engine: "cpu", control: "failure", status: "fail", error: "Error: REAL_CONTROL_FAILURE" },
      { engine: "cpu", control: "later", status: "pass" },
    ]);
    expect(process.exitCode).toBe(exitCode);
  } finally {
    controls.close();
  }
});
