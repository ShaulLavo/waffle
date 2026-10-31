import { expect, test } from "bun:test";

async function observedProbe(fixture: URL, outcome: string): Promise<void> {
  const child = Bun.spawn(
    [
      process.execPath,
      new URL("./fixtures/memory-probe-lifecycle-control.ts", import.meta.url).pathname,
      fixture.href,
      outcome,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  try {
    const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
  } finally {
    child.kill();
    await child.exited;
  }
}
test("successful memory measurement releases probe message and error handlers", async () => {
  await observedProbe(
    new URL("./fixtures/memory-probe-result-worker.ts", import.meta.url),
    "success",
  );
});
test("invalid memory measurement releases probe message and error handlers", async () => {
  await observedProbe(
    new URL("./fixtures/memory-probe-invalid-worker.ts", import.meta.url),
    "Invalid shared-memory probe capacity",
  );
});
test("failed memory measurement releases probe message and error handlers", async () => {
  await observedProbe(
    new URL("./fixtures/memory-probe-error-worker.ts", import.meta.url),
    "probe lifecycle failure",
  );
});
