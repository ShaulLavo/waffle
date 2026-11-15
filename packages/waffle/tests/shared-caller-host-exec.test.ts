import { expect, test } from "bun:test";
import { sharedCallerExec, type SharedExecMode } from "./fixtures/shared-caller-exec.js";

for (const mode of [
  "replace",
  "unclassified",
  "missing",
  "shebang",
  "registration",
  "filesystem-fence",
  "controller-fence",
  "controller-stop",
  "source-acquisition",
  "target-acquisition",
  "descriptors",
] satisfies SharedExecMode[])
  test(`public Runtime shared caller exec ${mode} joins real native stop`, async () => {
    const result = await sharedCallerExec(mode);
    console.log(JSON.stringify({ sharedCallerExec: result }));
    expect(result.outcome).toBe("PASS");
    expect(result.cleanup).toEqual({
      createdWorkers: 2,
      nativeReturns: 2,
      runtimeDisposed: true,
      debtOwnerRetained: false,
    });
  }, 90000);

for (const mode of [
  "native-failure",
  "filesystem-failure",
  "controller-failure",
  "cleanup-failure",
])
  test(`public Runtime shared caller ${mode} retains debt after the exact cleanup fails`, async () => {
    const control = Bun.spawn(
      [
        process.execPath,
        new URL("./fixtures/shared-caller-debt-control.ts", import.meta.url).pathname,
        mode,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
        timeout: 90000,
        killSignal: "SIGKILL",
      },
    );
    try {
      const [exit, output, errors] = await Promise.all([
        control.exited,
        new Response(control.stdout).text(),
        new Response(control.stderr).text(),
      ]);
      expect({ exit, errors }).toEqual({ exit: 0, errors: "" });
      const result = JSON.parse(output);
      expect(result).toMatchObject({
        mode,
        outcome: "PASS",
        retained: true,
        cleanup: {
          createdWorkers: 2,
          nativeReturns: 2,
          runtimeDisposed: false,
          debtOwnerRetained: true,
        },
      });
      console.log(JSON.stringify({ sharedCallerDebt: result }));
    } finally {
      control.kill();
      await control.exited;
    }
  }, 120000);
