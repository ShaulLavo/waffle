import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function signalControl(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  const root = await mkdtemp(join(process.env.NETWORK_SCRATCH_ROOT ?? tmpdir(), "s-"));
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "network-signal-control.ts"), root],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 40_000);
  const reader = child.stdout.getReader();
  let output = "";
  async function until(text: string): Promise<void> {
    while (!output.includes(text)) {
      const next = await reader.read();
      if (next.done)
        throw new Error(
          `Signal child exited before ${text}: ${output}\n${await new Response(child.stderr).text()}`,
        );
      output += new TextDecoder().decode(next.value);
    }
  }
  try {
    await until("callback-entered");
    child.kill(signal);
    await until("callback-aborted");
    await Bun.sleep(200);
    assert.equal(child.exitCode, null, "Process returned before callback release");
    child.stdin.write("release\n");
    child.stdin.end();
    await until("result-saved");
    const code = await child.exited;
    assert.notEqual(code, 0);
    const result = JSON.parse(await readFile(join(root, "result.json"), "utf8"));
    assert.notEqual(result.exit, 0);
    assert.equal(result.cleanup.callbacks.status, "confirmed");
    assert.equal(result.cleanup.fixture.status, "confirmed");
    assert.ok(output.indexOf("callback-joined") < output.indexOf("fixture-closed"));
    assert.ok(output.indexOf("fixture-closed") < output.indexOf("result-saved"));
    assert.equal(output.match(/fixture-closed/g)?.length, 1);
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await rm(root, { recursive: true, force: true });
  }
}
