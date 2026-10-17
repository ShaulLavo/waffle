// Run once per freshly rebuilt engine: node web/tests/node-root-signals.ts /absolute/bun.wasm
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const wasm = process.argv[2];
assert.ok(wasm, "provide the freshly built guest WASM path");
const host = fileURLToPath(new URL("../scripts/node-host.mjs", import.meta.url));
const active = new Set<() => void>();
for (const [name, number] of [["SIGINT", 2], ["SIGTERM", 15]] as const) process.once(name, () => {
  for (const cleanup of active) cleanup();
  process.exit(128 + number);
});

async function check(signal: "SIGINT" | "SIGTERM" | "SIGPIPE", mode: "handled" | "default" | "removed" | "once" | "caught-self", code = 0) {
  const source = `
    const handler = () => ${mode === "once" ? 'console.log("handled")' : `process.exit(${code})`};
    ${mode === "default" || mode === "caught-self" ? "" : `process.${mode === "once" ? "once" : "on"}(${JSON.stringify(signal)}, handler);`}
    ${mode === "removed" ? `process.off(${JSON.stringify(signal)}, handler);` : ""}
    // Default signal death must not depend on buffered console output flushing.
    process.stdout.write("ready\\n");
    ${mode === "caught-self" ? `
      try { process.kill(process.pid, ${JSON.stringify(signal)}); } catch {}
      process.stdout.write("forbidden post-default I/O\\n");
      for (;;) {}
    ` : 'setInterval(() => {}, 1000);'}
  `;
  const child = spawn(process.execPath, [host, "--wasm", wasm!, "--", "-e", source], {
    stdio: ["ignore", "pipe", "pipe"], detached: true,
    env: Object.assign({}, process.env, { NODE_NO_WARNINGS: "1" }),
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const exited = once(child, "close");
  const failures = once(child, "error").then(([error]) => { throw error; });
  // Own and stop the entire new process group even on assertion failure or timeout.
  const cleanup = () => {
    if (child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  };
  active.add(cleanup);
  let expired = false;
  const timer = setTimeout(() => { expired = true; cleanup(); }, 10_000);
  async function line(text: string) {
    while (!stdout.includes(text + "\n")) {
      assert.equal(expired, false, `root ${mode} ${signal} timed out; stdout=${stdout}; stderr=${stderr}`);
      assert.equal(child.exitCode, null, `root exited before ${text}; stderr=${stderr}`);
      assert.equal(child.signalCode, null, `root died before ${text}; stderr=${stderr}`);
      await Promise.race([once(child.stdout, "data"), exited.then(() => {}), failures]);
    }
  }
  try {
    await line("ready");
    if (mode !== "caught-self") assert.equal(child.kill(signal), true);
    if (mode === "once") {
      await line("handled");
      assert.equal(child.kill(signal), true);
    }
    const [status, selectedSignal] = await Promise.race([exited, failures]);
    assert.equal(expired, false, `root ${mode} ${signal} timed out`);
    const expected = mode === "handled" ? code : 128 + { SIGINT: 2, SIGTERM: 15, SIGPIPE: 13 }[signal];
    assert.equal(status, expected, stderr);
    // The Node launcher adopts the guest's typed outcome and exits with its wait status.
    assert.equal(selectedSignal, null);
    assert.equal(stderr, "");
    if (mode === "caught-self") assert.equal(stdout, "ready\n");
    console.log("Node root", mode, signal, status);
  } finally {
    clearTimeout(timer);
    cleanup();
    await exited;
    child.stdout.destroy();
    child.stderr.destroy();
    active.delete(cleanup);
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGPIPE"] as const) {
  await check(signal, "handled");
  await check(signal, "default");
  await check(signal, "removed");
  await check(signal, "caught-self");
}
await check("SIGTERM", "handled", 23);
await check("SIGTERM", "handled", 143);
await check("SIGINT", "once");
console.log("Node root signal groups", 15);
