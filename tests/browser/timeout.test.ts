import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = new URL("../../scripts/run-with-timeout.mts", import.meta.url).pathname;
for (const code of [0, 23]) {
  test(`portable command deadline preserves exit ${code}`, () => {
    const result = spawnSync("node", [script, "5", "node", "-e", `process.exit(${code})`], { encoding: "utf8", timeout: 10000 });
    expect(result.status).toBe(code);
    expect(result.stderr).toBe("");
  });
}
for (const [error, code] of [["ENOENT", 127], ["EACCES", 126]] as const) {
  test(`portable command deadline preserves spawn ${error}`, () => {
    const scratch = mkdtempSync(join(tmpdir(), "bun-wasm-timeout-"));
    try {
      const command = join(scratch, "command");
      if (error === "EACCES") writeFileSync(command, "not executable", { mode: 0o644 });
      const result = spawnSync("node", [script, "5", command], { encoding: "utf8", timeout: 10000 });
      expect(result.status).toBe(code);
      expect(result.stderr).toContain(error);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  });
}
for (const [signal, code] of [["SIGTERM", 143], ["SIGKILL", 137]] as const) {
  test(`portable command deadline preserves child ${signal}`, () => {
    const result = spawnSync("node", [script, "5", "node", "-e", `process.kill(process.pid, ${JSON.stringify(signal)})`], { encoding: "utf8", timeout: 10000 });
    expect(result.status).toBe(code);
    expect(result.stderr).toBe("");
  });
}
test("portable command deadline kills an overlong command", () => {
  const result = spawnSync("node", [script, "0.1", "node", "-e", "setInterval(() => {}, 1000)"], { encoding: "utf8", timeout: 10000 });
  expect(result.status).toBe(124);
});

for (const mode of ["normal", "deadline", "interruption"]) {
  test(`portable command ${mode} cleans up descendants`, async () => {
    const descendant = 'console.log("descendant", process.pid); setInterval(() => {}, 1000);';
    const command = `
      const { spawn } = require("node:child_process");
      console.log("command", process.pid);
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "pipe", "inherit"] });
      child.stdout.on("data", data => process.stdout.write(data, () => { if (${JSON.stringify(mode)} === "normal") process.exit(0); }));
      setInterval(() => {}, 1000);
    `;
    const wrapper = spawn("node", [script, mode === "deadline" ? "1" : "10", "node", "-e", command], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", stderr = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const closed = new Promise<number | null>((resolve, reject) => {
        wrapper.once("error", reject);
        wrapper.once("close", resolve);
      });
      const ready = new Promise<void>((resolve, reject) => {
        wrapper.stdout.on("data", data => { output += data; if (/descendant \d+/.test(output)) resolve(); });
        wrapper.stderr.on("data", data => { stderr += data; });
        wrapper.once("close", () => { if (!/descendant \d+/.test(output)) reject(new Error(`command exited before readiness: ${output} ${stderr}`)); });
      });
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`wrapper did not clean up: ${output} ${stderr}`)), 5000); });
      await Promise.race([ready, deadline]);
      if (mode === "interruption") wrapper.kill("SIGTERM");
      expect(await Promise.race([closed, deadline])).toBe(mode === "normal" ? 0 : mode === "deadline" ? 124 : 143);
      expect(stderr).toBe("");
      const pid = Number(/descendant (\d+)/.exec(output)![1]);
      const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
      // A killed orphan can briefly remain as a zombie until the OS reaps it.
      expect(state === "" || state.startsWith("Z")).toBe(true);
    } finally {
      clearTimeout(timer);
      wrapper.kill("SIGKILL");
      // Also own teardown when testing a broken wrapper, rather than leak its tree.
      const group = /command (\d+)/.exec(output)?.[1];
      if (group) {
        try { process.kill(-Number(group), "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    }
  }, 10000);
}
