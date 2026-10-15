// Shared helpers for the playwright scripts that drive the playground (browser-engine.mjs,
// bench-engines.mjs): start web/serve.ts and a CORS fixture server, run shell commands through
// `playground` (main.ts), read the terminal, and kill everything that was started.
// PLAYWRIGHT=<path to playwright/index.mjs> overrides the default mise install.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const web = join(new URL(".", import.meta.url).pathname, "..");
const playwrightPath =
  process.env.PLAYWRIGHT ??
  `${process.env.HOME}/.local/share/mise/installs/npm-playwright/1.63.0/node_modules/.mise/playwright@1.63.0/node_modules/playwright/index.mjs`;
export const playwright = await import(playwrightPath);

/** Children, browsers and a scratch directory, all removed by `cleanup` (also on SIGINT/SIGTERM). */
export function session(prefix) {
  const scratch = mkdtempSync(`/work/tmp/${prefix}`);
  const children = [];
  const browsers = [];
  let cleaned = false;
  async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    for (const b of browsers) await b.close().catch(() => {});
    for (const c of children) c.kill("SIGKILL");
    rmSync(scratch, { recursive: true, force: true });
  }
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => void cleanup().then(() => process.exit(130)));
  // A crash (e.g. EPIPE when piped into `head`) skips cleanup(): still kill the servers and drop the scratch.
  process.on("exit", () => {
    for (const c of children) c.kill("SIGKILL");
    rmSync(scratch, { recursive: true, force: true });
  });

  /** Spawns `bun <args>` in web/ and resolves with the first stdout match of `re`. */
  function start(args, re, env = {}) {
    const child = spawn("bun", args, { cwd: web, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "inherit"] });
    children.push(child);
    return new Promise((resolve, reject) => {
      let out = "";
      child.stdout.on("data", (d) => {
        out += d;
        const m = re.exec(out);
        if (m) resolve(m);
      });
      child.on("exit", (code) => reject(new Error(`bun ${args.join(" ")} exited ${code}: ${out}`)));
    });
  }

  /** web/serve.ts on a free port; returns the page URL (http://127.0.0.1:<port>/). */
  async function serve() {
    const [, url] = await start(["serve.ts"], /at (http:\/\/\S+) \(cross-origin isolated\)/, { PORT: "0" });
    return url;
  }

  /** A CORS-enabled fixture server on another origin; returns its base URL. */
  async function fixture() {
    const file = join(scratch, "fixture.ts");
    writeFileSync(file, FIXTURE);
    const [, port] = await start([file], /port (\d+)/);
    return `http://127.0.0.1:${port}`;
  }

  async function launch(type) {
    const browser = await type.launch();
    browsers.push(browser);
    return browser;
  }

  return { scratch, cleanup, start, serve, fixture, launch };
}

const FIXTURE = `
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "*",
  "access-control-expose-headers": "*",
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/nocors") return new Response("secret");
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const reply = (res) => {
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    };
    if (url.pathname === "/json") return reply(Response.json({ ok: true, list: [1, 2, 3] }));
    if (url.pathname === "/echo") return reply(Response.json({ method: req.method, test: req.headers.get("x-test"), body: await req.text() }));
    return reply(new Response("not found", { status: 404 }));
  },
});
console.log("port", server.port);
`;

/** Waits until the page has loaded and compiled its wasm; returns the status line. */
export async function ready(page, ms = 120000) {
  await page.waitForFunction(() => /ready|missing|failed/.test(document.querySelector("#status")?.textContent ?? ""), null, { timeout: ms });
  return page.textContent("#status");
}

export async function terminalText(page) {
  return page.evaluate(async () => {
    // xterm parses writes asynchronously; the write callback runs once everything before it is in the buffer.
    await new Promise((r) => globalThis.playground.term.write("", r));
    const buf = globalThis.playground.term.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      const text = line?.translateToString(true) ?? "";
      // Soft-wrapped rows continue the previous line.
      if (line?.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
      else lines.push(text);
    }
    // Rows below the cursor are empty until written.
    return lines.join("\n").trimEnd();
  });
}

export async function writeFile(page, path, text) {
  await page.evaluate(([p, t]) => globalThis.playground.fs.writeFile(p, t), [path, text]);
}

/**
 * Types `command` at the prompt and waits for it to finish. Returns its exit code, the terminal
 * output it produced (prompt line excluded) and its wall time in ms; `code` is null on timeout
 * (the program is then stopped with Ctrl-C).
 */
export async function run(page, command, ms = 60000) {
  const before = (await terminalText(page)).split("\n").length;
  const result = await page.evaluate(
    async ([cmd, timeout]) => {
      const { shell } = globalThis.playground;
      const t0 = performance.now();
      const done = shell.submit(cmd).then(() => shell.lastExit);
      const code = await Promise.race([done, new Promise((r) => setTimeout(() => r(null), timeout))]);
      const ms = performance.now() - t0;
      // On timeout, Ctrl-C the program so the shell takes the next command.
      if (code === null) {
        shell.input("\x03");
        await done;
      }
      return { code, ms };
    },
    [command, ms],
  );
  const lines = (await terminalText(page)).split("\n");
  // The command's own prompt line is before[-1]; the new prompt is the last line.
  const output = lines.slice(before, -1).join("\n");
  return { ...result, output };
}

/** Clicks Run on `path` (opened in the editor) and measures click-to-exit wall time in the page. */
export async function clickRun(page, path, ms = 60000) {
  return page.evaluate(
    async ([p, timeout]) => {
      const { shell, editor } = globalThis.playground;
      editor.open(p);
      const button = document.querySelector("#run");
      const t0 = performance.now();
      button.click();
      // runCurrent() marks the shell busy synchronously after saving; wait for it to go idle.
      while (!shell.running && performance.now() - t0 < 1000) await new Promise((r) => setTimeout(r, 0));
      while (shell.running && performance.now() - t0 < timeout) await new Promise((r) => setTimeout(r, 1));
      return { ms: performance.now() - t0, code: shell.running ? null : shell.lastExit };
    },
    [path, ms],
  );
}
