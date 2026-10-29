import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { engines, runIsolatedPages } from "./isolated-page-runner.js";

const fixture = mkdtempSync("/work/tmp/wsearch-oracle-");
const vectors: {
  tool: "rg" | "grep";
  argv: string[];
  env: Record<string, string>;
  expected: { stdout: string; stderr: string; status: number };
}[] = [];
function oracle(
  tool: "rg" | "grep",
  argv: string[],
  expected?: { stdout: string; stderr: string; status: number },
) {
  if (expected) {
    vectors.push({ tool, argv, env: { LC_ALL: "C" }, expected });
    return;
  }
  try {
    const stdout = execFileSync(tool, argv, {
      cwd: fixture,
      env: { ...process.env, LC_ALL: "C" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    vectors.push({ tool, argv, env: { LC_ALL: "C" }, expected: { stdout, stderr: "", status: 0 } });
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("stdout" in error) ||
      !("stderr" in error) ||
      !("status" in error)
    )
      throw error;
    vectors.push({
      tool,
      argv,
      env: { LC_ALL: "C" },
      expected: {
        stdout: String(error.stdout),
        stderr: String(error.stderr),
        status: Number(error.status),
      },
    });
  }
}
try {
  mkdirSync(`${fixture}/sub`);
  mkdirSync(`${fixture}/skip`);
  const files = {
    "a.txt": "needle\nOther Needle\nlast needle",
    "empty.txt": "",
    "plain.txt": "absent\n",
    "sub/b.txt": "needle\n",
    "skip/c.txt": "needle\n",
    ".hidden.txt": "needle\n",
  };
  for (const [path, text] of Object.entries(files)) writeFileSync(`${fixture}/${path}`, text);
  symlinkSync("a.txt", `${fixture}/file-link`);
  symlinkSync("sub", `${fixture}/dir-link`);
  const rg = ["--color", "never", "--no-ignore", "--hidden", "--text"];
  oracle("rg", rg.concat(["-c", "-F", "needle", "."]));
  oracle("rg", rg.concat(["-l", "-F", "needle", "."]));
  oracle("rg", rg.concat(["-c", "-F", "no_match", "."]));
  oracle("rg", rg.concat(["-c", "-H", "-F", "needle", "file-link"]));
  oracle("rg", rg.concat(["-c", "-H", "-F", "needle", "missing"]));
  oracle("rg", ["-F", "needle", "a.txt"]);
  oracle("grep", ["-r", "-a", "-c", "-F", "needle", "."]);
  oracle("grep", ["-r", "-a", "-l", "-F", "needle", "."]);
  oracle("grep", ["-r", "-a", "-c", "-F", "no_match", "."]);
  oracle("grep", ["-r", "-a", "-n", "-H", "-F", "needle", "file-link"]);
  oracle("grep", ["-r", "-a", "-c", "-H", "-F", "needle", "missing"]);
  oracle("grep", ["-F", "needle", "a.txt"]);
  await runIsolatedPages({
    label: "search-program-browser",
    scratchRoot: resolve(process.env.SEARCH_SCRATCH_ROOT ?? "/work/tmp"),
    scratchPrefix: "wsprog-",
    port: 0,
    sources: {
      "/tests.js": "search-program-browser.ts",
      "/search-worker.js": "../search/search-worker.ts",
      "/shard-worker.js": "../search/shard-worker.ts",
      "/fs-worker.js": "../browser/fs-worker.ts",
      "/preview1-worker.js": "../browser/preview1-worker.ts",
    },
    route(path, headers) {
      if (path === "/vectors.json") return Response.json(vectors, { headers });
      const guest = path.endsWith("/rg.wasm")
        ? process.env.SEARCH_RG_WASM
        : path.endsWith("/grep.wasm")
          ? process.env.SEARCH_GREP_WASM
          : undefined;
      return guest
        ? new Response(Bun.file(guest), {
            headers: { ...headers, "Content-Type": "application/wasm" },
          })
        : undefined;
    },
    names: process.argv.length > 2 ? process.argv.slice(2) : Object.keys(engines),
    evaluate: (page) =>
      page.evaluate(async () => {
        const path = "/tests.js";
        const fixture: typeof import("./search-program-browser.js") = await import(path);
        return fixture.searchProgramBrowserCases();
      }),
  });
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
