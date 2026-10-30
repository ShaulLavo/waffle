import { execFile } from "node:child_process";
import { GhError } from "./errors.ts";
import { compact } from "./json.ts";
import type { Evaluator } from "./types.ts";

export const executeJq: Evaluator = (expression, input, context) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      "/usr/bin/jq",
      ["-c", "-r", expression],
      { cwd: context.cwd, env: context.env, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        const detail = stderr.trimEnd();
        reject(new GhError(`failed to evaluate jq expression${detail ? `\n${detail}` : ""}`));
      },
    );
    if (!child.stdin) {
      reject(new GhError("failed to start jq input stream"));
      return;
    }
    child.stdin.end(compact(input));
  });
