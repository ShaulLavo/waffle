// Run once per freshly rebuilt engine: node web/tests/node-root-signals.ts /absolute/bun.wasm
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const wasm = process.argv[2];
assert.ok(wasm, "provide the freshly built guest WASM path");
const host = fileURLToPath(new URL("../scripts/node-host.mjs", import.meta.url));
const active = new Set<() => void>();
for (const [name, number] of [["SIGINT", 2], ["SIGTERM", 15]] as const) process.once(name, () => {
  for (const cleanup of active) cleanup();
  process.exit(128 + number);
});

async function check(signal: "SIGINT" | "SIGTERM" | "SIGPIPE", mode: "handled" | "default" | "removed" | "once" | "caught-self" | "preview1", code = 0, guestWasm = wasm!) {
  const ignored = signal === "SIGPIPE" && (mode === "default" || mode === "caught-self");
  const source = `
    const handler = () => ${mode === "once" ? 'console.log("handled")' : `process.exit(${code})`};
    ${mode === "default" || mode === "caught-self" ? "" : `process.${mode === "once" ? "once" : "on"}(${JSON.stringify(signal)}, handler);`}
    ${mode === "removed" ? `process.off(${JSON.stringify(signal)}, handler);` : ""}
    ${ignored && mode !== "caught-self" ? `
      process.on("SIGTERM", () => {
        // Also check the initial ignored disposition synchronously.
        process.kill(process.pid, "SIGPIPE");
        process.stdout.write("ignored\\n");
        process.exit(17);
      });
    ` : ""}
    // Default signal death must not depend on buffered console output flushing.
    process.stdout.write("ready\\n");
    ${mode === "caught-self" ? `
      try { process.kill(process.pid, ${JSON.stringify(signal)}); } catch {}
      ${ignored ? 'process.stdout.write("ignored\\n"); process.exit(17);' : 'process.stdout.write("forbidden post-default I/O\\n"); for (;;) {}'}
    ` : 'setInterval(() => {}, 1000);'}
  `;
  const child = spawn(process.execPath, [host, "--wasm", guestWasm, "--", "-e", source], {
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
    // An ignored signal must leave a live guest that can handle a separate control signal.
    // Avoid fixed-lifetime children: they can exit before the signal under test is sent.
    if (ignored && mode !== "caught-self") assert.equal(child.kill("SIGTERM"), true);
    const [status, selectedSignal] = await Promise.race([exited, failures]);
    assert.equal(expired, false, `root ${mode} ${signal} timed out`);
    const expected = ignored ? 17 : mode === "handled" ? code : 128 + { SIGINT: 2, SIGTERM: 15, SIGPIPE: 13 }[signal];
    assert.equal(status, expected, stderr);
    // The Node launcher adopts the guest's typed outcome and exits with its wait status.
    assert.equal(selectedSignal, null);
    assert.equal(stderr, "");
    if (ignored) assert.equal(stdout, "ready\nignored\n");
    else if (mode === "caught-self") assert.equal(stdout, "ready\n");
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

async function checkPreview1() {
  // Original minimal preview1 module: fd_write(1, ready), then a CPU loop. It has no
  // Bun exports or runtime imports, so it must retain DEFAULT rather than JS's IGNORE.
  const name = (value: string) => { const bytes = Array.from(new TextEncoder().encode(value)); return [bytes.length].concat(bytes); };
  const section = (id: number, bytes: number[]) => [id, bytes.length].concat(bytes);
  const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0].concat(
    section(1, [2, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f, 0x60, 0, 0]),
    section(2, [1].concat(name("wasi_snapshot_preview1"), name("fd_write"), [0, 0])),
    section(3, [1, 1]), section(5, [1, 0, 1]),
    section(7, [2].concat(name("memory"), [2, 0], name("_start"), [0, 1])),
    section(10, [1, 18, 0, 0x41, 1, 0x41, 0, 0x41, 1, 0x41, 24, 0x10, 0, 0x1a, 0x03, 0x40, 0x0c, 0, 0x0b, 0x0b]),
    section(11, [1, 0, 0x41, 0, 0x0b, 14, 8, 0, 0, 0, 6, 0, 0, 0].concat(Array.from(new TextEncoder().encode("ready\n")))),
  ));
  assert.ok(WebAssembly.validate(bytes), "preview1 SIGPIPE fixture must validate");
  const directory = mkdtempSync("/work/tmp/bun-wasm-node-root-signals-");
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  process.once("exit", cleanup);
  try {
    const path = join(directory, "default.wasm");
    writeFileSync(path, bytes);
    await check("SIGPIPE", "preview1", 0, path);
  } finally {
    cleanup();
    process.off("exit", cleanup);
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
await check("SIGPIPE", "once");
await checkPreview1();
console.log("Node root signal groups", 17);
