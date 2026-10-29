import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export interface JavaScriptExceptions {
  readonly generatedOutput?: readonly string[];
  readonly testInputs?: readonly string[];
}

const javascriptPath = /\.(?:js|mjs|cjs)$/;

export function findHandwrittenJavaScript(
  paths: readonly string[],
  exceptions: JavaScriptExceptions = {},
): string[] {
  const allowed = new Set((exceptions.generatedOutput ?? []).concat(exceptions.testInputs ?? []));
  return paths.filter((path) => javascriptPath.test(path) && !allowed.has(path));
}

if (import.meta.main) {
  const repository = resolve(import.meta.dir, "../../..");
  const output = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "*.js",
      "*.mjs",
      "*.cjs",
    ],
    { cwd: repository, encoding: "utf8" },
  );
  const forbidden = findHandwrittenJavaScript(output.split("\0").filter((path) => path.length > 0));
  if (forbidden.length > 0) {
    console.error(
      `Handwritten JavaScript is not allowed. Convert these files to TypeScript:\n${forbidden
        .map((path) => `- ${path}`)
        .join("\n")}`,
    );
    process.exitCode = 1;
  } else {
    console.log("TypeScript-only source check passed");
  }
}
