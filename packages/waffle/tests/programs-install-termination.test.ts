import { expect, test } from "bun:test";

const fixture = new URL("./programs-install-termination-debt.ts", import.meta.url);
const scenarios = [
  "sync-waiting",
  "async-waiting",
  "sync-later",
  "async-later",
  "sync-second",
  "async-second",
  "success",
];

async function runChild(scenario: string) {
  const child = Bun.spawn([process.execPath, fixture.pathname, scenario], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const stop = () => {
    if (child.exitCode === null) child.kill("SIGKILL");
  };
  const interrupt = () => {
    stop();
    void child.exited.then(() => process.exit(130));
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const deadline = setTimeout(stop, 5_000);
  try {
    const code = await child.exited;
    return { code, stdout: await stdout, stderr: await stderr };
  } finally {
    clearTimeout(deadline);
    stop();
    await child.exited;
    await Promise.all([stdout, stderr]);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    console.log(`termination child ${scenario} joined ${child.pid}`);
  }
}

for (const scenario of scenarios) {
  test(`package physical termination ${scenario}`, async () => {
    const result = await runChild(scenario);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(`termination debt ${scenario} passed\n`);
  }, 10_000);
}
